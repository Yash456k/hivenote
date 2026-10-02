import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { clientParams, isMethod, MUTATIONS, HiveNoteError, type Actor, type Attribution, type Event, type Method, type Note, type Params, type Store } from './contract.js';
import { openDatabase, storageError, transaction } from './database.js';
import { due, id, integer, invalid, json, LIMITS, metadata, params as checkParams, status, STATUSES, text } from './validate.js';
import { JSON_COLUMNS, NOTE_COLUMNS, toEvent, toNote, view, type Row } from './views.js';

export type { BriefNote } from './views.js';

/** The parameters each method accepts; anything else is rejected. */
const PARAMETERS: Record<Method, readonly string[]> = {
  list: ['offset', 'limit', 'kind', 'status', 'detail'],
  read: ['ids', 'names'],
  search: ['query', 'offset', 'limit', 'detail'],
  create: ['id', 'name', 'description', 'content', 'kind', 'metadata', 'status', 'due_at', 'op_id'],
  edit: ['id', 'note', 'old_str', 'new_str', 'op_id'],
  replace: ['id', 'note', 'content', 'name', 'description', 'metadata', 'op_id'],
  append: ['id', 'note', 'body', 'op_id'],
  delete: ['id', 'note', 'op_id'],
  history: ['id', 'note', 'offset', 'limit'],
  revision: ['id', 'note', 'rev'],
  restore: ['id', 'note', 'rev', 'op_id'],
  changes: ['since', 'limit', 'tail'],
  claim: ['id', 'note', 'ttl_seconds', 'force', 'op_id'],
  release: ['id', 'note', 'force', 'op_id'],
  update_task: ['id', 'note', 'status', 'due_at', 'metadata', 'op_id'],
};


interface Receipt { note: Note; event_seq: number; op_id: string }

/**
 * Plain words are searched as words, so names like api-decisions and hosts like
 * stg.example.com just work. Quotes, parentheses, * or AND/OR/NOT/NEAR switch to
 * full-text query syntax.
 */
function searchQuery(query: string): string {
  if (/["()*^:]|\b(AND|OR|NOT|NEAR)\b/u.test(query)) return query;
  const words = query.split(/\s+/u).filter(Boolean);
  return words.length ? words.map(word => `"${word}"`).join(' ') : query;
}

/** One answer stays under 5 MB, however big the notes and their history get. */
const ANSWER_BYTES = 5 * 1024 * 1024;
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** The leading items that fit in one answer; always at least one, so callers keep moving. */
function fitting<T>(items: T[]): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    used += size(item);
    if (kept.length && used > ANSWER_BYTES) break;
    kept.push(item);
  }
  return kept;
}

export function localActor(): Actor {
  return { principal: 'local', device: 'local', scope: 'rw', verified: false };
}

/** The hive itself: one SQLite file, and every read and write against it. */
export class SqliteStore implements Store {
  private db: DatabaseSync;
  readonly path: string;

  constructor(path: string, private actor: Actor = localActor()) {
    // Callers with direct file access may label themselves, but are never token-verified.
    this.actor = { ...actor, verified: false };
    this.path = resolve(path);
    this.db = openDatabase(this.path);
  }

  close(): void { this.db.close(); }

  private get(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values) as Row | undefined; }
  private all(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }

  async call(method: Method, params: Params = {}): Promise<unknown> {
    return this.execute(method, clientParams(method, params), this.actor);
  }

  /** Validate, authorize, then run one method. Writes are idempotent by op_id. */
  execute(method: Method, params: Params = {}, actor: Actor = this.actor): unknown {
    if (!isMethod(method)) invalid('Unknown method');
    checkParams(params, PARAMETERS[method], method);
    const write = MUTATIONS.has(method);
    if (write && actor.scope !== 'rw') throw new HiveNoteError('forbidden', 'Actor is read-only', 403);
    if (!write) return transaction(this.db, () => { this.authorize(actor, false); return this.query(method, params); }, false);

    const opId = text(params.op_id, 'op_id', 128);
    const request = JSON.stringify(json({ method, params }));
    return transaction(this.db, () => {
      // A token may be revoked while we wait for the write lock: check again inside it.
      const current = this.authorize(actor, true);
      const receipt = this.get('SELECT * FROM receipts WHERE op_id=?', opId);
      if (receipt) {
        // A retry of the same request gets the original answer; anything else reusing the op_id is refused.
        if (receipt.principal !== current.principal || receipt.request !== request) {
          throw new HiveNoteError('op_id_conflict', 'op_id already used for a different principal or request', 409);
        }
        return JSON.parse(receipt.response as string) as unknown;
      }
      const result = this.mutate(method, params, attribution(current));
      this.run('INSERT INTO receipts(op_id,principal,request,response) VALUES(?,?,?,?)', opId, current.principal, request, JSON.stringify(result));
      return result;
    });
  }

  private authorize(actor: Actor, write: boolean): Actor {
    if (!actor.verified) return actor;
    const row = this.get('SELECT principal,device,scope FROM clients WHERE principal=? AND revoked=0', actor.principal);
    if (!row) throw new HiveNoteError('unauthorized', 'Invalid or revoked token', 401);
    if (write && row.scope !== 'rw') throw new HiveNoteError('forbidden', 'Token is read-only', 403);
    return { ...actor, principal: row.principal as string, device: row.device as string, scope: row.scope as 'ro' | 'rw' };
  }

  // ---------- Writes ----------

  private mutate(method: Method, p: Params, who: Attribution): Receipt {
    const now = new Date().toISOString();
    if (method === 'create') {
      const note = createNote(p, who, now);
      this.save(note, true);
      return this.record(note, 'create', p, who, now);
    }

    let note = this.find(p, method === 'restore');

    let eventKind = method as string;
    switch (method) {
      case 'append': text(p.body, 'body', LIMITS.content); break;
      case 'edit': this.applyEdit(note, p); break;
      case 'replace': applyReplace(note, p); break;
      case 'delete': note.deleted_at = now; note.claimed_by = null; note.claim_expires_at = null; break;
      case 'restore': note = this.restored(note, p.rev); break;
      case 'claim': eventKind = this.applyClaim(note, p, who, now); break;
      case 'release': eventKind = this.applyRelease(note, p, who); break;
      case 'update_task': applyTaskUpdate(note, p); break;
      default: invalid('Unsupported mutation');
    }

    note.activity_at = now;
    note.last_activity_attribution = who;
    if (method === 'append') {
      // Progress notes are activity, not a new revision of the content.
      this.run('UPDATE notes SET activity_at=?,last_activity_attribution=? WHERE id=?', now, JSON.stringify(who), note.id);
    } else {
      note.rev++;
      note.updated_at = now;
      note.last_attribution = who;
      this.save(note);
    }
    return this.record(note, eventKind, p, who, now);
  }

  /** Replace exactly one occurrence of old_str. */
  private applyEdit(note: Note, p: Params): void {
    const old = text(p.old_str, 'old_str', LIMITS.content, true);
    if (!old.length) invalid('old_str must not be empty');
    const replacement = text(p.new_str, 'new_str', LIMITS.content, true);
    // A revision should mean something changed.
    if (replacement === old) invalid('new_str is identical to old_str; nothing would change');
    const first = note.content.indexOf(old);
    if (first < 0 || note.content.indexOf(old, first + 1) >= 0) this.conflict(note, 'old_str must match exactly once in current content');
    note.content = text(note.content.slice(0, first) + replacement + note.content.slice(first + old.length), 'content', LIMITS.content, true);
  }

  /** Bring back an old revision as a new one. Never revives a stale claim. */
  private restored(note: Note, rev: unknown): Note {
    const old = this.historical(note, rev);
    return { ...old, rev: note.rev, created_at: note.created_at, deleted_at: null, claimed_by: null, claim_expires_at: null };
  }

  private applyClaim(note: Note, p: Params, who: Attribution, now: string): string {
    if (note.kind !== 'task') invalid('Only tasks may be claimed');
    if (p.force !== undefined && typeof p.force !== 'boolean') invalid('force must be boolean');
    const ttl = p.ttl_seconds === undefined ? 900 : integer(p.ttl_seconds, 'ttl_seconds', 1, 86400);
    const heldByOther = note.claimed_by !== null && note.claim_expires_at !== null && note.claim_expires_at > now;
    if (heldByOther && p.force !== true) this.conflict(note, 'Task already claimed; force must be explicit');
    note.claimed_by = who.principal;
    note.claim_expires_at = new Date(Date.parse(now) + ttl * 1000).toISOString();
    return p.force ? 'claim_force' : 'claim';
  }

  private applyRelease(note: Note, p: Params, who: Attribution): string {
    if (note.kind !== 'task') invalid('Only tasks may be released');
    if (p.force !== undefined && typeof p.force !== 'boolean') invalid('force must be boolean');
    if (note.claimed_by !== null && note.claimed_by !== who.principal && p.force !== true) {
      this.conflict(note, 'Claim belongs to another principal; force must be explicit');
    }
    note.claimed_by = null;
    note.claim_expires_at = null;
    return p.force ? 'release_force' : 'release';
  }

  /** Append the event for this change and return the receipt. */
  private record(note: Note, kind: string, p: Params, who: Attribution, now: string): Receipt {
    const append = kind === 'append';
    const result = this.run(
      'INSERT INTO events(note_id,kind,revision,snapshot,body,op_id,attribution,timestamp) VALUES(?,?,?,?,?,?,?,?)',
      note.id, kind, append ? null : note.rev, append ? null : JSON.stringify(note), append ? p.body as string : null,
      p.op_id as string, JSON.stringify(who), now,
    );
    return { note, event_seq: Number(result.lastInsertRowid), op_id: p.op_id as string };
  }

  private save(note: Note, create = false): void {
    const values = NOTE_COLUMNS.map(column => JSON_COLUMNS.includes(column) ? JSON.stringify(note[column]) : note[column]) as SQLInputValue[];
    if (create) {
      this.run(`INSERT INTO notes(${NOTE_COLUMNS.join(',')}) VALUES(${NOTE_COLUMNS.map(() => '?').join(',')})`, ...values);
    } else {
      this.run(`UPDATE notes SET ${NOTE_COLUMNS.slice(1).map(column => `${column}=?`).join(',')} WHERE id=?`, ...values.slice(1), note.id);
    }
    // The search index holds live notes only.
    this.run('DELETE FROM notes_fts WHERE id=?', note.id);
    if (!note.deleted_at) this.run('INSERT INTO notes_fts(id,name,description,content) VALUES(?,?,?,?)', note.id, note.name, note.description, note.content);
  }

  /**
   * The note a method acts on, by name (`note`) or, for the dashboard and older clients, by ID.
   * With includeDeleted, a name with no live note finds the most recently deleted one.
   */
  private find(p: Params, includeDeleted = false): Note {
    if ((p.id === undefined) === (p.note === undefined)) invalid('Say which note with its name');
    if (p.note !== undefined) {
      const name = text(p.note, 'note', LIMITS.name);
      const row = this.get('SELECT * FROM notes WHERE name=? AND deleted_at IS NULL', name)
        ?? (includeDeleted ? this.get('SELECT * FROM notes WHERE name=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC LIMIT 1', name) : undefined);
      if (!row) throw new HiveNoteError('not_found', `No note named '${name}'`, 404);
      return toNote(row);
    }
    const row = this.get(`SELECT * FROM notes WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`, id(p.id));
    if (!row) throw new HiveNoteError('not_found', 'Note not found', 404);
    return toNote(row);
  }

  private historical(note: Note, rev: unknown): Note {
    const row = this.get('SELECT snapshot FROM events WHERE note_id=? AND revision=?', note.id, integer(rev, 'rev', 1));
    if (!row) throw new HiveNoteError('not_found', 'Revision not found', 404);
    return JSON.parse(row.snapshot as string) as Note;
  }

  private conflict(note: Note, message: string): never {
    throw new HiveNoteError('conflict', message, 409, { current: note });
  }

  // ---------- Reads ----------

  private query(method: Method, p: Params): unknown {
    switch (method) {
      case 'list': return this.list(p);
      case 'read': return this.read(p);
      case 'search': return this.search(p);
      case 'history': return this.history(p);
      case 'revision': return { note: this.historical(this.find(p, true), p.rev) };
      case 'changes': return this.changes(p);
      default: return invalid('Unsupported query');
    }
  }

  private page(p: Params): { limit: number; offset: number } {
    return {
      limit: p.limit === undefined ? 50 : integer(p.limit, 'limit', 1, 100),
      offset: p.offset === undefined ? 0 : integer(p.offset, 'offset', 0),
    };
  }

  private list(p: Params): unknown {
    const { limit, offset } = this.page(p);
    const shape = view(p.detail);
    const where = ['deleted_at IS NULL'];
    const args: SQLInputValue[] = [];
    if (p.kind !== undefined) {
      if (p.kind !== 'note' && p.kind !== 'task') invalid('Invalid kind');
      where.push('kind=?');
      args.push(p.kind);
    }
    if (p.status !== undefined) {
      if (!STATUSES.includes(p.status as typeof STATUSES[number])) invalid('Invalid status');
      where.push('status=?');
      args.push(p.status as string);
    }
    const clause = where.join(' AND ');
    const total = Number(this.get(`SELECT count(*) AS n FROM notes WHERE ${clause}`, ...args)?.n);
    const notes = this.all(`SELECT * FROM notes WHERE ${clause} ORDER BY name,id LIMIT ? OFFSET ?`, ...args, limit, offset).map(row => shape(toNote(row)));
    return { notes, total, offset, has_more: offset + notes.length < total };
  }

  /** Full notes by IDs or by names, plus each note's latest 20 progress entries. */
  private read(p: Params): unknown {
    if ((p.ids === undefined) === (p.names === undefined)) invalid('read requires exactly one of ids or names');
    const byId = p.ids !== undefined;
    const selectors = p.ids ?? p.names;
    if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 100) invalid('read selectors must contain 1 to 100 strings');
    const keys = [...new Set(selectors.map(value => byId ? id(value) : text(value, 'name', LIMITS.name)))];

    const notes: Note[] = [];
    const missing: string[] = [];
    const too_big: string[] = [];
    const updates: Event[] = [];
    let updates_has_more = false;
    let used = 0;
    for (const key of keys) {
      const row = this.get(`SELECT * FROM notes WHERE ${byId ? 'id' : 'name'}=? AND deleted_at IS NULL`, key);
      if (!row) { missing.push(key); continue; }
      const note = toNote(row);
      // Past the size limit, the rest are named so the caller can read them in another call.
      if (notes.length && used + size(note) > ANSWER_BYTES) { too_big.push(key); continue; }
      used += size(note);
      notes.push(note);
      const appends = this.all("SELECT * FROM events WHERE note_id=? AND kind='append' ORDER BY seq DESC LIMIT 21", note.id);
      if (appends.length > 20) updates_has_more = true;
      const recent: Event[] = [];
      for (const event of appends.slice(0, 20).map(toEvent)) {
        if (used + size(event) > ANSWER_BYTES) { updates_has_more = true; break; }
        used += size(event);
        recent.push(event);
      }
      updates.push(...recent.reverse());
    }
    updates.sort((a, b) => a.seq - b.seq);
    return { notes, missing, updates, updates_has_more, ...(too_big.length ? { too_big } : {}) };
  }

  private search(p: Params): unknown {
    const { limit, offset } = this.page(p);
    const query = searchQuery(text(p.query, 'query', 1024));
    const shape = view(p.detail);
    try {
      const total = Number(this.get('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?', query)?.n);
      const notes = this.all(
        "SELECT n.*, snippet(notes_fts,3,'[',']','…',24) AS snippet FROM notes_fts JOIN notes n ON n.id=notes_fts.id WHERE notes_fts MATCH ? ORDER BY rank,n.id LIMIT ? OFFSET ?",
        query, limit, offset,
      ).map(row => ({ ...shape(toNote(row)), snippet: row.snippet }));
      return { notes, total, offset, has_more: offset + notes.length < total };
    } catch (error) {
      if (error instanceof HiveNoteError) throw error;
      return invalid('Invalid search; check that quotes and parentheses are balanced');
    }
  }

  private history(p: Params): unknown {
    const note = this.find(p, true);
    const { limit, offset } = this.page(p);
    const total = Number(this.get('SELECT count(*) AS n FROM events WHERE note_id=?', note.id)?.n);
    const events = fitting(this.all('SELECT * FROM events WHERE note_id=? ORDER BY seq LIMIT ? OFFSET ?', note.id, limit, offset).map(toEvent));
    return { events, total, offset, has_more: offset + events.length < total };
  }

  /** The global feed of changes after a cursor, or the newest `tail` events. */
  private changes(p: Params): unknown {
    if (p.tail !== undefined) {
      if (p.since !== undefined || p.limit !== undefined) invalid('changes accepts tail, or since/limit, not both');
      const newest = fitting(this.all('SELECT * FROM events ORDER BY seq DESC LIMIT ?', integer(p.tail, 'tail', 1, 100)).map(toEvent));
      // The cursor points at the head, so polling continues from now.
      const head = Number(this.get('SELECT coalesce(max(seq),0) AS seq FROM events')?.seq);
      return { events: newest.reverse(), cursor: head, has_more: false };
    }
    const since = p.since === undefined ? 0 : integer(p.since, 'since', 0);
    const { limit } = this.page(p);
    const rows = this.all('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?', since, limit + 1);
    const events = fitting(rows.slice(0, limit).map(toEvent));
    return { events, cursor: events.at(-1)?.seq ?? since, has_more: rows.length > events.length };
  }

  // ---------- Administration (local only) ----------

  private requireLocalWriter(message: string): void {
    if (this.actor.scope !== 'rw') throw new HiveNoteError('forbidden', message, 403);
  }

  tokenCreate(device: string, scope: 'ro' | 'rw' = 'rw'): { id: string; principal: string; device: string; scope: 'ro' | 'rw'; token: string } {
    this.requireLocalWriter('Read-only actor cannot administer tokens');
    text(device, 'device', LIMITS.label);
    if (scope !== 'ro' && scope !== 'rw') invalid('scope must be ro or rw');
    const token = randomBytes(32).toString('base64url');
    const client = { id: randomUUID(), principal: randomUUID() };
    // Only the hash is stored; the token is shown once.
    transaction(this.db, () => this.run(
      'INSERT INTO clients(id,principal,device,token_hash,scope,created_at) VALUES(?,?,?,?,?,?)',
      client.id, client.principal, device, sha256(token), scope, new Date().toISOString(),
    ));
    return { ...client, device, scope, token };
  }

  tokenList(): Row[] {
    this.requireLocalWriter('Token administration is local read/write only');
    return this.all('SELECT id,principal,device,scope,revoked,created_at,revoked_at FROM clients ORDER BY created_at,id');
  }

  /** Revoke every active token for a device label, such as laptop. Returns how many. */
  tokenRevoke(device: string): number {
    this.requireLocalWriter('Read-only actor cannot administer tokens');
    text(device, 'device', LIMITS.label);
    return transaction(this.db, () => {
      const result = this.run('UPDATE clients SET revoked=1,revoked_at=? WHERE device=? AND revoked=0', new Date().toISOString(), device);
      if (!result.changes) throw new HiveNoteError('not_found', `No active token for device '${device}' (see hivenote token list)`, 404);
      return Number(result.changes);
    });
  }

  authenticate(token: string): Actor {
    if (typeof token !== 'string' || token.length < 40 || token.length > 256) throw new HiveNoteError('unauthorized', 'Invalid or revoked token', 401);
    const row = this.get('SELECT principal,device,scope FROM clients WHERE token_hash=? AND revoked=0', sha256(token));
    if (!row) throw new HiveNoteError('unauthorized', 'Invalid or revoked token', 401);
    return { principal: row.principal as string, device: row.device as string, scope: row.scope as 'ro' | 'rw', verified: true };
  }

  /** A consistent, integrity-checked copy of the database at a new path. */
  backup(destination: string): { path: string } {
    this.requireLocalWriter('Backup requires local read/write access');
    const path = resolve(text(destination, 'destination', 4096));
    if (existsSync(path)) throw new HiveNoteError('conflict', 'Backup destination already exists; choose a new path', 409);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Reserve the name with a private mode before VACUUM INTO fills it.
    closeSync(openSync(path, 'wx', 0o600));
    try {
      this.run('VACUUM INTO ?', path);
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      const copy = new DatabaseSync(path, { readOnly: true });
      try {
        if (copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new HiveNoteError('backup_error', 'Backup integrity check failed', 500);
      } finally { copy.close(); }
    } catch (error) {
      unlinkSync(path);
      storageError(error);
    }
    return { path };
  }
}

// ---------- Pure helpers ----------

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function attribution(actor: Actor): Attribution {
  const result: Attribution = {
    principal: text(actor.principal, 'principal', LIMITS.label),
    device: text(actor.device, 'device', LIMITS.label),
    verified: actor.verified,
    labels_verified: false,
  };
  if (actor.agent !== undefined) result.agent = text(actor.agent, 'agent', LIMITS.label);
  if (actor.session !== undefined) result.session = text(actor.session, 'session', LIMITS.label);
  return result;
}

function createNote(p: Params, who: Attribution, now: string): Note {
  const kind = p.kind === undefined ? 'note' : p.kind;
  if (kind !== 'note' && kind !== 'task') invalid('kind must be note or task');
  if (kind !== 'task' && (p.status !== undefined || p.due_at !== undefined)) invalid('status and due_at require kind task');
  const taskStatus = kind === 'task' ? status(p.status ?? 'todo') : null;
  return {
    id: id(p.id),
    name: text(p.name, 'name', LIMITS.name),
    description: text(p.description, 'description', LIMITS.description, true),
    content: text(p.content, 'content', LIMITS.content, true),
    kind,
    rev: 1,
    status: taskStatus,
    due_at: p.due_at === undefined ? null : due(p.due_at),
    claimed_by: null,
    claim_expires_at: null,
    metadata: p.metadata === undefined ? {} : metadata(p.metadata),
    created_at: now,
    updated_at: now,
    activity_at: now,
    deleted_at: null,
    last_attribution: who,
    last_activity_attribution: who,
  };
}

function applyReplace(note: Note, p: Params): void {
  if (!['name', 'description', 'content', 'metadata'].some(key => p[key] !== undefined)) invalid('replace requires at least one changed field');
  const before = JSON.stringify([note.name, note.description, note.content, note.metadata]);
  if (p.name !== undefined) note.name = text(p.name, 'name', LIMITS.name);
  if (p.description !== undefined) note.description = text(p.description, 'description', LIMITS.description, true);
  if (p.content !== undefined) note.content = text(p.content, 'content', LIMITS.content, true);
  if (p.metadata !== undefined) note.metadata = metadata(p.metadata);
  if (JSON.stringify([note.name, note.description, note.content, note.metadata]) === before) invalid('replace would not change anything');
}

function applyTaskUpdate(note: Note, p: Params): void {
  if (note.kind !== 'task') invalid('Only tasks have status or due dates');
  if (!['status', 'due_at', 'metadata'].some(key => p[key] !== undefined)) invalid('update_task requires at least one field');
  if (p.status !== undefined) note.status = status(p.status);
  if (p.due_at !== undefined) note.due_at = due(p.due_at);
  if (p.metadata !== undefined) note.metadata = metadata(p.metadata);
}
