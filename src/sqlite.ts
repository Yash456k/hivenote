import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { age, byline, clientParams, isMethod, MUTATIONS, HiveNoteError, type Actor, type Attribution, type Event, type Method, type Note, type Params, type Previous, type Store } from './contract.js';
import { openDatabase, storageError, transaction } from './database.js';
import { held, HOLD_LIMIT_MS } from './wait.js';
import { due, id, integer, invalid, json, LIMITS, metadata, params as checkParams, status, STATUSES, text } from './validate.js';
import { AFTER_KEY, AFTER_PATH, afterIds, withAfter, JSON_COLUMNS, NOTE_COLUMNS, toEvent, toNote, view, type Row } from './views.js';

export type { BriefNote } from './views.js';

/** The parameters each method accepts; anything else is rejected. */
const PARAMETERS: Record<Method, readonly string[]> = {
  list: ['offset', 'limit', 'kind', 'status', 'ready', 'folder', 'detail'],
  read: ['ids', 'names'],
  search: ['query', 'offset', 'limit', 'detail'],
  create: ['id', 'name', 'description', 'content', 'kind', 'metadata', 'status', 'due_at', 'after', 'op_id'],
  edit: ['id', 'note', 'old_str', 'new_str', 'op_id'],
  replace: ['id', 'note', 'content', 'name', 'description', 'metadata', 'op_id'],
  append: ['id', 'note', 'body', 'op_id'],
  delete: ['id', 'note', 'op_id'],
  history: ['id', 'note', 'offset', 'limit'],
  revision: ['id', 'note', 'rev'],
  restore: ['id', 'note', 'rev', 'op_id'],
  changes: ['since', 'limit', 'tail', 'hold'],
  update_task: ['id', 'note', 'status', 'due_at', 'metadata', 'claim', 'after', 'not_after', 'op_id'],
  take: ['op_id'],
};

/**
 * A task (as `n`) that waits on a live task that is not done. A deleted task is no longer waited on,
 * and restoring it brings the wait back, since the id stays in the waiting task's metadata.
 */
const BLOCKED = `(coalesce(json_type(n.metadata,${AFTER_PATH}),'')='array' AND EXISTS (SELECT 1 FROM json_each(n.metadata,${AFTER_PATH}) a JOIN notes p ON p.id=a.value AND p.deleted_at IS NULL WHERE p.status NOT IN ('done','cancelled')))`;

/** When a task was added: its latest create, so one added under a deleted task's name is not put at the old one's place. */
const ADDED = `(SELECT max(seq) FROM events e WHERE e.note_id=n.id AND e.kind='create')`;

/** How long a doing task can go idle before another agent may take it over: off unless the hive's config.json sets takeover. */
export const TAKEOVER_MS = 0;


interface Receipt {
  note: Note; event_seq: number; op_id: string; previous?: Previous;
  /** The tasks this task waits on, by name, after a write that named them. */
  after?: string[];
  /** A doing task taken from an agent that had gone quiet: who had it, and when anything last happened on it. */
  taken_over?: { from: string; at: string };
  /** After a task is cancelled: the open tasks that waited on it, which now go ahead without it. */
  waiting?: string[];
}

/**
 * How many answers to writes are kept for a retry to be given again. A retry comes within seconds,
 * and each answer holds the whole note: kept forever, they were two thirds of a hive's file.
 */
const RECEIPTS_KEPT = 2000;

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
  /** 0 means a doing task is never taken over. */
  private readonly takeoverMs: number;

  constructor(path: string, private actor: Actor = localActor(), options: { takeoverMs?: number } = {}) {
    // Callers with direct file access may label themselves, but are never token-verified.
    this.actor = { ...actor, verified: false };
    this.path = resolve(path);
    this.takeoverMs = options.takeoverMs ?? TAKEOVER_MS;
    this.db = openDatabase(this.path);
  }

  close(): void { this.db.close(); }

  private get(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values) as Row | undefined; }
  private all(sql: string, ...values: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }

  async call(method: Method, params: Params = {}): Promise<unknown> {
    const prepared = clientParams(method, params);
    // A hive on this machine has no server to hold the question open, so the asker holds it.
    if (method === 'changes' && typeof prepared.hold === 'number') return held(() => this.execute(method, prepared, this.actor) as { events: unknown[] }, prepared.hold);
    return this.execute(method, prepared, this.actor);
  }

  /** Validate, authorize, then run one method. A write is made once per op_id, however often it is sent. */
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
      // A retry that comes after its answer was dropped: the write is in the history, and is not made twice.
      if (this.get('SELECT 1 FROM events WHERE op_id=?', opId)) {
        throw new HiveNoteError('op_id_conflict', 'This write was saved earlier, and the answer it was given is no longer kept. Read the note to see it', 409);
      }
      const result = this.mutate(method, params, attribution(current));
      const kept = this.run('INSERT INTO receipts(op_id,principal,request,response) VALUES(?,?,?,?)', opId, current.principal, request, JSON.stringify(result));
      // Older answers go a hundred at a time, so the first write to a hive that kept them all is not a long one.
      this.run('DELETE FROM receipts WHERE rowid IN (SELECT rowid FROM receipts WHERE rowid<=? ORDER BY rowid LIMIT 100)', Number(kept.lastInsertRowid) - RECEIPTS_KEPT);
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
      // A name keeps one history: adding under a deleted note's name continues that note,
      // so its old versions stay reachable with history and restore.
      const live = this.get('SELECT * FROM notes WHERE name=? AND deleted_at IS NULL', note.name);
      if (live) {
        const there = toNote(live);
        const what = there.kind === 'task' ? `task (${there.status ?? 'todo'})` : 'note';
        throw new HiveNoteError('conflict', `'${there.name}' already exists: a ${what} last changed by ${byline(there.last_attribution)}. Read it and add to it, or choose another name`, 409);
      }
      const gone = live ? undefined : this.get('SELECT * FROM notes WHERE name=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC LIMIT 1', note.name);
      if (gone) {
        const before = toNote(gone);
        Object.assign(note, { id: before.id, rev: before.rev + 1, created_at: before.created_at });
        // A new note under a deleted one's name is a new thing: tasks that waited on the deleted one don't wait on it.
        this.forgetWaitsOn(before.id);
      }
      if (p.after !== undefined) {
        if (note.kind !== 'task') invalid('Only a task can wait on other tasks');
        this.setAfter(note, p.after, undefined);
      }
      this.save(note, !gone);
      const receipt = this.record(note, 'create', p, who, now);
      if (p.after !== undefined) receipt.after = this.afterNames(note);
      return receipt;
    }

    let note = method === 'take' ? this.next(now) : this.find(p, method === 'restore');

    let eventKind = method === 'take' ? 'update_task' : method as string;
    let previous: Previous | undefined;
    let takenOver: Receipt['taken_over'];
    switch (method) {
      case 'append': text(p.body, 'body', LIMITS.content); break;
      case 'edit': this.applyEdit(note, p); break;
      case 'replace': applyReplace(note, p); break;
      case 'delete': note.deleted_at = now; note.claimed_by = null; note.claim_expires_at = null; break;
      case 'restore': note = this.restored(note, p.rev); break;
      case 'take':
      case 'update_task': {
        // take is a claim of the task the hive picked; it is recorded as the mark it is.
        const task: Params = method === 'take' ? { status: 'doing', claim: true } : p;
        // Marking never locks, so the answer says whose state was replaced; the caller can then think again.
        if (task.status !== undefined) previous = { status: note.status, ...this.statusSetter(note) };
        if (task.claim !== undefined) {
          if (task.claim !== true || task.status !== 'doing') invalid('claim is true, and goes with status doing');
          // Taking a task is the one mark that must not go by an old look at the board: checked here, inside the
          // write, two agents asking at the same moment cannot both be told the task is theirs.
          const held = note.status === 'doing' || note.status === 'done' || note.status === 'cancelled';
          if (held && previous!.by !== byline(who)) {
            // An agent that stopped leaves its task doing; once nothing has happened on it for long enough, it is free.
            if (note.status === 'doing' && this.takeoverMs > 0 && Date.parse(now) - Date.parse(note.activity_at) >= this.takeoverMs) {
              takenOver = { from: previous!.by, at: note.activity_at };
            } else {
              const state = note.status === 'doing' ? 'is taken' : `is already ${note.status}`;
              const later = note.status === 'doing' && this.takeoverMs > 0 ? `. It can be taken over once nothing has happened on it for ${age(new Date(0).toISOString(), this.takeoverMs)}` : '';
              throw new HiveNoteError('taken', `'${note.name}' ${state}: ${previous!.by} marked it ${note.status} ${age(previous!.at, now)} ago. Nothing was changed${later}`, 409, previous);
            }
          }
        }
        applyTaskUpdate(note, task);
        if (task.after !== undefined || task.not_after !== undefined) this.setAfter(note, task.after, task.not_after);
        break;
      }
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
    const receipt = this.record(note, eventKind, p, who, now);
    if (previous) receipt.previous = previous;
    if (takenOver) receipt.taken_over = takenOver;
    // Cancelling a task no longer holds up the tasks that wait on it; whoever cancelled it is told which, to look at them.
    if (method === 'update_task' && p.status === 'cancelled') {
      const waiting = this.all(`SELECT name FROM notes n WHERE deleted_at IS NULL AND kind='task' AND status IN ('todo','doing') AND coalesce(json_type(metadata,${AFTER_PATH}),'')='array' AND EXISTS (SELECT 1 FROM json_each(metadata,${AFTER_PATH}) a WHERE a.value=?) ORDER BY name`, note.id).map(row => row.name as string);
      if (waiting.length) receipt.waiting = waiting;
    }
    if (p.after !== undefined || p.not_after !== undefined) receipt.after = this.afterNames(note);
    if (method === 'append') this.index(note);
    return receipt;
  }

  /**
   * Make a task wait on the tasks named in `add`, and stop waiting on those in `remove`. They are kept by id,
   * so renaming one keeps the link, and a task cannot end up waiting on itself through others.
   */
  private setAfter(task: Note, add: unknown, remove: unknown): void {
    let after = afterIds(task);
    if (remove !== undefined) {
      for (const name of names(remove, 'not_after')) {
        const row = this.get('SELECT id FROM notes WHERE name=? AND deleted_at IS NULL', name);
        if (!row || !after.includes(row.id as string)) invalid(`'${task.name}' does not wait on '${name}'`);
        after = after.filter(id => id !== row.id);
      }
    }
    if (add !== undefined) {
      for (const name of names(add, 'after')) {
        const row = this.get('SELECT * FROM notes WHERE name=? AND deleted_at IS NULL', name);
        if (!row) throw new HiveNoteError('not_found', `No task named '${name}' to wait on`, 404);
        const other = toNote(row);
        if (other.kind !== 'task') invalid(`'${name}' is a note, not a task; a task waits only on tasks`);
        if (other.id === task.id) invalid(`'${task.name}' cannot wait on itself`);
        if (this.waitsOnThrough(other.id, task.id)) invalid(`'${task.name}' cannot wait on '${name}', which already waits on '${task.name}'`);
        if (!after.includes(other.id)) after.push(other.id);
      }
    }
    task.metadata = metadata(withAfter(task.metadata, after));
  }

  /** Tasks that waited on this id no longer do. Not a new revision of them: the link pointed at something gone. */
  private forgetWaitsOn(id: string): void {
    const rows = this.all(`SELECT id,metadata FROM notes n WHERE coalesce(json_type(metadata,${AFTER_PATH}),'')='array' AND EXISTS (SELECT 1 FROM json_each(metadata,${AFTER_PATH}) a WHERE a.value=?)`, id);
    for (const row of rows) {
      const meta = JSON.parse(row.metadata as string) as Record<string, unknown>;
      this.run('UPDATE notes SET metadata=? WHERE id=?', JSON.stringify(withAfter(meta, afterIds({ metadata: meta }).filter(other => other !== id))), row.id as string);
    }
  }

  /** Whether the task `from` waits on `target`, directly or through the tasks it waits on. */
  private waitsOnThrough(from: string, target: string): boolean {
    const seen = new Set<string>();
    const next = [from];
    while (next.length) {
      const id = next.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.get('SELECT metadata FROM notes WHERE id=?', id);
      if (row) next.push(...afterIds({ metadata: JSON.parse(row.metadata as string) as Record<string, unknown> }));
    }
    return false;
  }

  /** The live tasks a task waits on, by name. */
  private afterNames(task: Note): string[] {
    return afterIds(task).flatMap(id => {
      const row = this.get('SELECT name FROM notes WHERE id=? AND deleted_at IS NULL', id);
      return row ? [row.name as string] : [];
    });
  }

  /** For each task given that still waits on others, the names of those that are not done. */
  private waitsOn(notes: Note[]): Map<string, string[]> {
    const waiting = new Map<string, string[]>();
    const ids = [...new Set(notes.filter(note => note.kind === 'task').flatMap(afterIds))];
    if (!ids.length) return waiting;
    // One query for every task they wait on, however many tasks are on the page.
    const open = new Map(this.all(`SELECT id,name FROM notes WHERE deleted_at IS NULL AND status NOT IN ('done','cancelled') AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map(row => [row.id as string, row.name as string]));
    for (const note of notes) {
      if (note.kind !== 'task') continue;
      const names = afterIds(note).flatMap(id => (open.has(id) ? [open.get(id)!] : []));
      if (names.length) waiting.set(note.id, names);
    }
    return waiting;
  }

  /**
   * The task take hands out: the oldest todo task whose prerequisites are all done, or else the doing task that has
   * been idle longest past the takeover time. Picked inside the write, so agents asking at once each get another.
   */
  private next(now: string): Note {
    const ready = this.get(`SELECT * FROM notes n WHERE deleted_at IS NULL AND kind='task' AND status='todo' AND NOT ${BLOCKED} ORDER BY ${ADDED},rowid LIMIT 1`);
    if (ready) return toNote(ready);
    if (this.takeoverMs > 0) {
      const idle = this.get(`SELECT * FROM notes n WHERE deleted_at IS NULL AND kind='task' AND status='doing' AND activity_at<=? AND NOT ${BLOCKED} ORDER BY activity_at,rowid LIMIT 1`, new Date(Date.parse(now) - this.takeoverMs).toISOString());
      if (idle) return toNote(idle);
    }
    const count = (where: string): number => Number(this.get(`SELECT count(*) AS n FROM notes n WHERE deleted_at IS NULL AND kind='task' AND ${where}`)?.n);
    const waiting = count(`status='todo' AND ${BLOCKED}`), doing = count("status='doing'");
    const tasks = (n: number): string => `${n} task${n === 1 ? '' : 's'}`;
    const board = waiting || doing
      ? `${[waiting && `${tasks(waiting)} ${waiting === 1 ? 'waits' : 'wait'} on others to be done`, doing && `${tasks(doing)} ${doing === 1 ? 'is' : 'are'} being done`].filter(Boolean).join(', and ')}. hivenote wait wakes when something changes`
      : 'No task is waiting to be done';
    throw new HiveNoteError('nothing_ready', `Nothing is ready to take. ${board}`, 404);
  }

  /** Replace exactly one occurrence of old_str. */
  private applyEdit(note: Note, p: Params): void {
    const old = text(p.old_str, 'old_str', LIMITS.content, true);
    if (!old.length) invalid('old_str must not be empty');
    const replacement = text(p.new_str, 'new_str', LIMITS.content, true);
    // A revision should mean something changed.
    if (replacement === old) invalid('new_str is identical to old_str; nothing would change');
    const first = note.content.indexOf(old);
    if (first < 0) this.conflict(note, 'The old text is not in the note as it stands now. Here is the note; redo the edit against it');
    if (note.content.indexOf(old, first + 1) >= 0) this.conflict(note, 'The old text is in the note more than once. Give more of the text around it, so it matches one place');
    note.content = text(note.content.slice(0, first) + replacement + note.content.slice(first + old.length), 'content', LIMITS.content, true);
  }

  /** Bring back an old revision as a new one. Never revives a stale claim. */
  private restored(note: Note, rev: unknown): Note {
    const old = this.historical(note, rev);
    // What a task waits on changes only through after and not_after, which check for loops; a restore keeps it as it is now.
    return { ...old, metadata: withAfter(old.metadata ?? {}, afterIds(note)), rev: note.rev, created_at: note.created_at, deleted_at: null, claimed_by: null, claim_expires_at: null };
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
    this.index(note);
  }

  /** The search index holds live notes only: their text, and their latest progress lines after it. */
  private index(note: Note): void {
    this.run('DELETE FROM notes_fts WHERE id=?', note.id);
    if (note.deleted_at) return;
    const progress = this.all("SELECT body FROM events WHERE note_id=? AND kind='append' ORDER BY seq DESC LIMIT 100", note.id).map(row => row.body as string).reverse();
    this.run('INSERT INTO notes_fts(id,name,description,content) VALUES(?,?,?,?)', note.id, note.name, note.description, [note.content, ...progress].join('\n'));
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

  /**
   * Who gave a task the status it has now, and when. Not whoever changed it last: an edit to the
   * text in between must not hide that another agent marked it doing.
   */
  private statusSetter(note: Note): { by: string; at: string } {
    const named = (version: Row) => ({ by: byline(JSON.parse(version.attribution as string) as Attribution), at: version.timestamp as string });
    const facts = "json_extract(snapshot,'$.due_at') AS due_at, json_extract(snapshot,'$.metadata') AS metadata";
    // The versions that have carried this status without a break start after the last one that said something else.
    const other = this.get("SELECT MAX(seq) AS seq FROM events WHERE note_id=? AND kind<>'append' AND json_extract(snapshot,'$.status') IS NOT ?", note.id, note.status);
    const since = Number(other?.seq ?? 0);
    const first = this.get("SELECT seq, attribution, timestamp FROM events WHERE note_id=? AND kind<>'append' AND seq>? ORDER BY seq LIMIT 1", note.id, since);
    if (!first) return { by: byline(note.last_attribution), at: note.updated_at };
    // The latest mark among them counts, even one that repeated the status: that agent is on the task too.
    // An update that only moved the due date or the metadata is not a mark, and leaves the task with whoever had it.
    const updates = this.all(`SELECT seq, attribution, timestamp, ${facts} FROM events WHERE note_id=? AND kind='update_task' AND seq>? ORDER BY seq DESC LIMIT 50`, note.id, Number(first.seq));
    for (const update of updates) {
      const before = this.get(`SELECT ${facts} FROM events WHERE note_id=? AND kind<>'append' AND seq<? ORDER BY seq DESC LIMIT 1`, note.id, Number(update.seq));
      if (before && before.due_at === update.due_at && before.metadata === update.metadata) return named(update);
    }
    // Never marked again since: whoever's version first carried it (the mark that set it, or the task as it was added).
    return named(first);
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

  /** Notes with the latest activity first (a progress line counts), so what is being worked on leads. */
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
    // Ready tasks come oldest first, the order take hands them out in.
    if (p.ready !== undefined) {
      if (p.ready !== true) invalid('ready is true, or left out');
      where.push("kind='task'", "status='todo'", `NOT ${BLOCKED}`);
    }
    // A folder is the part of a name before its last /; listing one shows everything under it.
    if (p.folder !== undefined) {
      where.push('instr(name,?)=1');
      args.push(text(p.folder, 'folder', LIMITS.name).replace(/\/+$/u, '') + '/');
    }
    const clause = where.join(' AND ');
    const total = Number(this.get(`SELECT count(*) AS n FROM notes n WHERE ${clause}`, ...args)?.n);
    const found = this.all(`SELECT * FROM notes n WHERE ${clause} ORDER BY ${p.ready ? `${ADDED},rowid` : 'name,id'} LIMIT ? OFFSET ?`, ...args, limit, offset).map(toNote);
    const waiting = this.waitsOn(found);
    const notes = found.map(note => {
      const entry = shape(note);
      const open = waiting.get(note.id);
      return open ? { ...entry, waits_on: open } : entry;
    });
    return { notes, total, offset, has_more: offset + notes.length < total, seq: this.seq() };
  }

  /** The number of the hive's latest change. An agent hands it back to ask what happened after. */
  private seq(): number {
    return Number(this.get('SELECT max(seq) AS n FROM events')?.n ?? 0);
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
    const waiting = this.waitsOn(notes);
    const waits_on = Object.fromEntries(notes.filter(note => waiting.has(note.id)).map(note => [note.name, waiting.get(note.id)!]));
    return { notes, missing, updates, updates_has_more, ...(too_big.length ? { too_big } : {}), ...(waiting.size ? { waits_on } : {}), seq: this.seq() };
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
      if (p.since !== undefined || p.limit !== undefined || p.hold !== undefined) invalid('changes accepts tail, or since/limit/hold, not both');
      const newest = fitting(this.all('SELECT * FROM events ORDER BY seq DESC LIMIT ?', integer(p.tail, 'tail', 1, 100)).map(toEvent));
      // The cursor points at the head, so polling continues from now.
      const head = Number(this.get('SELECT coalesce(max(seq),0) AS seq FROM events')?.seq);
      return { events: newest.reverse(), cursor: head, has_more: false };
    }
    const since = p.since === undefined ? 0 : integer(p.since, 'since', 0);
    // Holding is done by whoever asks on the caller's behalf (the server, or call() above); here it is only checked.
    if (p.hold !== undefined) integer(p.hold, 'hold', 0, HOLD_LIMIT_MS);
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
    metadata: p.metadata === undefined ? {} : withAfter(metadata(p.metadata), []),
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
  if (p.metadata !== undefined) note.metadata = keepAfter(note, p.metadata);
  if (JSON.stringify([note.name, note.description, note.content, note.metadata]) === before) invalid('replace would not change anything');
}

/** A list of task names, each once. */
function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) invalid(`${label} must list 1 to 100 task names`);
  return [...new Set(value.map(name => text(name, label, LIMITS.name)))];
}

function applyTaskUpdate(note: Note, p: Params): void {
  if (note.kind !== 'task') invalid('Only tasks have status or due dates');
  if (!['status', 'due_at', 'metadata', 'after', 'not_after'].some(key => p[key] !== undefined)) invalid('update_task requires at least one field');
  if (p.status !== undefined) note.status = status(p.status);
  if (p.due_at !== undefined) note.due_at = due(p.due_at);
  if (p.metadata !== undefined) note.metadata = keepAfter(note, p.metadata);
}

/**
 * New metadata for a note, keeping the tasks it waits on: those change only through after and not_after,
 * so a write that sets other metadata can't drop them, or make a loop the after check would refuse.
 */
function keepAfter(note: Note, value: unknown): Record<string, unknown> {
  return metadata(withAfter(metadata(value), afterIds(note)));
}
