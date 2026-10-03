import { setTimeout as sleep } from 'node:timers/promises';
import { HiveNoteError, type Event, type Note, type Store } from './contract.js';

/**
 * Block until a note changes, a task reaches a status, or anything in the hive changes.
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
  /** Told once when the note doesn't exist yet, so a mistyped name is seen straight away. */
  notice?: (message: string) => void;
}

export interface WaitResult {
  /** `added`: the note didn't exist when the wait began, and now it does. */
  reason: 'status' | 'changed' | 'added';
  waited_ms: number;
  note: Note;
  updates: Event[];
}

/** One line of what happened in the hive: which note, what was done to it, and by whom. */
export interface Change { note: string; kind: string; by: string; at: string; body?: string; status?: string }

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
  // A note that doesn't exist yet is waited for; someone adding it is the change.
  let missing = false;

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
    if (!note) {
      if (pinned) throw new HiveNoteError('not_found', `'${options.name}' was deleted while waiting`, 404);
      if (!missing) options.notice?.(`No note named '${options.name}' yet; waiting for it to be added`);
      missing = true;
      continue;
    }

    if (!pinned) {
      if (options.status !== undefined && note.kind !== 'task') throw new HiveNoteError('validation_error', `'${options.name}' is a note, not a task, so it has no status to wait for`);
      pinned = note.id;
      baseline = fingerprint(note);
      if (options.status !== undefined && note.status === options.status) return { reason: 'status', waited_ms: Date.now() - started, note, updates: result.updates };
      if (options.status === undefined && missing) return { reason: 'added', waited_ms: Date.now() - started, note, updates: result.updates };
      continue;
    }
    const done = options.status !== undefined ? note.status === options.status : fingerprint(note) !== baseline;
    if (done) return { reason: options.status !== undefined ? 'status' : 'changed', waited_ms: Date.now() - started, note, updates: result.updates };
  }
  throw new HiveNoteError('timeout', pinned ? `Nothing changed within ${options.timeoutSeconds} seconds` : `'${options.name}' was not added within ${options.timeoutSeconds} seconds`, 408);
}

/** Block until anything in the hive changes, and say what did. */
export async function waitForAnyChange(store: Store, options: Pick<WaitOptions, 'timeoutSeconds' | 'intervalMs'>): Promise<{ reason: 'changed'; waited_ms: number; changes: Change[] }> {
  const started = Date.now();
  const deadline = options.timeoutSeconds === 0 ? Infinity : started + options.timeoutSeconds * 1000;
  // Where the hive's feed of changes stood when the wait began.
  let cursor: number | undefined;

  for (let first = true; ; first = false) {
    if (!first) {
      if (Date.now() >= deadline) break;
      await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
    }
    let feed: { events: Event[]; cursor: number };
    try {
      feed = await store.call('changes', cursor === undefined ? { tail: 1 } : { since: cursor, limit: 100 }) as typeof feed;
    } catch (error) {
      if (unreachable(error) && Date.now() < deadline) continue;
      throw error;
    }
    if (cursor === undefined) { cursor = feed.cursor; continue; }
    if (!feed.events.length) continue;

    // Progress lines carry no copy of their note, so look those names up.
    const names = new Map(feed.events.flatMap(event => event.snapshot ? [[event.note_id, event.snapshot.name] as const] : []));
    const unnamed = [...new Set(feed.events.map(event => event.note_id).filter(id => !names.has(id)))];
    if (unnamed.length) {
      const { notes } = await store.call('read', { ids: unnamed }) as ReadResult;
      for (const note of notes) names.set(note.id, note.name);
    }
    const changes = feed.events.map((event): Change => ({
      note: names.get(event.note_id) ?? '(a deleted note)',
      kind: event.kind,
      by: event.attribution.agent ?? event.attribution.device,
      at: event.timestamp,
      ...(event.body === null ? {} : { body: event.body }),
      ...(event.kind === 'update_task' && event.snapshot?.status ? { status: event.snapshot.status } : {}),
    }));
    return { reason: 'changed', waited_ms: Date.now() - started, changes };
  }
  throw new HiveNoteError('timeout', `Nothing changed within ${options.timeoutSeconds} seconds`, 408);
}
