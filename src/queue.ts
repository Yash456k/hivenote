import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { age, clientParams, HiveNoteError, MUTATIONS, type Attribution, type Event, type Method, type Note, type Params, type Store } from './contract.js';
import { configDirectory } from './config.js';
import { reachQueen, writes } from './merge.js';
import { markDown, SeenCache } from './seen.js';
import { queenTooOld, validateServerUrl } from './client.js';
import { LIMITS, metadata as checkMetadata, status as checkStatus, text } from './validate.js';
import { afterIds, brief, type BriefNote } from './views.js';

/**
 * A worker that keeps working while the queen can't be reached.
 *
 * Reads answer from what this machine last saw of her hive (seen.ts), and say so.
 * Writes that can't change anything someone else wrote are kept, to send later:
 *  - new notes and tasks (add, task);
 *  - progress lines (append), on any note this machine has seen: they only add;
 *  - any change to a note made here while she was away, which nobody else has yet.
 * Every other change to one of her notes (edit, replace, mark, delete, ...) is refused while she is
 * away, so nothing is ever replayed over what others did meanwhile. Taking a task needs her answer.
 *
 * Kept writes wait in a file until `hivenote merge` sends them, oldest first, each by the note's id
 * and with the op_id it was made with, so nothing is made twice or lands on another note. What she
 * does not take becomes a conflict: `hivenote conflicts` shows it, `hivenote resolve` settles it.
 */

/**
 * queen: the address of the queen it was kept for; only a merge into her sends it.
 * sent: a new note that may already have reached her (it went out and no answer came back, or a merge sent it). It
 * is changed here no more, since a change could not reach the note she may have; progress lines still go by its id.
 */
interface Entry { method: 'create' | 'append'; params: Params; name: string; queen?: string; agent?: string; session?: string; at: string; sent?: true; unreadable?: string }
type Labels = { agent?: string; session?: string };

/** What merge could not send, waiting to be settled here. */
export interface Conflict {
  /** note or task: a whole note made here. progress: lines for a note she no longer has. */
  kind: 'note' | 'task' | 'progress';
  name: string;
  /** The id the note was kept under, so progress kept for it later joins this conflict. */
  id?: string;
  /** The queen it was kept for: it is settled only with her. */
  queen?: string;
  /** For a note made here, what it was made with. */
  params?: Params;
  /** Progress lines that went with it. */
  progress: string[];
  agent?: string; session?: string;
  why: string; code: string;
  /** A line of the conflicts file that could not be read, kept as it was. */
  raw?: string;
}

/** What a command gets back for a write that was kept. */
export interface Queued { queued: { note: string; dropped?: true } }
export function isQueued(value: unknown): value is Queued {
  return typeof value === 'object' && value !== null && 'queued' in value && typeof (value as Queued).queued?.note === 'string';
}

export function queuePath(): string { return join(configDirectory(), 'queue.jsonl'); }
export function conflictsPath(): string { return join(configDirectory(), 'conflicts.jsonl'); }

/** The writes kept on this machine. */
export function kept(path = queuePath()): number { return entries(path).length; }
/** The conflicts waiting to be settled here. */
export function conflictCount(path = conflictsPath()): number { return conflictLines(path).length; }

/** The one line every command adds while writes are kept or conflicts wait. */
export function reminder(count: number, conflicts = 0): string {
  const parts: string[] = [];
  if (count) parts.push(`${writes(count)} kept while the queen was away; run hivenote merge to send ${count === 1 ? 'it' : 'them'}`);
  if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'} from a merge; hivenote conflicts shows ${conflicts === 1 ? 'it' : 'them'}`);
  return parts.join('. ');
}

/** The conflicts file. A line that can't be read (cut short by a crash) is shown and kept as it is, until dropped. */
function conflictLines(path = conflictsPath()): Conflict[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line): Conflict[] => {
    if (!line) return [];
    try { return [JSON.parse(line) as Conflict]; } catch {
      return [{ kind: 'progress', name: '(unreadable)', progress: [line], why: 'This line in the conflicts file could not be read, probably cut short by a crash. Its text is kept as it was', code: 'unreadable', raw: line }];
    }
  });
}

/** Kept entries. A line that can't be read (a crash part way through writing it) is kept as it is, and becomes a conflict at merge. */
function entries(path: string): Entry[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => {
    if (!line) return [];
    try { return [JSON.parse(line) as Entry]; } catch { return [{ method: 'append', params: {}, name: '(unreadable)', at: '', unreadable: line } as Entry]; }
  });
}

/** A queen's address as kept: its origin, so http://host:7391/ and http://host:7391 are one queen. */
export function queenOf(address: string): string {
  try { return validateServerUrl(address).origin; } catch { return address; }
}

function save(path: string, left: Entry[]): void {
  if (!left.length) { rmSync(path, { force: true }); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, left.map(entry => (entry.unreadable ?? JSON.stringify(entry)) + '\n').join(''), { mode: 0o600 });
  renameSync(temporary, path);
}

const READS = new Set<Method>(['list', 'read', 'search']);
/** The writes that change a note named by the caller, and so must find the note made here before any of hers. */
const CHANGES = new Set<Method>(['edit', 'replace', 'append', 'delete', 'update_task']);
const HERE = 'this machine';

/** A note made here that may already be on the queen: changing what is kept could no longer reach that note. */
function stillSending(name: string): HiveNoteError {
  return new HiveNoteError('conflict', `'${name}' was added on this machine, and it may already have reached the queen: a merge or an add sent it and no answer came back. Nothing was changed. Run hivenote merge when she can be reached, then change it`, 409);
}

function who(entry: { agent?: string }): Attribution {
  return { principal: HERE, device: HERE, verified: false, labels_verified: false, ...(entry.agent ? { agent: entry.agent } : {}) };
}

/** A note made here, as the hive would hold it, so reads and changes on this machine can find it. */
function madeHere(entry: Entry, appends: Entry[]): Note & { waits_on_names?: string[] } {
  const p = entry.params;
  const last = appends.at(-1)?.at ?? entry.at;
  return {
    id: String(p.id), name: String(p.name), description: String(p.description ?? ''), content: String(p.content ?? ''),
    kind: p.kind === 'task' ? 'task' : 'note', rev: 1, status: p.kind === 'task' ? (p.status as Note['status']) ?? 'todo' : null,
    due_at: (p.due_at as string | undefined) ?? null, claimed_by: null, claim_expires_at: null, metadata: (p.metadata as Record<string, unknown> | undefined) ?? {},
    created_at: entry.at, updated_at: entry.at, activity_at: last, deleted_at: null, last_attribution: who(entry), last_activity_attribution: who(appends.at(-1) ?? entry),
    ...(Array.isArray(p.after) && p.after.length ? { waits_on_names: (p.after as unknown[]).map(String) } : {}),
  };
}

function keptEvent(entry: Entry, seq: number): Event {
  return { seq, note_id: String(entry.params.id), kind: 'append', revision: null, snapshot: null, body: String(entry.params.body), op_id: String(entry.params.op_id), attribution: who(entry), timestamp: entry.at };
}

/** Whether a note in an answer is one made on this machine and not merged yet. */
export function isMadeHere(note: { last_attribution?: { principal?: string } } | undefined): boolean {
  return note?.last_attribution?.principal === HERE;
}

export class QueueStore implements Store {
  /** Set once the queen could not be reached, so this command's next writes don't wait on her again. */
  private offline = false;
  /** Whether this command found the queen unreachable. */
  get gaveUp(): boolean { return this.offline; }
  private unreachable: HiveNoteError | undefined;
  private reached = false;
  /** The ids of a whole listing, page by page, so notes she no longer has can be let go once it is complete. */
  private listing: Set<string> | undefined;
  private readonly seen: SeenCache;
  /** The queen this command talks to; writes are kept for her alone. */
  private readonly queen: string;

  /**
   * @param inner    the queen, with this command's labels
   * @param labels   this command's labels, kept with each write
   * @param queen    her address: what was seen belongs to her
   * @param fallback whether reads answer from what was last seen when she can't be reached (not for wait, which waits for her)
   */
  constructor(
    private readonly inner: Store,
    private readonly labels: Labels,
    queen: string,
    private readonly fallback = true,
    private readonly path = queuePath(),
  ) {
    this.queen = queenOf(queen);
    this.seen = new SeenCache(this.queen);
  }

  /** The kept entries for this queen. Writes kept for another queen wait for a merge into her. */
  private mine(): Entry[] {
    return entries(this.path).filter(entry => entry.unreadable === undefined && (entry.queen === undefined || entry.queen === this.queen));
  }

  /** The queen as reached directly, without keeping anything: for settling conflicts, which needs her answer. */
  get direct(): Store { return this.inner; }

  async call(method: Method, params: Params = {}): Promise<unknown> {
    // The op_id (and from it a new note's id) is fixed here, so sending it later is the same write.
    let prepared = clientParams(method, params);
    const write = MUTATIONS.has(method);
    // A change to a note made here goes to that note, wherever the queen is: she may have another note by the same
    // name by now, made by someone else, and a write by name would land on hers.
    const own = write && CHANGES.has(method) ? this.keptNote(prepared) : undefined;
    if (own && !own.sent) return this.keep(method, prepared);
    // One that may already be on her goes there by its id, so it lands on that note (made from this machine's own
    // write, so nobody else's) or nowhere.
    if (own) {
      const { note: _note, ...rest } = prepared;
      prepared = { ...rest, id: own.params.id };
    }
    // Whether this write itself may have reached her: then it may have landed even though no answer came back.
    let sent = false;
    // Once she could not be reached, this command does not wait on her again: every try costs a full timeout.
    // Not for wait, which is there to keep asking until she is back.
    if (!this.offline || !this.fallback) {
      try {
        const answer = await this.inner.call(method, prepared);
        if (!this.reached) { this.reached = true; markDown(false); }
        this.remember(method, prepared, answer);
        return this.withKept(method, prepared, answer);
      } catch (error) {
        if (!(error instanceof HiveNoteError)) throw error;
        // Not on her by that id: it has not reached her yet. A progress line waits for it here; a change can't be
        // made to what is kept, since a merge cut short may still bring the note as it was sent.
        if (own && error.code === 'not_found') {
          if (method === 'append') return this.keep(method, prepared);
          throw stillSending(own.name);
        }
        if (error.code !== 'transport_error') throw error;
        // Refused or never opened, the connection carried nothing: she can't have made it.
        sent = write && (error.details as { sent?: boolean } | undefined)?.sent !== false;
        this.offline = true;
        this.unreachable = error;
        // The next commands, for a while, give her one short try instead of the full wait.
        markDown(true);
      }
    }
    if (write) {
      const name = own?.name ?? (typeof prepared.note === 'string' ? prepared.note : undefined);
      // A change sent by id to a note that may be on her: if it went out, she may have made it.
      if (sent && own && method !== 'append') throw maybeLanded(method, name);
      try { return await this.keep(method, prepared, sent); } catch (error) {
        // A refusal says nothing was changed; that is only sure when the write never went out.
        if (sent && error instanceof HiveNoteError && error.code === 'queen_unreachable') throw maybeLanded(method, name);
        throw error;
      }
    }
    const error = this.unreachable!;
    // A machine that has never reached her has nothing to answer from: an empty answer would hide a wrong address or a queen that is down.
    if (!this.fallback || !READS.has(method) || (!this.seen.since() && !this.mine().length)) throw new HiveNoteError(error.code, `${error.message}. ${this.fallback ? 'This needs her' : 'Waiting needs her'}; try again when she is back`, error.status);
    return this.fromSeen(method, prepared);
  }

  // ---------- What was seen ----------

  private remember(method: Method, p: Params, answer: unknown): void {
    const a = answer as { notes?: (Note & BriefNote)[]; updates?: Event[]; updates_has_more?: boolean; waits_on?: Record<string, string[]>; note?: Note; has_more?: boolean; missing?: string[]; event_seq?: number };
    if (method === 'read' && Array.isArray(a.notes)) {
      this.seen.saw(a.notes, a.updates, { waits_on: a.waits_on ?? {}, more: a.updates_has_more === true });
      // A name she says she does not have is not hers any more, whatever was seen under it before.
      if (Array.isArray(p.names)) for (const name of a.missing ?? []) this.seen.forgetName(name);
    } else if ((method === 'list' || method === 'search') && Array.isArray(a.notes)) {
      this.seen.listed(a.notes, method === 'search');
      // Every page of a listing with nothing left out says what she holds now; anything else seen has gone.
      const whole = method === 'list' && !['kind', 'status', 'ready', 'folder'].some(key => p[key] !== undefined);
      if (whole && (p.offset ?? 0) === 0) this.listing = new Set();
      if (whole && this.listing) {
        for (const note of a.notes) this.listing.add(note.id);
        if (!a.has_more) { this.seen.keepOnly(this.listing); this.listing = undefined; }
      }
    } else if (MUTATIONS.has(method) && a.note) {
      // A write that named what a task waits on is answered with those names: all of them, done or not, which offline
      // holds the task back until each is known here to be done.
      const after = (answer as { after?: unknown }).after;
      this.seen.saw([a.note], [], Array.isArray(after) ? { waits_on: { [a.note.name]: after.map(String) } } : {});
      // A line this machine added is part of what it saw: offline, the note is shown with it.
      if (method === 'append' && typeof p.body === 'string') {
        this.seen.addLine({ seq: a.event_seq ?? 0, note_id: a.note.id, kind: 'append', revision: null, snapshot: null, body: p.body, op_id: String(p.op_id), attribution: a.note.last_activity_attribution, timestamp: a.note.activity_at });
      }
    }
    this.seen.answered();
  }

  /** On a live answer, notes made here and not merged yet are added, so this machine sees what it wrote. */
  private withKept(method: Method, params: Params, answer: unknown): unknown {
    // wait follows a note by id on the queen; one made here is not there, and is not shown as if it were.
    if ((method !== 'read' && method !== 'list') || !this.fallback || (method === 'read' && params.names === undefined)) return answer;
    const { notes: made, updates } = this.made();
    if (!made.length) return answer;
    const a = answer as { notes: unknown[]; missing?: string[]; updates?: Event[]; total?: number };
    if (method === 'read') {
      const found = made.filter(note => a.missing?.includes(note.name));
      if (!found.length) return answer;
      const names = new Set(found.map(note => note.name));
      return { ...a, notes: [...a.notes, ...found], missing: a.missing!.filter(name => !names.has(name)), updates: [...(a.updates ?? []), ...updates.filter(update => found.some(note => note.id === update.note_id))] };
    }
    if (params.offset || params.ready || params.status || (params.kind && params.kind !== 'task')) return answer;
    const listed = new Set((a.notes as { name: string }[]).map(note => note.name));
    const prefix = typeof params.folder === 'string' ? params.folder.replace(/\/+$/u, '') + '/' : '';
    const extra = made.filter(note => !listed.has(note.name) && (!params.kind || note.kind === params.kind) && note.name.startsWith(prefix)).map(brief);
    return { ...a, notes: [...a.notes, ...extra], total: (a.total ?? 0) + extra.length };
  }

  /** Notes made here and not merged yet, with the progress kept for them and for her notes. */
  private made(): { notes: (Note & { waits_on_names?: string[] })[]; updates: Event[] } {
    const all = this.mine();
    const notes = all.filter(entry => entry.method === 'create').map(entry => madeHere(entry, all.filter(other => other.method === 'append' && other.params.id === entry.params.id)));
    const updates = all.filter(entry => entry.method === 'append').map((entry, i) => keptEvent(entry, -(i + 1)));
    return { notes, updates };
  }

  /** A read while the queen can't be reached: what this machine last saw, with what it kept, said as such. */
  private fromSeen(method: Method, p: Params): unknown {
    const { notes: made, updates: keptLines } = this.made();
    const madeIds = new Set(made.map(note => note.id));
    const whole = [...this.seen.notes().filter(note => !madeIds.has(note.id)), ...made];
    const since = this.seen.since();
    const offline = { offline: {
      as_of: since ? age(since) : 'never',
      heads_up: since ? `The queen can't be reached. This is what this machine last saw, ${age(since)} ago; others may have changed it since` : "The queen can't be reached, and this machine has not seen her hive yet",
    } };
    const updatesOf = (note: Note): Event[] => [...(madeIds.has(note.id) ? [] : this.seen.updatesOf(note.id)), ...keptLines.filter(update => update.note_id === note.id)];
    const listedAs = new Map(this.seen.briefs().map(entry => [entry.id, entry]));
    // What a task waits on, as she last said (or, for one made here, as it was made).
    const waitsOf = (note: Note): string[] => (note as { waits_on_names?: string[] }).waits_on_names ?? listedAs.get(note.id)?.waits_on ?? [];
    if (method === 'read') {
      const names = (p.names as string[] | undefined) ?? [];
      const notes = names.flatMap(name => whole.filter(note => note.name === name).slice(0, 1));
      const missing = names.filter(name => !notes.some(note => note.name === name));
      // Listed while she was up, but never read here: the name is known, the text is not.
      const listedOnly = missing.filter(name => this.seen.briefs().some(entry => entry.name === name));
      // Never seen here at all: she may well have it. Without her, this machine can't say it does not exist.
      const unknown = missing.filter(name => !listedOnly.includes(name));
      if (!notes.length) {
        const why = [
          ...(listedOnly.length ? [`only listed ${listedOnly.map(name => `'${name}'`).join(', ')}, never read ${listedOnly.length === 1 ? 'its' : 'their'} text`] : []),
          ...(unknown.length ? [`has never seen ${unknown.map(name => `'${name}'`).join(', ')}, so it can't tell whether she has ${unknown.length === 1 ? 'it' : 'them'}`] : []),
        ].join(', and ');
        throw new HiveNoteError('queen_unreachable', `The queen can't be reached, and this machine ${why}. Read ${missing.length === 1 ? 'it' : 'them'} when she is back`, 503);
      }
      const notShown = [...(listedOnly.length ? [`never read on this machine, so not shown: ${listedOnly.join(', ')}`] : []), ...(unknown.length ? [`never seen on this machine, so she may have them: ${unknown.join(', ')}`] : [])];
      const heads = notShown.length ? { heads_up: `${offline.offline.heads_up}. ${notShown.join('; ')}` } : {};
      const waits = Object.fromEntries(notes.filter(note => note.kind === 'task' && waitsOf(note).length).map(note => [note.name, waitsOf(note)]));
      // She sends a note's latest progress lines only; that older ones exist is said here as she said it.
      const more = notes.some(note => !madeIds.has(note.id) && this.seen.moreOf(note.id));
      return { notes, missing, updates: notes.flatMap(updatesOf), updates_has_more: more, ...(Object.keys(waits).length ? { waits_on: waits } : {}), offline: { ...offline.offline, ...heads } };
    }
    const wholeIds = new Set(whole.map(note => note.id));
    let briefs: (BriefNote & { snippet?: string })[] = [
      ...whole.map(note => {
        const waits = waitsOf(note);
        return { ...brief(note), ...(waits.length ? { waits_on: waits } : {}) };
      }),
      ...this.seen.briefs().filter(entry => !wholeIds.has(entry.id)),
    ];
    if (method === 'search') {
      const words = String(p.query ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
      const text = (entry: BriefNote): string => {
        const note = whole.find(other => other.id === entry.id);
        return [entry.name, entry.description, note?.content ?? '', ...(note ? updatesOf(note).map(update => update.body ?? '') : [])].join('\n').toLowerCase();
      };
      briefs = briefs.filter(entry => words.every(word => text(entry).includes(word)));
    } else {
      if (p.kind) briefs = briefs.filter(entry => entry.kind === p.kind);
      if (p.status) briefs = briefs.filter(entry => entry.status === p.status);
      if (typeof p.folder === 'string') { const prefix = p.folder.replace(/\/+$/u, '') + '/'; briefs = briefs.filter(entry => entry.name.startsWith(prefix)); }
      if (p.ready) {
        // As far as this machine knows: a task she said waits on another is ready only once that one is known here to
        // be done or cancelled. One this machine knows nothing of may still be open, so it still holds the task back.
        const known = [...whole, ...this.seen.briefs()];
        const closed = (name: string): boolean => {
          const found = known.find(entry => entry.name === name);
          return found !== undefined && (found.status === 'done' || found.status === 'cancelled');
        };
        briefs = briefs.filter(entry => entry.kind === 'task' && entry.status === 'todo').filter(entry => (entry.waits_on ?? []).every(closed))
          .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
      }
    }
    return { notes: briefs, total: briefs.length, offset: 0, has_more: false, ...offline };
  }

  // ---------- Keeping writes ----------

  /** The note made here (and not merged yet) that a write names, if it is one. */
  private keptNote(p: Params): Entry | undefined {
    return this.mine().find(entry => entry.method === 'create' && (p.id !== undefined ? entry.params.id === p.id : entry.name === p.note));
  }

  /** @param sent whether this write may already have reached her: a new note kept so is not changed here again. */
  private async keep(method: Method, p: Params, sent = false): Promise<unknown> {
    return locked(this.path, () => {
      const all = entries(this.path);
      const here = all.filter(entry => entry.unreadable === undefined && (entry.queen === undefined || entry.queen === this.queen));
      const base = { ...this.labels, queen: this.queen, at: new Date().toISOString() };
      checkKept(method, p);
      if (method === 'create') {
        const name = String(p.name ?? '');
        if (here.some(entry => entry.method === 'create' && entry.name === name)) throw new HiveNoteError('conflict', `'${name}' was already added on this machine while the queen was away. Change it with edit, replace or append`, 409);
        // She had a note by that name when this machine last looked: adding it again could only fail at merge.
        if (this.seen.idOf(name)) throw new HiveNoteError('conflict', `'${name}' is already on the queen, as this machine last saw her. Nothing was kept. Add progress to it with hivenote append ${name} "...", or choose another name`, 409);
        save(this.path, [...all, { method: 'create', params: p, name, ...base, ...(sent ? { sent: true as const } : {}) }]);
        return { queued: { note: name } };
      }
      const target = here.find(entry => entry.method === 'create' && (p.id !== undefined ? entry.params.id === p.id : entry.name === p.note));
      if (target?.sent && method !== 'append') throw stillSending(target.name);
      if (target) return this.changeMadeHere(all, target, method, p, base);
      if (method === 'append') {
        const name = String(p.note ?? '');
        const id = p.id !== undefined ? String(p.id) : this.seen.idOf(name);
        if (!id) throw new HiveNoteError('queen_unreachable', `The queen can't be reached, and this machine has never seen a note named '${name}', so it can't tell which note you mean. Nothing was kept. Try again when she is back`, 503);
        const { note: _note, ...rest } = p;
        save(this.path, [...all, { method: 'append', params: { ...rest, id }, name, ...base }]);
        return { queued: { note: name } };
      }
      throw refused(method, p);
    });
  }

  /** A change to a note made here: it changes what is kept, since nobody else has the note yet. */
  private changeMadeHere(all: Entry[], target: Entry, method: Method, p: Params, base: Labels & { at: string }): unknown {
    const params = target.params;
    // The kept note changed, so it is a different write: one the queen may already have under the old op_id must not
    // count as this one. The id stays, so progress kept for it still lands on it.
    if (method !== 'append' && method !== 'delete') params.op_id = p.op_id;
    switch (method) {
      case 'append':
        save(this.path, [...all, { method: 'append', params: { id: params.id, body: p.body, op_id: p.op_id }, name: target.name, ...base }]);
        return { queued: { note: target.name } };
      case 'edit': {
        const content = String(params.content ?? ''), old = String(p.old_str ?? '');
        const first = old ? content.indexOf(old) : -1;
        if (first < 0) throw new HiveNoteError('conflict', 'The old text is not in the note as it stands now. Read it and redo the edit', 409);
        if (content.indexOf(old, first + 1) >= 0) throw new HiveNoteError('conflict', 'The old text is in the note more than once. Give more of the text around it', 409);
        params.content = content.slice(0, first) + String(p.new_str ?? '') + content.slice(first + old.length);
        break;
      }
      case 'replace':
        for (const key of ['content', 'description', 'metadata'] as const) if (p[key] !== undefined) params[key] = p[key];
        if (p.name !== undefined) {
          if (all.some(entry => entry.method === 'create' && entry.name === p.name && entry !== target && entry.queen === target.queen)) throw new HiveNoteError('conflict', `'${String(p.name)}' was already added on this machine`, 409);
          // As with add: a name she had when this machine last looked could only become a conflict at merge.
          if (p.name !== target.name && this.seen.idOf(String(p.name))) throw new HiveNoteError('conflict', `'${String(p.name)}' is already on the queen, as this machine last saw her. Nothing was changed. Choose another name`, 409);
          params.name = p.name;
          for (const entry of all) if (entry.params.id === params.id) entry.name = String(p.name);
        }
        break;
      case 'update_task':
        if (params.kind !== 'task') throw new HiveNoteError('validation_error', `'${target.name}' is a note, not a task, so it has no status to mark`, 400);
        if (p.after !== undefined || p.not_after !== undefined) throw new HiveNoteError('queen_unreachable', "The queen can't be reached, and what a task waits on is checked by her. Try again when she is back", 503);
        if (p.status !== undefined) params.status = p.status;
        if (p.due_at !== undefined) params.due_at = p.due_at;
        if (p.metadata !== undefined) params.metadata = p.metadata;
        break;
      case 'delete':
        // Nobody else has it, so it simply goes, with its progress.
        save(this.path, all.filter(entry => entry.params.id !== params.id));
        return { queued: { note: target.name, dropped: true } };
      default:
        throw refused(method, p);
    }
    save(this.path, all);
    return { queued: { note: target.name } };
  }

  /** The queen this command talks to, as her writes and conflicts are kept. */
  get queenAddress(): string { return this.queen; }

  // wait runs for minutes and only waits on her: saving its copy at the end would put back what others saw meanwhile.
  close(): void { if (this.fallback) this.seen.save(); this.inner.close?.(); }
}

/** What the queen would refuse anyway is refused now, not at merge as a conflict. */
function checkKept(method: Method, p: Params): void {
  if (method === 'create') {
    text(p.name, 'name', LIMITS.name);
    text(p.description ?? '', 'description', LIMITS.description, true);
    text(p.content ?? '', 'content', LIMITS.content, true);
    if (p.status !== undefined) checkStatus(p.status);
    if (p.metadata !== undefined) checkMetadata(p.metadata);
    if (p.after !== undefined && p.kind !== 'task') throw new HiveNoteError('validation_error', 'Only a task can wait on other tasks');
  }
  if (method === 'append') text(p.body, 'body', LIMITS.content);
  if (method === 'edit') { text(p.old_str, 'old_str', LIMITS.content); text(p.new_str ?? '', 'new_str', LIMITS.content, true); }
  if (method === 'replace') {
    if (p.name !== undefined) text(p.name, 'name', LIMITS.name);
    if (p.description !== undefined) text(p.description, 'description', LIMITS.description, true);
    if (p.content !== undefined) text(p.content, 'content', LIMITS.content, true);
    if (p.metadata !== undefined) checkMetadata(p.metadata);
  }
  if (method === 'update_task' && p.status !== undefined) checkStatus(p.status);
}

/**
 * A write that went out and got no answer: she may have made it before the connection dropped, so the caller is
 * told to look, not that nothing changed. Not kept either, so it is never made a second time over what she has.
 */
function maybeLanded(method: Method, name: string | undefined): HiveNoteError {
  const what = method === 'take' ? 'hivenote tasks shows whether a task is now marked doing by you'
    : `hivenote read ${name ?? 'NAME'} shows whether it did`;
  return new HiveNoteError('queen_unreachable', `The queen did not answer. This ${method === 'take' ? 'take' : 'change'} went out to her and may have been made before the connection dropped: when she is back, ${what}, before trying again. It was not kept here`, 503);
}

/** Why a write could not be kept while the queen is away. */
export function refused(method: Method, p: Params): HiveNoteError {
  const why = method === 'take' || (method === 'update_task' && p.status === 'doing')
    ? "taking a task needs the queen's answer, so it is not kept"
    : `only new notes, progress lines (append), and changes to notes added on this machine while she is away are kept. ${method === 'update_task' ? 'A mark' : /^[aeiou]/u.test(method) ? `An ${method}` : `A ${method}`} of a note she holds waits for her, so nothing is replayed over what others did meanwhile`;
  return new HiveNoteError('queen_unreachable', `The queen can't be reached. Nothing was changed: ${why}. Try again when she is back`, 503);
}

// ---------- merge ----------

export interface MergeReport {
  merged_into: string; applied: number; already: number; conflicts: { note: string; kind: string; by: string; why: string }[];
  /** Writes kept for other queens, left for a merge into each of them. */
  kept_for_other_queens?: number;
  next?: string;
}

/** Whether something kept belongs to this queen. One kept before writes carried their queen goes with any. */
function forQueen(item: { queen?: string }, queen: string): boolean { return item.queen === undefined || item.queen === queen; }

/**
 * `hivenote merge`: send what was kept here for the queen this machine is connected to, oldest first.
 * Each leaves the file as soon as it is settled, so a merge cut short carries on where it stopped. What was kept for
 * another queen stays, for a merge into her.
 */
export async function mergeKept(address: string, reach: (labels: Labels) => Store, path = queuePath()): Promise<MergeReport> {
  const { url, old, version } = await reachQueen(address);
  const queen = queenOf(url);
  let applied = 0, already = 0, elsewhere = 0;
  const report: MergeReport['conflicts'] = [];
  // Locks are always taken in one order, the kept writes before the conflicts, and resolve takes only the second:
  // two commands can never each hold one and wait for the other.
  await locked(path, async () => {
    let left = entries(path);
    const theirs = left.filter(entry => entry.unreadable === undefined && !forQueen(entry, queen));
    elsewhere = theirs.length;
    // Writes kept for another queen are hers alone: sending them here could put one hive's notes into another's.
    if (theirs.length && theirs.length === left.length) {
      const queens = [...new Set(theirs.map(entry => entry.queen!))];
      throw new HiveNoteError('other_queen', `${writes(theirs.length)} on this machine ${theirs.length === 1 ? 'was' : 'were'} kept for the queen at ${queens.join(', ')}, not ${queen}. Nothing was sent. Connect to ${queens.length === 1 ? 'her' : 'each'} again and run hivenote merge there; to forget them instead, delete ${path}`, 409);
    }
    // A note she did not take holds back the progress kept for it, which joins its conflict, also one from an
    // earlier merge that stopped part way. Found by the id it was kept under.
    const held = new Map<string, Conflict>();
    for (const conflict of conflictLines()) if (conflict.id && conflict.params && forQueen(conflict, queen)) held.set(conflict.id, conflict);
    const settle = (entry: Entry): void => { left = left.filter(other => other !== entry); save(path, left); };
    const conflictFor = async (entry: Entry, why: string, code: string): Promise<void> => {
      const id = String(entry.params.id ?? '');
      const conflict: Conflict = entry.method === 'create'
        ? { kind: entry.params.kind === 'task' ? 'task' : 'note', name: entry.name, id, queen, params: entry.params, progress: [], ...labelsOf(entry), why, code }
        : { kind: 'progress', name: entry.name, id, queen, progress: [String(entry.params.body)], ...labelsOf(entry), why, code };
      await addConflict(conflict);
      if (entry.method === 'create') held.set(id, conflict);
      report.push({ note: entry.name, kind: conflict.kind, by: entry.agent ?? HERE, why });
    };
    for (const entry of [...left]) {
      const id = String(entry.params.id ?? '');
      if (entry.unreadable !== undefined) {
        await addConflict({ kind: 'progress', name: '(unreadable)', progress: [entry.unreadable], why: 'This line in the kept file could not be read, probably cut short by a crash. Its text is kept as it was', code: 'unreadable' });
        report.push({ note: '(unreadable)', kind: 'progress', by: HERE, why: 'could not be read' });
        settle(entry);
        continue;
      }
      if (!forQueen(entry, queen)) continue;
      const earlier = held.get(id);
      if (earlier && entry.method === 'append') { earlier.progress.push(String(entry.params.body)); await rewriteConflict(earlier); settle(entry); continue; }
      // A task that waits on one made here that she did not take would wait on whatever she has under that name.
      const after = entry.method === 'create' && Array.isArray(entry.params.after) ? (entry.params.after as unknown[]).map(String) : [];
      const waitsOnHeld = after.find(name => [...held.values()].some(conflict => conflict.name === name && conflict.kind === 'task'));
      if (waitsOnHeld) { await conflictFor(entry, `It waits on '${waitsOnHeld}', which was added here too and became a conflict: settle that one first, then this`, 'waits_on_conflict'); settle(entry); continue; }
      // A queen before 1.0 can't keep what a task waits on: stop before anything of it is half sent.
      if (old && entry.method === 'create' && entry.params.after !== undefined) throw new HiveNoteError(queenTooOld(version).code, `${queenTooOld(version).message}. '${entry.name}' was kept with --after. ${writes(applied)} ${applied === 1 ? 'was' : 'were'} merged before it; the rest stay kept`, 501);
      // From here on she may have it, whatever happens to this merge: it is not changed on this machine again.
      if (entry.method === 'create' && !entry.sent) { entry.sent = true; save(path, left); }
      try {
        // Sent with the op_id it was made with: a write she already has is answered from her receipt, or refused
        // as op_id_conflict once that receipt is gone, and is never made twice.
        const answer = await reach(labelsOf(entry)).call(entry.method, entry.params) as { note?: { id?: string } };
        applied++;
        // A name she once had keeps that note's history, so the note can come back under her id, not the one made
        // here: what was kept for it goes there too.
        const given = answer?.note?.id;
        if (entry.method === 'create' && typeof given === 'string' && given !== id) {
          for (const other of left) if (other !== entry && String(other.params.id ?? '') === id) other.params = { ...other.params, id: given };
        }
      } catch (error) {
        if (!(error instanceof HiveNoteError)) throw error;
        if (error.code === 'op_id_conflict') already++;
        // She can't be reached, is busy, or won't take writes from this token: stop, and keep everything left.
        else if (error.code === 'transport_error' || error.code === 'busy' || error.status === 401 || error.status === 403) {
          throw new HiveNoteError(error.code, `${error.message}. ${writes(applied)} ${applied === 1 ? 'was' : 'were'} merged before that. Run hivenote merge again; nothing is made twice`, error.status);
        } else {
          await conflictFor(entry, entry.method === 'append' && error.code === 'not_found' ? `'${entry.name}' is no longer on the queen (deleted meanwhile)` : error.message, error.code);
        }
      }
      settle(entry);
    }
  });
  const next = report.length ? 'hivenote conflicts shows each one beside what the queen has; settle it with hivenote resolve NAME as NEW-NAME, resolve NAME append, or resolve NAME drop' : undefined;
  return { merged_into: url, applied, already, conflicts: report, ...(elsewhere ? { kept_for_other_queens: elsewhere } : {}), ...(next ? { next } : {}) };
}

function labelsOf(entry: { agent?: string; session?: string }): Labels {
  return { ...(entry.agent ? { agent: entry.agent } : {}), ...(entry.session ? { session: entry.session } : {}) };
}

/** Changes to the conflicts file hold its lock, as resolve does, so neither loses what the other wrote. */
function addConflict(conflict: Conflict): Promise<void> {
  return locked(conflictsPath(), () => {
    mkdirSync(dirname(conflictsPath()), { recursive: true, mode: 0o700 });
    appendFileSync(conflictsPath(), JSON.stringify(conflict) + '\n', { mode: 0o600 });
  });
}
/** A conflict gained a progress line: it is put back where it was, found by the id it was kept under. */
function rewriteConflict(conflict: Conflict): Promise<void> {
  return locked(conflictsPath(), () => {
    const all = conflictLines();
    const at = all.findIndex(item => item.id === conflict.id && item.params !== undefined && item.queen === conflict.queen);
    if (at >= 0) all[at] = conflict; else all.push(conflict);
    saveConflicts(all);
  });
}
function saveConflicts(all: Conflict[]): void {
  if (!all.length) { rmSync(conflictsPath(), { force: true }); return; }
  const temporary = `${conflictsPath()}.${process.pid}.tmp`;
  // A line that could not be read goes back as it was, so nothing in it is lost before someone drops it.
  writeFileSync(temporary, all.map(item => (item.raw ?? JSON.stringify(item)) + '\n').join(''), { mode: 0o600 });
  renameSync(temporary, conflictsPath());
}

// ---------- Settling conflicts ----------

/** The queen a command's store talks to, when it is a worker's. */
function queenOfStore(store: Store): string | undefined { return (store as Partial<QueueStore>).queenAddress; }

/** `hivenote conflicts`: each one, with what was kept and what the queen has under that name. */
export async function listConflicts(store: Store): Promise<unknown> {
  const queen = queenOfStore(store);
  const all = conflictLines();
  const mine = all.filter(conflict => queen === undefined || forQueen(conflict, queen));
  const shown = [];
  for (const conflict of mine) {
    let theirs: unknown;
    if (conflict.code !== 'unreadable') {
      try {
        const { notes: [note] } = await store.call('read', { names: [conflict.name] }) as { notes: Note[] };
        if (note && !isMadeHere(note)) theirs = { description: note.description, kind: note.kind, ...(note.status ? { status: note.status } : {}), content: note.content };
      } catch { /* her side is extra; the conflict is shown without it */ }
    }
    shown.push({
      note: conflict.name, kind: conflict.kind, by: conflict.agent ?? HERE, why: conflict.why,
      ...(conflict.params ? { description: conflict.params.description, content: conflict.params.content } : {}),
      ...(conflict.progress.length ? { progress: conflict.progress } : {}),
      ...(theirs ? { on_the_queen: theirs } : {}),
    });
  }
  const others = all.length - mine.length;
  return {
    conflicts: shown, total: shown.length,
    ...(others ? { other_queens: `${others} more from a merge into another queen; connect to her to see and settle ${others === 1 ? 'it' : 'them'}` } : {}),
    ...(shown.length ? { settle: 'hivenote resolve NAME as NEW-NAME (add it as a new note under that name), resolve NAME append (add it as progress on the note she has under NAME), resolve NAME drop (forget it)' } : {}),
  };
}

/**
 * `hivenote resolve NAME as NEW | append | drop`: settle one conflict. It leaves the file only once that worked.
 * It needs the queen's answer: what it sends is never kept here instead, so it is settled when it says so.
 */
export async function resolveConflict(store: Store, name: string, how: 'as' | 'append' | 'drop', newName?: string): Promise<unknown> {
  const queen = queenOfStore(store);
  // Straight to her: kept here, its write would wait for a merge while the conflict was already called settled.
  const send = (store as Partial<QueueStore>).direct ?? store;
  return locked(conflictsPath(), async () => {
    const all = conflictLines();
    const index = all.findIndex(conflict => conflict.name === name && (queen === undefined || forQueen(conflict, queen)));
    if (index < 0) {
      const elsewhere = all.find(conflict => conflict.name === name);
      if (elsewhere) throw new HiveNoteError('other_queen', `The conflict for '${name}' came from a merge into the queen at ${elsewhere.queen}, not this one. Connect to her to settle it, so nothing of one hive ends up in another`, 409);
      throw new HiveNoteError('not_found', `No conflict for '${name}'. hivenote conflicts lists them`, 404);
    }
    const conflict = all[index]!;
    let answer: Record<string, unknown> = { ok: 'resolved', note: name, how };
    // Each write gets an op_id fixed by the conflict and the step, so running resolve again after one that stopped
    // part way makes nothing twice: what she has is answered from her receipts.
    const seed = createHash('sha256').update(JSON.stringify([conflict, how, newName ?? ''])).digest('hex');
    const op = (step: number): string => `resolve-${seed.slice(0, 32)}-${step}`;
    if (how !== 'drop' && conflict.code === 'unreadable') throw new HiveNoteError('validation_error', 'This kept line could not be read, so it can only be dropped. hivenote conflicts shows its text: add it again by hand if it matters', 400);
    if (how === 'as') {
      if (conflict.params) {
        const { id: _id, op_id: _op, ...params } = conflict.params;
        await send.call('create', { ...params, name: newName, op_id: op(0) });
      } else {
        await send.call('create', { name: newName, description: `Progress kept for '${name}' while the queen was away`, content: '', op_id: op(0) });
      }
      for (const [i, body] of conflict.progress.entries()) await send.call('append', { note: newName, body, op_id: op(i + 1) });
      answer = { ...answer, note: newName, was: name };
    } else if (how === 'append') {
      const parts: string[] = [];
      if (conflict.params) {
        const description = String(conflict.params.description ?? ''), content = String(conflict.params.content ?? '');
        parts.push(`${conflict.kind === 'task' ? 'Task' : 'Note'} '${name}' written by ${conflict.agent ?? 'another agent'} while the queen was away: ${description}${content ? `\n\n${content}` : ''}`);
      }
      parts.push(...conflict.progress);
      for (const [i, body] of parts.entries()) await send.call('append', { note: name, body, op_id: op(i + 1) });
    }
    all.splice(index, 1);
    saveConflicts(all);
    return { ...answer, conflicts_left: all.filter(item => queen === undefined || forQueen(item, queen)).length };
  });
}

/** Whether the lock was left by a command on this machine that is no longer running. */
function leftBehind(lock: string): boolean {
  try {
    const [pid, host] = readFileSync(lock, 'utf8').split('\n');
    if (host !== hostname() || !/^\d+$/u.test(pid ?? '') || Number(pid) === process.pid) return false;
    try { process.kill(Number(pid), 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { return false; }
}

/**
 * One command at a time changes the file. A command that stopped half way leaves its lock behind: one whose
 * command is no longer running on this machine is taken at once, and any lock untouched for two minutes is too.
 */
async function locked<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const until = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try { writeSync(fd, `${process.pid}\n${hostname()}\n`); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (leftBehind(lock) || Date.now() - statSync(lock).mtimeMs > 120_000) {
          // Taken over by renaming it away: only one waiter's rename can move that file, and a fresh lock someone
          // made after it is never removed.
          const stale = `${lock}.${process.pid}.${Date.now()}.stale`;
          try { renameSync(lock, stale); rmSync(stale, { force: true }); } catch { /* another waiter took it first */ }
          continue;
        }
      } catch { continue; }
      if (Date.now() > until) throw new HiveNoteError('busy', 'Another hivenote command is changing what is kept on this machine; try again', 503);
      await sleep(50);
    }
  }
  const touch = setInterval(() => { try { const now = new Date(); utimesSync(lock, now, now); } catch { /* gone */ } }, 20_000);
  try { return await fn(); } finally { clearInterval(touch); rmSync(lock, { force: true }); }
}
