import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientParams, HiveNoteError, type Event, type Method, type Params, type Store } from './contract.js';
import { configDirectory } from './config.js';
import { reachQueen, writes } from './merge.js';

/**
 * New notes and tasks made on a worker while the queen can't be reached.
 *
 * Only `add` and `task` are kept: a new note changes nothing anyone else wrote, so it can wait.
 * Every other write (edit, append, mark, delete, ...) changes a note the queen holds, and is
 * refused while she is away, so nothing is replayed over what others did meanwhile.
 *
 * A kept note waits in a file in the settings folder, with the op_id it was given, until
 * `hivenote merge` sends it. One she already has is recognized by its op_id and not made twice.
 * One she refuses, usually because someone used the name meanwhile, becomes a conflict:
 * `hivenote conflicts` lists them and `hivenote resolve` settles each.
 */

interface Entry { method: 'create'; params: Params; agent?: string; session?: string; at: string }
type Labels = { agent?: string; session?: string };

/** A kept note the queen did not take, and why. */
export interface Conflict extends Entry { why: string; code: string }

/** What a command gets back for a write that was kept. */
export interface Queued { queued: { note: string } }
export function isQueued(value: unknown): value is Queued {
  return typeof value === 'object' && value !== null && 'queued' in value && typeof (value as Queued).queued?.note === 'string';
}

export function queuePath(): string { return join(configDirectory(), 'queue.jsonl'); }
export function conflictsPath(): string { return join(configDirectory(), 'conflicts.jsonl'); }

/** The notes kept on this machine. */
export function kept(path = queuePath()): number {
  return entries(path).length;
}
/** The conflicts waiting to be resolved here. */
export function conflictCount(path = conflictsPath()): number {
  return lines<Conflict>(path).length;
}

/** The one line every command adds while notes are kept or conflicts wait. */
export function reminder(count: number, conflicts = 0): string {
  const parts: string[] = [];
  if (count) parts.push(`${notes(count)} kept while the queen was away; run hivenote merge to send ${count === 1 ? 'it' : 'them'}`);
  if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'} from a merge; hivenote conflicts shows ${conflicts === 1 ? 'it' : 'them'}`);
  return parts.join('. ');
}
const notes = (n: number): string => `${n} new note${n === 1 ? '' : 's'}`;

function lines<T>(path: string): T[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => {
    try { return line ? [JSON.parse(line) as T] : []; } catch { return []; }
  });
}

/** Kept entries. A line that can't be read (a crash part way through writing it) is moved to the conflicts, not lost. */
function entries(path: string): Entry[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => {
    if (!line) return [];
    try { return [JSON.parse(line) as Entry]; } catch { return [{ method: 'create', params: { unreadable: line }, at: '' } as Entry]; }
  });
}

/** Whether a write can wait for the queen: only a new note or task. */
function keepable(method: Method): boolean {
  return method === 'create';
}

export class QueueStore implements Store {
  /**
   * @param inner   the queen, with this command's labels
   * @param labels  this command's labels, kept with each write
   */
  constructor(
    private readonly inner: Store,
    private readonly labels: Labels,
    private readonly path = queuePath(),
  ) {}

  async call(method: Method, params: Params = {}): Promise<unknown> {
    // The op_id (and from it the note's id) is fixed here, so sending it later is the same write.
    const prepared = clientParams(method, params);
    try {
      return await this.inner.call(method, prepared);
    } catch (error) {
      if (!(error instanceof HiveNoteError && error.code === 'transport_error')) throw error;
      if (!keepable(method)) throw unreachable(error, method);
    }
    await locked(this.path, () => {
      const entry: Entry = { method: 'create', params: prepared, ...this.labels, at: new Date().toISOString() };
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
    });
    return { queued: { note: String(prepared.name ?? '') } } satisfies Queued;
  }

  close(): void { this.inner.close?.(); }
}

/** A queen that can't be reached, said with what can and can't wait for her. */
function unreachable(error: HiveNoteError, method: Method): HiveNoteError {
  const reads = ['list', 'read', 'search', 'history', 'revision', 'changes'].includes(method);
  const why = reads ? ' Reading needs her; try again when she is back' : ' Nothing was changed: only new notes and tasks (add, task) are kept on this machine while she is away. Try this again when she is back';
  return new HiveNoteError(error.code, `${error.message}.${why}`, error.status, error.details);
}

export interface MergeReport { merged_into: string; applied: number; already: number; conflicts: { note: string; kind: string; by: string; why: string }[]; next?: string }

/**
 * `hivenote merge`: send the notes kept here to the queen this machine is connected to, oldest first.
 * Each leaves the file as soon as it is settled, so a merge cut short carries on where it stopped.
 */
export async function mergeKept(address: string, reach: (labels: Labels) => Store, path = queuePath()): Promise<MergeReport> {
  const url = await reachQueen(address);
  const reader = reach({});
  let applied = 0, already = 0;
  const conflicts: MergeReport['conflicts'] = [];
  await locked(path, async () => {
    let left = entries(path);
    for (const entry of [...left]) {
      const conflict = (code: string, why: string): void => {
        addConflict({ ...entry, code, why });
        conflicts.push({ note: String(entry.params.name ?? '?'), kind: entry.params.kind === 'task' ? 'task' : 'note', by: entry.agent ?? 'this machine', why });
      };
      if (entry.params.unreadable !== undefined) {
        conflict('unreadable', 'This line in the kept file could not be read, probably cut short by a crash. Its text is kept as it was');
      } else {
        try {
          if (await has(reader, entry)) already++;
          else { await reach(labelsOf(entry)).call('create', entry.params); applied++; }
        } catch (error) {
          if (!(error instanceof HiveNoteError)) throw error;
          // She has it already, and no longer keeps the answer she gave.
          if (error.code === 'op_id_conflict') already++;
          else if (error.code === 'transport_error' || error.code === 'busy' || error.status === 401) {
            throw new HiveNoteError(error.code, `${error.message}. ${writes(applied)} ${applied === 1 ? 'was' : 'were'} merged before that. Run hivenote merge again; nothing is made twice`, error.status);
          } else conflict(error.code, error.message);
        }
      }
      left = left.filter(other => other !== entry);
      save(path, left);
    }
  });
  const next = conflicts.length ? `Settle each with hivenote resolve NAME as NEW-NAME, resolve NAME append, or resolve NAME drop. hivenote conflicts shows them with their text` : undefined;
  return { merged_into: url, applied, already, conflicts, ...(next ? { next } : {}) };
}

/** Whether the queen already has this kept note: its id, made from its op_id, has a change with that op_id. */
async function has(queen: Store, entry: Entry): Promise<boolean> {
  try {
    const page = await queen.call('history', { id: entry.params.id, limit: 100 }) as { events: Event[] };
    return page.events.some(event => event.op_id === entry.params.op_id);
  } catch (error) {
    if (error instanceof HiveNoteError && error.code === 'not_found') return false;
    throw error;
  }
}

function labelsOf(entry: { agent?: string; session?: string }): Labels {
  return { ...(entry.agent ? { agent: entry.agent } : {}), ...(entry.session ? { session: entry.session } : {}) };
}

function addConflict(conflict: Conflict): void {
  mkdirSync(dirname(conflictsPath()), { recursive: true, mode: 0o700 });
  appendFileSync(conflictsPath(), JSON.stringify(conflict) + '\n', { mode: 0o600 });
}

// ---------- Settling conflicts ----------

/** What `hivenote conflicts` shows: each kept note the queen did not take, with its text and what she has under that name. */
export async function listConflicts(queen: Store): Promise<unknown> {
  const all = lines<Conflict>(conflictsPath());
  const shown = [];
  for (const conflict of all) {
    const name = String(conflict.params.name ?? '');
    let theirs: unknown;
    if (name && conflict.code !== 'unreadable') {
      try {
        const { notes: [note] } = await queen.call('read', { names: [name] }) as { notes: { name: string; description: string; kind: string; status: string | null; content: string; last_attribution?: { agent?: string; device: string } }[] };
        if (note) theirs = { description: note.description, kind: note.kind, ...(note.status ? { status: note.status } : {}), content: note.content };
      } catch { /* the queen's side is extra; the conflict is shown without it */ }
    }
    shown.push({
      note: name || '(unreadable)', kind: conflict.params.kind === 'task' ? 'task' : 'note', by: conflict.agent ?? 'this machine', why: conflict.why,
      ...(conflict.code === 'unreadable' ? { text: String(conflict.params.unreadable) } : { description: conflict.params.description, content: conflict.params.content }),
      ...(theirs ? { on_the_queen: theirs } : {}),
    });
  }
  return {
    conflicts: shown, total: shown.length,
    ...(shown.length ? { settle: 'hivenote resolve NAME as NEW-NAME (add it under another name, or the same name to try again), resolve NAME append (add its text as a progress line on the note she has), resolve NAME drop (forget it)' } : {}),
  };
}

/** `hivenote resolve NAME as NEW | append | drop`: settle one conflict. It leaves the file only once that worked. */
export async function resolveConflict(store: Store, name: string, how: 'as' | 'append' | 'drop', newName?: string): Promise<unknown> {
  return locked(conflictsPath(), async () => {
    const all = lines<Conflict>(conflictsPath());
    const index = all.findIndex(conflict => String(conflict.params.name ?? '(unreadable)') === name || (name === '(unreadable)' && conflict.code === 'unreadable'));
    if (index < 0) throw new HiveNoteError('not_found', `No conflict for '${name}'. hivenote conflicts lists them`, 404);
    const conflict = all[index]!;
    let answer: Record<string, unknown> = { ok: 'resolved', note: name, how };
    if (how !== 'drop') {
      if (conflict.code === 'unreadable') throw new HiveNoteError('validation_error', 'This kept line could not be read, so it can only be dropped. Its text is shown by hivenote conflicts: add it again by hand if it matters', 400);
      const { id: _id, op_id: _op, ...params } = conflict.params;
      if (how === 'as') {
        await store.call('create', { ...params, name: newName });
        answer = { ...answer, note: newName, was: name };
      } else {
        const text = String(params.content ?? '') || String(params.description ?? '');
        await store.call('append', { note: name, body: `${params.kind === 'task' ? 'Task' : 'Note'} '${name}' written by ${conflict.agent ?? 'another agent'} while the queen was away: ${String(params.description ?? '')}${text && text !== params.description ? `\n\n${text}` : ''}` });
      }
    }
    all.splice(index, 1);
    if (all.length) {
      const temporary = `${conflictsPath()}.${process.pid}.tmp`;
      writeFileSync(temporary, all.map(item => JSON.stringify(item) + '\n').join(''), { mode: 0o600 });
      renameSync(temporary, conflictsPath());
    } else rmSync(conflictsPath(), { force: true });
    return { ...answer, conflicts_left: all.length };
  });
}

function save(path: string, left: Entry[]): void {
  if (!left.length) { rmSync(path, { force: true }); return; }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, left.map(entry => (entry.params.unreadable !== undefined ? String(entry.params.unreadable) : JSON.stringify(entry)) + '\n').join(''), { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * One command at a time changes the file. A command that stopped half way leaves its lock behind;
 * a lock untouched for two minutes is taken as left behind. Sending one write takes at most about 30 seconds.
 */
async function locked<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const until = Date.now() + 5 * 60_000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx', 0o600)); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 120_000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new HiveNoteError('busy', 'Another hivenote command is changing the notes kept on this machine; try again', 503);
      await sleep(50);
    }
  }
  const touch = setInterval(() => { try { const now = new Date(); utimesSync(lock, now, now); } catch { /* gone */ } }, 20_000);
  try { return await fn(); } finally { clearInterval(touch); rmSync(lock, { force: true }); }
}
