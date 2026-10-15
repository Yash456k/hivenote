import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientParams, HiveNoteError, MUTATIONS, type Method, type Params, type Store } from './contract.js';
import { configDirectory } from './config.js';
import { describe, reachQueen, send, writes, type Outgoing, type Report } from './merge.js';

/**
 * Writes made on a worker while the queen can't be reached.
 *
 * A write that cannot reach the queen is kept in a file in the settings folder, with the op_id
 * it was given, and the command says so. Nothing sends it on its own: it reaches the queen only
 * when the person runs `hivenote merge`, oldest first. A write she already has is recognized by
 * its op_id and not made twice. One she refuses, or one that would replace what she changed
 * meanwhile, is not sent; it is moved to a file beside the kept ones and reported.
 *
 * Taking a task is never kept: whether it is yours is the queen's answer, and it is needed now.
 * Reads are never kept either.
 */

interface Entry { method: Method; params: Params; agent?: string; session?: string; at: string }
type Labels = { agent?: string; session?: string };

/** What a command gets back for a write that was kept. */
export interface Queued { queued: { note: string } }
export function isQueued(value: unknown): value is Queued {
  return typeof value === 'object' && value !== null && 'queued' in value && typeof (value as Queued).queued?.note === 'string';
}

export function queuePath(): string { return join(configDirectory(), 'queue.jsonl'); }
/** Kept writes that merge did not send, with why. */
export function notMergedPath(): string { return join(configDirectory(), 'not-merged.jsonl'); }

/** The writes kept on this machine. */
export function kept(path = queuePath()): number {
  return entries(path).length;
}

/** The one line every command adds while writes are kept. */
export function reminder(count: number): string {
  return `${writes(count)} kept while the queen was away; run hivenote merge to send ${count === 1 ? 'it' : 'them'}`;
}

function entries(path: string): Entry[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => {
    try { return line ? [JSON.parse(line) as Entry] : []; } catch { return []; }
  });
}

/** Whether a write can wait for the queen. Taking a task can't: it is a question only she can answer. */
function keepable(method: Method, params: Params): boolean {
  if (!MUTATIONS.has(method) || method === 'take') return false;
  return !(method === 'update_task' && (params.claim !== undefined || params.status === 'doing'));
}

export class QueueStore implements Store {
  /** Set once the queen could not be reached, so a command's next writes are kept without waiting on her again. Reads still ask her. */
  private offline = false;

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
    // The op_id is fixed here, so sending the write again later is the same write.
    const prepared = clientParams(method, params);
    const keep = keepable(method, prepared);
    if (!(keep && this.offline)) {
      try {
        return await this.inner.call(method, prepared);
      } catch (error) {
        if (!(error instanceof HiveNoteError && error.code === 'transport_error')) throw error;
        this.offline = true;
        if (!keep) throw this.unreachable(error, MUTATIONS.has(method));
      }
    }
    await locked(this.path, () => {
      const entry: Entry = { method, params: prepared, ...this.labels, at: new Date().toISOString() };
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
    });
    return { queued: { note: String(prepared.note ?? prepared.name ?? prepared.id ?? '') } } satisfies Queued;
  }

  /** A queen that can't be reached, said with why a write that takes a task was not kept. */
  private unreachable(error: HiveNoteError, claim: boolean): HiveNoteError {
    const why = claim ? " Taking a task needs the queen's answer, so it is not kept." : '';
    return new HiveNoteError(error.code, why ? `${error.message}.${why}` : error.message, error.status, error.details);
  }

  close(): void { this.inner.close?.(); }
}

/**
 * `hivenote merge`: send the writes kept here to the queen this machine is connected to, oldest first.
 * Each leaves the file as soon as it is settled, so a merge cut short carries on where it stopped.
 */
export async function mergeKept(address: string, reach: (labels: Labels) => Store, path = queuePath()): Promise<Report> {
  const url = await reachQueen(address);
  const sent = await locked(path, async () => {
    let left = entries(path);
    // Writes kept here are not the queen's, whenever she got them.
    const ours = new Set(left.map(entry => entry.params.op_id));
    const outgoing: (Outgoing & { entry: Entry })[] = left.map(entry => {
      const name = String(entry.params.note ?? entry.params.name ?? entry.params.id ?? '');
      return {
        entry, method: entry.method, params: entry.params,
        note: entry.params.id === undefined ? { note: name } : { id: String(entry.params.id) },
        change: describe(entry.method, entry.params, name),
        by: entry.agent ?? 'this machine',
        labels: { ...(entry.agent ? { agent: entry.agent } : {}), ...(entry.session ? { session: entry.session } : {}) },
        skip: 0,
        // What she changed after the write was made here, by anyone but this machine's kept writes.
        meanwhile: event => event.timestamp > entry.at && !ours.has(event.op_id),
      };
    });
    return send(outgoing, reach, 'hivenote merge', (write, notMerged) => {
      const { entry } = write as Outgoing & { entry: Entry };
      if (notMerged) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(notMergedPath(), JSON.stringify({ ...entry, why: notMerged.why }) + '\n', { mode: 0o600 });
      }
      left = left.filter(other => other !== entry);
      save(path, left);
    });
  });
  return { merged_into: url, ...sent, ...(sent.not_merged.length ? { next: `What was not merged is kept in ${notMergedPath()}` } : {}) };
}

function save(path: string, left: Entry[]): void {
  if (!left.length) { rmSync(path, { force: true }); return; }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, left.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600 });
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
      if (Date.now() > until) throw new HiveNoteError('busy', 'Another hivenote command is merging the writes kept on this machine; try again', 503);
      await sleep(50);
    }
  }
  const touch = setInterval(() => { try { const now = new Date(); utimesSync(lock, now, now); } catch { /* gone */ } }, 20_000);
  try { return await fn(); } finally { clearInterval(touch); rmSync(lock, { force: true }); }
}
