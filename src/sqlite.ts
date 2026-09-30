import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { clientParams, isMethod, MUTATIONS, HiveNoteError, type Actor, type Attribution, type Event, type Method, type Note, type Params, type Store } from './contract.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATUSES = ['todo','doing','done','cancelled'];
const FIELDS: Record<Method, string[]> = {
  list: ['offset','limit','kind','status','detail'], read: ['ids','names'], search: ['query','offset','limit','detail'],
  create: ['id','name','description','content','kind','metadata','status','due_at','op_id'],
  edit: ['id','old_str','new_str','base_rev','op_id'], replace: ['id','content','name','description','metadata','base_rev','op_id'],
  append: ['id','body','op_id'], delete: ['id','base_rev','op_id'], history: ['id','offset','limit'],
  revision: ['id','rev'], restore: ['id','rev','base_rev','op_id'], changes: ['since','limit','tail'],
  claim: ['id','ttl_seconds','force','base_rev','op_id'], release: ['id','force','base_rev','op_id'],
  update_task: ['id','status','due_at','metadata','base_rev','op_id'],
};
export function localActor(): Actor { return { principal: 'local', device: 'local', scope: 'rw', verified: false }; }
function invalid(message: string): never { throw new HiveNoteError('validation_error', message); }
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value, 'utf8') > max || value.includes('\0')) invalid(`${label} must be ${empty ? 'a' : 'a nonempty'} well-formed UTF-8 string of at most ${max} bytes, without NUL`);
  return value;
}
function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function id(value: unknown): string { const s = text(value, 'id', 36); if (!UUID.test(s)) invalid('id must be a UUID'); return s; }
function json(value: unknown, depth = 0): unknown {
  if (depth > 20) invalid('JSON nesting exceeds 20 levels');
  if (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value)) invalid('JSON strings must contain well-formed Unicode');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => json(v, depth + 1));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object|null)) {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      if (/[\uD800-\uDFFF]/u.test(key)) invalid('JSON keys must contain well-formed Unicode');
      result[key] = json((value as Row)[key], depth + 1);
    }
    return result;
  }
  return invalid('Values must be JSON (no undefined, functions, cycles, or nonfinite numbers)');
}
function metadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('metadata must be a JSON object');
  const result = json(value) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) invalid('metadata exceeds 32768 bytes');
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}
function due(value: unknown): string|null {
  if (value === null) return null;
  const s = text(value, 'due_at', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(s) || !Number.isFinite(Date.parse(s))) invalid('due_at must be a UTC ISO timestamp (or null)');
  const normalized = new Date(s).toISOString();
  // Do not silently accept overflow dates such as February 30.
  if (normalized.slice(0, 19) !== s.slice(0, 19)) invalid('due_at contains an invalid calendar date');
  return normalized;
}
function attribution(actor: Actor): Attribution {
  const out: Attribution = { principal: text(actor.principal, 'principal', 256), device: text(actor.device, 'device', 256), verified: actor.verified, labels_verified: false };
  if (actor.agent !== undefined) out.agent = text(actor.agent, 'agent', 256);
  if (actor.session !== undefined) out.session = text(actor.session, 'session', 256);
  return out;
}
function safeSqlError(e: unknown): never {
  if (e instanceof HiveNoteError) throw e;
  const message = e instanceof Error ? e.message : '';
  if (/UNIQUE constraint failed/iu.test(message)) throw new HiveNoteError('conflict', 'ID or live name already exists', 409);
  if (/locked|busy/iu.test(message)) throw new HiveNoteError('busy', 'Database busy; retry with the same op_id', 503);
  throw new HiveNoteError('storage_error', 'Database operation failed', 500);
}
function busy<T>(fn: () => T): T {
  const end = Date.now() + 5000;
  for (;;) { try { return fn(); } catch (e) {
    if (!(e instanceof Error) || !/locked|busy/iu.test(e.message) || Date.now() >= end) throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  } }
}
const columns = ['id','name','description','content','kind','rev','status','due_at','claimed_by','claim_expires_at','metadata','created_at','updated_at','activity_at','deleted_at','last_attribution','last_activity_attribution'] as const;
function toNote(row: Row): Note {
  return { ...row, metadata: JSON.parse(row.metadata as string), last_attribution: JSON.parse(row.last_attribution as string), last_activity_attribution: JSON.parse(row.last_activity_attribution as string) } as unknown as Note;
}
function toEvent(row: Row): Event {
  return { ...row, snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot as string), attribution: JSON.parse(row.attribution as string) } as unknown as Event;
}
function summary(note: Note): Omit<Note,'content'> { const { content: _content, ...rest } = note; return rest; }

/** What an agent needs to decide whether to read a note: identity, what it is for, and task state. */
export interface BriefNote {
  id: string; name: string; description: string; kind: Note['kind']; updated_at: string;
  status?: NonNullable<Note['status']>; due_at?: string; claimed_by?: string;
}
function brief(note: Note): BriefNote {
  const entry: BriefNote = { id: note.id, name: note.name, description: note.description, kind: note.kind, updated_at: note.updated_at };
  if (note.status !== null) entry.status = note.status;
  if (note.due_at !== null) entry.due_at = note.due_at;
  if (note.claimed_by !== null) entry.claimed_by = note.claimed_by;
  return entry;
}
/** list and search return brief entries unless the caller asks for full summaries. */
function view(detail: unknown): (note: Note) => BriefNote | Omit<Note,'content'> {
  if (detail === undefined || detail === 'brief') return brief;
  if (detail === 'full') return summary;
  return invalid("detail must be 'brief' or 'full'");
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  readonly path: string;
  constructor(path: string, private actor: Actor = localActor()) {
    // Direct filesystem clients may label themselves, but are not token-verified.
    this.actor = { ...actor, verified: false };
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Create with restrictive mode before SQLite opens it; independent creators may race.
    try { const fd = openSync(this.path, 'wx', 0o600); closeSync(fd); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!statSync(this.path).isFile()) invalid('Database path must be a regular local file');
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      busy(() => this.db.exec('PRAGMA journal_mode=WAL;'));
      this.transaction(() => {
        const version = Number(this.get('PRAGMA user_version')?.user_version);
        if (version > 1) throw new HiveNoteError('schema_version', 'Database schema is newer than this program', 500);
        if (version === 0) {
          this.db.exec(`
            CREATE TABLE notes (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('note','task')), rev INTEGER NOT NULL CHECK(rev>0),
              status TEXT, due_at TEXT, claimed_by TEXT, claim_expires_at TEXT,
              metadata TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              activity_at TEXT NOT NULL, deleted_at TEXT, last_attribution TEXT NOT NULL, last_activity_attribution TEXT NOT NULL
            );
            CREATE UNIQUE INDEX live_name ON notes(name) WHERE deleted_at IS NULL;
            CREATE INDEX live_discovery ON notes(deleted_at,kind,status,name,id);
            CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED,name,description,content,tokenize='unicode61');
            CREATE TABLE events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL REFERENCES notes(id), kind TEXT NOT NULL,
              revision INTEGER, snapshot TEXT, body TEXT, op_id TEXT NOT NULL UNIQUE,
              attribution TEXT NOT NULL, timestamp TEXT NOT NULL
            );
            CREATE INDEX event_history ON events(note_id,seq);
            CREATE UNIQUE INDEX event_revisions ON events(note_id,revision) WHERE revision IS NOT NULL;
            CREATE TABLE receipts (op_id TEXT PRIMARY KEY, principal TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);
            CREATE TABLE clients (
              id TEXT PRIMARY KEY, principal TEXT NOT NULL UNIQUE, device TEXT NOT NULL,
              token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL CHECK(scope IN ('ro','rw')),
              revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, revoked_at TEXT
            );
            PRAGMA user_version=1;
          `);
        }
      });
    } catch (e) { this.db.close(); safeSqlError(e); }
  }
  private get(sql: string, ...values: SQLInputValue[]): Row|undefined { return this.db.prepare(sql).get(...values) as Row|undefined; }
  private all(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  private transaction<T>(fn: () => T, write = true): T {
    let active = false;
    try { busy(() => this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')); active = true; const result = fn(); this.db.exec('COMMIT'); active = false; return result; }
    catch (e) { if (active) this.db.exec('ROLLBACK'); return safeSqlError(e); }
  }
  close(): void { this.db.close(); }
  async call(method: Method, params: Params = {}): Promise<unknown> { return this.execute(method, clientParams(method, params), this.actor); }
  execute(method: Method, params: Params = {}, actor: Actor = this.actor): unknown {
    if (!isMethod(method)) invalid('Unknown method');
    if (!params || typeof params !== 'object' || Array.isArray(params) || ![Object.prototype, null].includes(Object.getPrototypeOf(params) as object|null)) invalid('params must be a JSON object');
    if (Object.keys(params).some(k => !FIELDS[method].includes(k))) invalid(`Unknown parameter for ${method}`);
    if (actor.scope !== 'rw' && MUTATIONS.has(method)) throw new HiveNoteError('forbidden', 'Actor is read-only', 403);
    if (MUTATIONS.has(method)) {
      const op = text(params.op_id, 'op_id', 128);
      const request = JSON.stringify(json({ method, params }));
      return this.transaction(() => {
        // A different connection may revoke access while BEGIN IMMEDIATE waits.
        // Recheck inside the lock, before receipt replay or any state change.
        actor = this.authorize(actor, true);
        const receipt = this.get('SELECT * FROM receipts WHERE op_id=?', op);
        if (receipt) {
          if (receipt.principal !== actor.principal || receipt.request !== request) throw new HiveNoteError('op_id_conflict', 'op_id already used for a different principal or request', 409);
          return JSON.parse(receipt.response as string) as unknown;
        }
        const result = this.mutate(method, params, attribution(actor));
        this.run('INSERT INTO receipts(op_id,principal,request,response) VALUES(?,?,?,?)', op, actor.principal, request, JSON.stringify(result));
        return result;
      });
    }
    return this.transaction(() => { this.authorize(actor, false); return this.query(method, params); }, false);
  }
  private authorize(actor: Actor, write: boolean): Actor {
    if (!actor.verified) return actor;
    const row = this.get('SELECT principal,device,scope FROM clients WHERE principal=? AND revoked=0', actor.principal);
    if (!row) throw new HiveNoteError('unauthorized', 'Invalid or revoked token', 401);
    if (write && row.scope !== 'rw') throw new HiveNoteError('forbidden', 'Token is read-only', 403);
    return { ...actor, principal: row.principal as string, device: row.device as string, scope: row.scope as 'ro'|'rw' };
  }
  private find(noteId: unknown, deleted = false): Note {
    const key = id(noteId);
    const row = this.get(`SELECT * FROM notes WHERE id=?${deleted ? '' : ' AND deleted_at IS NULL'}`, key);
    if (!row) throw new HiveNoteError('not_found', 'Note not found', 404);
    return toNote(row);
  }
  private conflict(note: Note, message: string): never { throw new HiveNoteError('conflict', message, 409, { current: note }); }
  private base(note: Note, params: Params, optional = false): void {
    if (optional && params.base_rev === undefined) return;
    if (integer(params.base_rev, 'base_rev', 1) !== note.rev) this.conflict(note, 'Revision mismatch; read current note before retrying');
  }
  private save(note: Note, create = false): void {
    const values = columns.map(c => ['metadata','last_attribution','last_activity_attribution'].includes(c) ? JSON.stringify(note[c]) : note[c]) as SQLInputValue[];
    if (create) this.run(`INSERT INTO notes(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...values);
    else this.run(`UPDATE notes SET ${columns.slice(1).map(c => `${c}=?`).join(',')} WHERE id=?`, ...values.slice(1), note.id);
    this.run('DELETE FROM notes_fts WHERE id=?', note.id);
    if (!note.deleted_at) this.run('INSERT INTO notes_fts(id,name,description,content) VALUES(?,?,?,?)', note.id, note.name, note.description, note.content);
  }
  private historical(note: Note, rev: unknown): Note {
    const row = this.get('SELECT snapshot FROM events WHERE note_id=? AND revision=?', note.id, integer(rev, 'rev', 1));
    if (!row) throw new HiveNoteError('not_found', 'Revision not found', 404);
    return JSON.parse(row.snapshot as string) as Note;
  }
  private mutate(method: Method, p: Params, who: Attribution): {note: Note; event_seq: number; op_id: string} {
    const now = new Date().toISOString();
    let note: Note;
    let eventKind: string = method;
    if (method === 'create') {
      const kind = p.kind === undefined ? 'note' : p.kind;
      if (kind !== 'note' && kind !== 'task') invalid('kind must be note or task');
      if (kind !== 'task' && (p.status !== undefined || p.due_at !== undefined)) invalid('status and due_at require kind task');
      const status = kind === 'task' ? (p.status ?? 'todo') : null;
      if (status !== null && !STATUSES.includes(status as string)) invalid('Invalid task status');
      note = {
        id: id(p.id), name: text(p.name,'name',256), description: text(p.description,'description',4096,true),
        content: text(p.content,'content',524288,true), kind, rev: 1, status: status as Note['status'], due_at: p.due_at === undefined ? null : due(p.due_at),
        claimed_by: null, claim_expires_at: null, metadata: p.metadata === undefined ? {} : metadata(p.metadata),
        created_at: now, updated_at: now, activity_at: now, deleted_at: null, last_attribution: who, last_activity_attribution: who,
      };
      this.save(note, true);
    } else {
      note = this.find(p.id, method === 'restore');
      if (['replace','delete','restore','update_task'].includes(method)) this.base(note, p);
      if (['edit','claim','release'].includes(method)) this.base(note, p, true);
      switch (method) {
        case 'append': text(p.body,'body',524288); break;
        case 'edit': {
          const old = text(p.old_str,'old_str',524288,true);
          if (!old.length) invalid('old_str must not be empty');
          const replacement = text(p.new_str,'new_str',524288,true);
          // A revision should mean something changed; reject edits that change nothing.
          if (replacement === old) invalid('new_str is identical to old_str; nothing would change');
          const first = note.content.indexOf(old);
          if (first < 0 || note.content.indexOf(old, first + 1) >= 0) this.conflict(note, 'old_str must match exactly once in current content');
          note.content = text(note.content.slice(0, first) + replacement + note.content.slice(first + old.length),'content',524288,true);
          break;
        }
        case 'replace': {
          if (!['name','description','content','metadata'].some(k => p[k] !== undefined)) invalid('replace requires at least one changed field');
          const before = JSON.stringify([note.name, note.description, note.content, note.metadata]);
          if (p.name !== undefined) note.name = text(p.name,'name',256);
          if (p.description !== undefined) note.description = text(p.description,'description',4096,true);
          if (p.content !== undefined) note.content = text(p.content,'content',524288,true);
          if (p.metadata !== undefined) note.metadata = metadata(p.metadata);
          if (JSON.stringify([note.name, note.description, note.content, note.metadata]) === before) invalid('replace would not change anything');
          break;
        }
        case 'delete': note.deleted_at = now; note.claimed_by = null; note.claim_expires_at = null; break;
        case 'restore': {
          const old = this.historical(note, p.rev);
          // Restoration revives historical content, but never revives a stale lease.
          note = { ...old, rev: note.rev, created_at: note.created_at, deleted_at: null, claimed_by: null, claim_expires_at: null };
          break;
        }
        case 'claim': {
          if (note.kind !== 'task') invalid('Only tasks may be claimed');
          if (p.force !== undefined && typeof p.force !== 'boolean') invalid('force must be boolean');
          const ttl = p.ttl_seconds === undefined ? 900 : integer(p.ttl_seconds,'ttl_seconds',1,86400);
          if (note.claimed_by !== null && note.claim_expires_at !== null && note.claim_expires_at > now && p.force !== true) this.conflict(note, 'Task already claimed; force must be explicit');
          note.claimed_by = who.principal; note.claim_expires_at = new Date(Date.parse(now) + ttl*1000).toISOString();
          if (p.force) eventKind = 'claim_force';
          break;
        }
        case 'release': {
          if (note.kind !== 'task') invalid('Only tasks may be released');
          if (p.force !== undefined && typeof p.force !== 'boolean') invalid('force must be boolean');
          if (note.claimed_by !== null && note.claimed_by !== who.principal && p.force !== true) this.conflict(note, 'Claim belongs to another principal; force must be explicit');
          note.claimed_by = null; note.claim_expires_at = null;
          if (p.force) eventKind = 'release_force';
          break;
        }
        case 'update_task': {
          if (note.kind !== 'task') invalid('Only tasks have status or due dates');
          if (!['status','due_at','metadata'].some(k => p[k] !== undefined)) invalid('update_task requires at least one field');
          if (p.status !== undefined) { if (!STATUSES.includes(p.status as string)) invalid('Invalid task status'); note.status = p.status as Note['status']; }
          if (p.due_at !== undefined) note.due_at = due(p.due_at);
          if (p.metadata !== undefined) note.metadata = metadata(p.metadata);
          break;
        }
        default: invalid('Unsupported mutation');
      }
      if (method !== 'append') { note.rev++; note.updated_at = now; note.last_attribution = who; }
      note.activity_at = now; note.last_activity_attribution = who;
      if (method === 'append') this.run('UPDATE notes SET activity_at=?,last_activity_attribution=? WHERE id=?',now,JSON.stringify(who),note.id);
      else this.save(note);
    }
    const result = this.run('INSERT INTO events(note_id,kind,revision,snapshot,body,op_id,attribution,timestamp) VALUES(?,?,?,?,?,?,?,?)',
      note.id,eventKind,method === 'append' ? null : note.rev,method === 'append' ? null : JSON.stringify(note),method === 'append' ? p.body as string : null,p.op_id as string,JSON.stringify(who),now);
    return { note, event_seq: Number(result.lastInsertRowid), op_id: p.op_id as string };
  }
  private page(p: Params): {limit: number; offset: number} {
    return {limit: p.limit === undefined ? 50 : integer(p.limit,'limit',1,100), offset: p.offset === undefined ? 0 : integer(p.offset,'offset',0)};
  }
  private query(method: Method, p: Params): unknown {
    switch (method) {
      case 'list': {
        const {limit,offset} = this.page(p); const shape = view(p.detail);
        const where = ['deleted_at IS NULL']; const args: SQLInputValue[] = [];
        if (p.kind !== undefined) { if (p.kind !== 'note' && p.kind !== 'task') invalid('Invalid kind'); where.push('kind=?'); args.push(p.kind); }
        if (p.status !== undefined) { if (!STATUSES.includes(p.status as string)) invalid('Invalid status'); where.push('status=?'); args.push(p.status as string); }
        const clause = where.join(' AND ');
        const total = Number(this.get(`SELECT count(*) AS n FROM notes WHERE ${clause}`, ...args)?.n);
        const notes = this.all(`SELECT * FROM notes WHERE ${clause} ORDER BY name,id LIMIT ? OFFSET ?`, ...args,limit,offset).map(r => shape(toNote(r)));
        return { notes,total,offset,has_more: offset + notes.length < total };
      }
      case 'read': {
        if ((p.ids === undefined) === (p.names === undefined)) invalid('read requires exactly one of ids or names');
        const selectors = p.ids ?? p.names;
        if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 100) invalid('read selectors must contain 1 to 100 strings');
        const keys = [...new Set(selectors.map(v => p.ids !== undefined ? id(v) : text(v,'name',256)))];
        const notes: Note[] = [], missing: string[] = [], updates: Event[] = [];
        let updates_has_more = false;
        for (const key of keys) {
          const row = this.get(`SELECT * FROM notes WHERE ${p.ids === undefined ? 'name' : 'id'}=? AND deleted_at IS NULL`, key);
          if (!row) { missing.push(key); continue; }
          const note = toNote(row); notes.push(note);
          const rows = this.all("SELECT * FROM events WHERE note_id=? AND kind='append' ORDER BY seq DESC LIMIT 21", note.id);
          if (rows.length > 20) updates_has_more = true;
          updates.push(...rows.slice(0,20).reverse().map(toEvent));
        }
        updates.sort((a,b) => a.seq-b.seq);
        return { notes,missing,updates,updates_has_more };
      }
      case 'search': {
        const {limit,offset} = this.page(p); const q = text(p.query,'query',1024); const shape = view(p.detail);
        try {
          const total = Number(this.get('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?', q)?.n);
          const notes = this.all("SELECT n.*, snippet(notes_fts,3,'[',']','…',24) AS snippet FROM notes_fts JOIN notes n ON n.id=notes_fts.id WHERE notes_fts MATCH ? ORDER BY rank,n.id LIMIT ? OFFSET ?", q,limit,offset).map(row => ({...shape(toNote(row)),snippet:row.snippet}));
          return {notes,total,offset,has_more: offset+notes.length < total};
        } catch (e) { if (e instanceof HiveNoteError) throw e; invalid('Invalid FTS5 query; use words, quoted phrases, or AND/OR/NOT (balanced quotes/parentheses)'); }
      }
      case 'history': {
        const note = this.find(p.id,true); const {limit,offset} = this.page(p);
        const total = Number(this.get('SELECT count(*) AS n FROM events WHERE note_id=?', note.id)?.n);
        const events = this.all('SELECT * FROM events WHERE note_id=? ORDER BY seq LIMIT ? OFFSET ?',note.id,limit,offset).map(toEvent);
        return {events,total,offset,has_more:offset+events.length < total};
      }
      case 'revision': return { note: this.historical(this.find(p.id,true),p.rev) };
      case 'changes': {
        if (p.tail !== undefined) {
          // The newest events, oldest first, with the cursor at the head so polling continues from now.
          if (p.since !== undefined || p.limit !== undefined) invalid('changes accepts tail, or since/limit, not both');
          const rows = this.all('SELECT * FROM events ORDER BY seq DESC LIMIT ?', integer(p.tail,'tail',1,100)).reverse();
          const head = Number(this.get('SELECT coalesce(max(seq),0) AS seq FROM events')?.seq);
          return { events: rows.map(toEvent), cursor: head, has_more: false };
        }
        const since = p.since === undefined ? 0 : integer(p.since,'since',0);
        const {limit} = this.page(p);
        const rows = this.all('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?',since,limit+1);
        const events = rows.slice(0,limit).map(toEvent);
        return {events,cursor:events.at(-1)?.seq ?? since,has_more:rows.length > limit};
      }
      default: invalid('Unsupported query');
    }
  }
  tokenCreate(device: string, scope: 'ro'|'rw' = 'rw'): {id:string; principal:string; device:string; scope:'ro'|'rw'; token:string} {
    if (this.actor.scope !== 'rw') throw new HiveNoteError('forbidden','Read-only actor cannot administer tokens',403);
    text(device,'device',256); if (scope !== 'ro' && scope !== 'rw') invalid('scope must be ro or rw');
    const token = randomBytes(32).toString('base64url'); const key = randomUUID(); const principal = randomUUID();
    this.transaction(() => this.run('INSERT INTO clients(id,principal,device,token_hash,scope,created_at) VALUES(?,?,?,?,?,?)',key,principal,device,createHash('sha256').update(token).digest('hex'),scope,new Date().toISOString()));
    return {id:key,principal,device,scope,token};
  }
  tokenList(): Row[] {
    if (this.actor.scope !== 'rw') throw new HiveNoteError('forbidden','Token administration is local read/write only',403);
    return this.all('SELECT id,principal,device,scope,revoked,created_at,revoked_at FROM clients ORDER BY created_at,id');
  }
  tokenRevoke(key: string): void {
    if (this.actor.scope !== 'rw') throw new HiveNoteError('forbidden','Read-only actor cannot administer tokens',403);
    id(key);
    this.transaction(() => { const result = this.run('UPDATE clients SET revoked=1,revoked_at=coalesce(revoked_at,?) WHERE id=?',new Date().toISOString(),key); if (!result.changes) throw new HiveNoteError('not_found','Client not found',404); });
  }
  authenticate(token: string): Actor {
    if (typeof token !== 'string' || token.length < 40 || token.length > 256) throw new HiveNoteError('unauthorized','Invalid or revoked token',401);
    const row = this.get('SELECT principal,device,scope FROM clients WHERE token_hash=? AND revoked=0',createHash('sha256').update(token).digest('hex'));
    if (!row) throw new HiveNoteError('unauthorized','Invalid or revoked token',401);
    return {principal:row.principal as string,device:row.device as string,scope:row.scope as 'ro'|'rw',verified:true};
  }
  backup(destination: string): {path: string} {
    if (this.actor.scope !== 'rw') throw new HiveNoteError('forbidden','Backup requires local read/write access',403);
    const path = resolve(text(destination,'destination',4096));
    if (existsSync(path)) throw new HiveNoteError('conflict','Backup destination already exists; choose a new path',409);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    // Reserve filename atomically and keep mode 0600 while VACUUM INTO fills empty file.
    const fd = openSync(path,'wx',0o600); closeSync(fd);
    try {
      this.run('VACUUM INTO ?',path);
      if (process.platform !== 'win32') chmodSync(path,0o600);
      const check = new DatabaseSync(path,{readOnly:true});
      try { const row = check.prepare('PRAGMA integrity_check').get(); if (row?.integrity_check !== 'ok') throw new HiveNoteError('backup_error','Backup integrity check failed',500); }
      finally { check.close(); }
    } catch(e) { unlinkSync(path); safeSqlError(e); }
    return {path};
  }
}
