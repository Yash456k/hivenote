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

export type TaskStatus = NonNullable<Note['status']>;

export interface WaitOptions {
  /** The note's name. */
  name: string;
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

/**
 * Check every 5 seconds; give up after 9 minutes, before the 10-minute ceiling agents
 * such as Claude Code put on one command.
 */
export const WAIT_DEFAULTS = { timeoutSeconds: 540, intervalMs: 5000 } as const;

interface ReadResult { notes: Note[]; updates: Event[] }

/** The hive could not be reached this time (a restart, a network blip); worth checking again. */
function unreachable(error: unknown): boolean {
  return error instanceof HiveNoteError && (error.code === 'transport_error' || error.status === 503);
}

/** Appends change activity_at without changing rev, so both mark a change. */
function fingerprint(note: Note): string {
  return `${note.rev}|${note.activity_at}`;
}

export async function waitForNote(store: Store, options: WaitOptions): Promise<WaitResult> {
  const started = Date.now();
  const deadline = options.timeoutSeconds === 0 ? Infinity : started + options.timeoutSeconds * 1000;
  // Found by name once, then followed by identity, so a new note reusing the name never counts.
  let pinned: string | undefined;
  let baseline: string | undefined;

  for (let first = true; ; first = false) {
    if (!first) {
      if (Date.now() >= deadline) break;
      await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
    }
    let result: ReadResult;
    try {
      result = await store.call('read', pinned ? { ids: [pinned] } : { names: [options.name] }) as ReadResult;
    } catch (error) {
      if (unreachable(error) && Date.now() < deadline) continue;
      throw error;
    }
    const note = result.notes[0];
    if (!note) throw new HiveNoteError('not_found', pinned ? `'${options.name}' was deleted while waiting` : `No note named '${options.name}'`, 404);

    if (!pinned) {
      if (options.status !== undefined && note.kind !== 'task') throw new HiveNoteError('validation_error', '--status only applies to tasks');
      pinned = note.id;
      baseline = fingerprint(note);
      if (options.status !== undefined && note.status === options.status) return { reason: 'status', waited_ms: 0, note, updates: result.updates };
      continue;
    }
    const done = options.status !== undefined ? note.status === options.status : fingerprint(note) !== baseline;
    if (done) return { reason: options.status !== undefined ? 'status' : 'changed', waited_ms: Date.now() - started, note, updates: result.updates };
  }
  throw new HiveNoteError('timeout', `Nothing changed within ${options.timeoutSeconds} seconds`, 408);
}
