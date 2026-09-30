import { setTimeout as sleep } from 'node:timers/promises';
import { HiveNoteError, type Event, type Note, type Store } from './contract.js';

/**
 * Block until a note changes, or until a task reaches a status.
 *
 * This is how agents hand work to each other: one agent marks a task done or
 * appends progress, and another agent waiting here wakes up with the result.
 * Waiting only reads. HiveNote never starts agents or runs commands; whoever
 * calls `wait` decides what to do next.
 */

export type WaitSelector = { id: string } | { name: string };
export type TaskStatus = NonNullable<Note['status']>;

export interface WaitOptions {
  selector: WaitSelector;
  /** Wait for this task status. Without it, any content, field or append change counts. */
  status?: TaskStatus;
  /** 0 waits forever. */
  timeoutSeconds: number;
  intervalMs: number;
}

export interface WaitResult {
  reason: 'status' | 'changed';
  waited_ms: number;
  note: Note;
  updates: Event[];
}

/** 9 minutes: finishes before the 10-minute ceiling agents such as Claude Code put on one command. */
export const WAIT_DEFAULTS = { timeoutSeconds: 540, intervalMs: 1000 } as const;

interface ReadResult { notes: Note[]; updates: Event[] }

async function readOne(store: Store, selector: WaitSelector): Promise<ReadResult & { note: Note }> {
  const params = 'id' in selector ? { ids: [selector.id] } : { names: [selector.name] };
  const result = await store.call('read', params) as ReadResult;
  const note = result.notes[0];
  if (!note) throw new HiveNoteError('not_found', 'Note not found (it may have been deleted)', 404);
  return { ...result, note };
}

/** Appends change activity_at without changing rev, so both mark a change. */
function fingerprint(note: Note): string {
  return `${note.rev}|${note.activity_at}`;
}

export async function waitForNote(store: Store, options: WaitOptions): Promise<WaitResult> {
  const started = Date.now();
  const deadline = options.timeoutSeconds === 0 ? Infinity : started + options.timeoutSeconds * 1000;
  const first = await readOne(store, options.selector);

  if (options.status !== undefined) {
    if (first.note.kind !== 'task') throw new HiveNoteError('validation_error', '--status only applies to tasks');
    if (first.note.status === options.status) return { reason: 'status', waited_ms: 0, note: first.note, updates: first.updates };
  }
  const baseline = fingerprint(first.note);

  while (Date.now() < deadline) {
    await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
    const current = await readOne(store, options.selector);
    const done = options.status !== undefined
      ? current.note.status === options.status
      : fingerprint(current.note) !== baseline;
    if (done) {
      return { reason: options.status !== undefined ? 'status' : 'changed', waited_ms: Date.now() - started, note: current.note, updates: current.updates };
    }
  }
  throw new HiveNoteError('timeout', `Nothing changed within ${options.timeoutSeconds} seconds`, 408);
}
