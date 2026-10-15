import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientParams, HiveNoteError, MUTATIONS, type Method, type Params, type Store } from './contract.js';
import { configDirectory } from './config.js';

/**
 * Writes made on a worker while the queen can't be reached.
 *
 * A write that cannot reach the queen is kept in a file in the settings folder, with the op_id
 * it was given, and the command says so. The next command that reaches the queen sends the kept
 * writes first, in the order they were made. A write the queen already has (its answer was lost
 * on the way back) is recognized by its op_id and not made twice. One she refuses is said once
 * and dropped, so it is not sent again and again.
 *
 * Taking a task is never kept: whether it is yours is the queen's answer, and it is needed now.
 * Reads are never kept either.
 */

interface Entry { method: Method; params: Params; agent?: string; session?: string; at: string }
type Labels = { agent?: string; session?: string };

/** What a command gets back for a write that was kept to send later. */
export interface Queued { queued: { note: string; waiting: number } }
export function isQueued(value: unknown): value is Queued {
  return typeof value === 'object' && value !== null && 'queued' in value && typeof (value as Queued).queued?.waiting === 'number';
}

export function queuePath(): string { return join(configDirectory(), 'queue.jsonl'); }

/** The writes waiting on this machine. */
export function waiting(path = queuePath()): number {
  return entries(path).length;
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

/** The queen is not there, as opposed to being there and saying no. */
function away(error: unknown): boolean {
  return error instanceof HiveNoteError && (error.code === 'transport_error' || error.code === 'busy' || error.status === 401);
}

const writes = (n: number): string => `${n} write${n === 1 ? '' : 's'}`;

export class QueueStore implements Store {
  /** Set once the queen could not be reached, so a command's next writes are kept without waiting on her again. Reads still ask her. */
  private offline = false;

  /**
   * @param inner   the queen, with this command's labels
   * @param reach   the queen with other labels, for kept writes made by other agents
   * @param say     where a refused kept write is reported
   */
  constructor(
    private readonly inner: Store,
    private readonly reach: (labels: Labels) => Store,
    private readonly labels: Labels,
    private readonly say: (line: string) => void,
    private readonly path = queuePath(),
  ) {}

  async call(method: Method, params: Params = {}): Promise<unknown> {
    // The op_id is fixed here, so sending the write again later is the same write.
    const prepared = clientParams(method, params);
    const keep = keepable(method, prepared);
    if (!(keep && this.offline)) {
      try {
        await this.flush();
        return await this.inner.call(method, prepared);
      } catch (error) {
        if (!(error instanceof HiveNoteError && error.code === 'transport_error')) throw error;
        this.offline = true;
        if (!keep) throw this.unreachable(error, MUTATIONS.has(method));
      }
    }
    const count = await this.locked(() => {
      const entry: Entry = { method, params: prepared, ...this.labels, at: new Date().toISOString() };
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
      return waiting(this.path);
    });
    return { queued: { note: String(prepared.note ?? prepared.name ?? prepared.id ?? ''), waiting: count } } satisfies Queued;
  }

  /** A queen that can't be reached, said with what it means for the writes kept here. */
  private unreachable(error: HiveNoteError, claim: boolean): HiveNoteError {
    const kept = waiting(this.path);
    const why = claim ? " Taking a task needs the queen's answer, so it is not kept to send later." : '';
    const queue = kept ? ` ${writes(kept)} made here ${kept === 1 ? 'is' : 'are'} waiting to be sent to the queen.` : '';
    return new HiveNoteError(error.code, `${error.message}.${why}${queue}`, error.status, error.details);
  }

  /** Send the kept writes, oldest first. Stops at the first that can't reach the queen, keeping it and the rest. */
  async flush(): Promise<void> {
    if (!existsSync(this.path)) return;
    await this.locked(async () => {
      let left = entries(this.path);
      while (left.length) {
        const entry = left[0]!;
        try {
          await this.reach({ ...(entry.agent ? { agent: entry.agent } : {}), ...(entry.session ? { session: entry.session } : {}) }).call(entry.method, entry.params);
        } catch (error) {
          if (away(error)) throw error;
          // op_id_conflict: the queen made this write already, and its answer was lost on the way back.
          if (!(error instanceof HiveNoteError && error.code === 'op_id_conflict')) {
            const said = error instanceof HiveNoteError ? error.message : 'it failed';
            this.say(`a write made while the queen could not be reached was refused when it was sent, so it is dropped: ${describe(entry)}. ${said}`);
          }
        }
        left = left.slice(1);
        this.save(left);
      }
    });
  }

  private save(left: Entry[]): void {
    if (!left.length) { rmSync(this.path, { force: true }); return; }
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, left.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /**
   * One command at a time changes the file. A command that stopped half way leaves its lock behind;
   * a lock untouched for two minutes is taken as left behind. Sending one write takes at most about 30 seconds.
   */
  private async locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const lock = `${this.path}.lock`;
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const until = Date.now() + 5 * 60_000;
    for (;;) {
      try { closeSync(openSync(lock, 'wx', 0o600)); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { if (Date.now() - statSync(lock).mtimeMs > 120_000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
        if (Date.now() > until) throw new HiveNoteError('busy', 'Another hivenote command is sending the writes kept on this machine; try again', 503);
        await sleep(50);
      }
    }
    const touch = setInterval(() => { try { const now = new Date(); utimesSync(lock, now, now); } catch { /* gone */ } }, 20_000);
    try { return await fn(); } finally { clearInterval(touch); rmSync(lock, { force: true }); }
  }

  close(): void { this.inner.close?.(); }
}

/** A kept write in a few words, to say which one was refused. */
function describe(entry: Entry): string {
  const command: Partial<Record<Method, string>> = { create: 'add', update_task: 'mark', delete: 'delete', append: 'append', edit: 'edit', replace: 'replace', restore: 'restore' };
  const name = entry.params.note ?? entry.params.name ?? '';
  const what = entry.method === 'update_task' && typeof entry.params.status === 'string' ? ` ${entry.params.status}` : '';
  return `${command[entry.method] ?? entry.method} ${String(name)}${what}`;
}
