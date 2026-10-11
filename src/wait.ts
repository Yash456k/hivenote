import { setTimeout as sleep } from 'node:timers/promises';
import { age, byline, HiveNoteError, type Event, type Note, type Store } from './contract.js';

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
  /** Count changes after this point in the hive's feed (a `seq` from an earlier answer), not after now. */
  since?: number;
  /** Told once when the note doesn't exist yet, so a mistyped name is seen straight away. */
  notice?: (message: string) => void;
}

export interface WaitResult {
  /** `added`: the note didn't exist when the wait began, and now it does. */
  reason: 'status' | 'changed' | 'added';
  waited_ms: number;
  note: Note;
  updates: Event[];
  seq?: number;
}

/** One line of what happened in the hive: which note, what was done to it, and by whom. */
export interface Change { note: string; kind: string; by: string; at: string; body?: string; status?: string }

/**
 * Check every 5 seconds; give up after 9 minutes, before the 10-minute ceiling agents
 * such as Claude Code put on one command.
 */
export const WAIT_DEFAULTS = { timeoutSeconds: 540, intervalMs: 5000 } as const;

interface ReadResult { notes: Note[]; updates: Event[]; seq?: number }

/**
 * Everything that happened in the hive after `since`, oldest first. Past 1,000 changes it
 * stops and says so; the caller is better off reading the notes as they stand.
 */
export async function changesSince(store: Store, since: number): Promise<{ events: Event[]; seq: number; complete: boolean }> {
  const events: Event[] = [];
  let cursor = since;
  for (let page = 0; page < 10; page++) {
    const feed = await store.call('changes', { since: cursor, limit: 100 }) as { events: Event[]; cursor: number; has_more: boolean };
    events.push(...feed.events);
    cursor = feed.cursor;
    if (!feed.has_more) return { events, seq: cursor, complete: true };
  }
  return { events, seq: cursor, complete: false };
}

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
  let last: Note | undefined;

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

    last = note;
    const answer = (reason: WaitResult['reason']): WaitResult => ({ reason, waited_ms: Date.now() - started, note, updates: result.updates, ...(result.seq === undefined ? {} : { seq: result.seq }) });

    if (!pinned) {
      if (options.status !== undefined && note.kind !== 'task') throw new HiveNoteError('validation_error', `'${options.name}' is a note, not a task, so it has no status to wait for`);
      pinned = note.id;
      baseline = fingerprint(note);
      if (options.status !== undefined && note.status === options.status) return answer('status');
      if (options.status === undefined && missing) return answer('added');
      // A change made after the caller last looked, but before this wait began, still counts.
      if (options.status === undefined && options.since !== undefined) {
        const { events } = await changesSince(store, options.since);
        if (events.some(event => event.note_id === note.id)) return answer('changed');
      }
      continue;
    }
    const done = options.status !== undefined ? note.status === options.status : fingerprint(note) !== baseline;
    if (done) return answer(options.status !== undefined ? 'status' : 'changed');
  }
  // Say where it stands, so the caller need not read it to find out.
  const within = `within ${options.timeoutSeconds} seconds`;
  if (!last) throw new HiveNoteError('timeout', `'${options.name}' was not added ${within}`, 408);
  const stands = `last changed ${age(last.activity_at)} ago by ${byline(last.last_activity_attribution)}`;
  throw new HiveNoteError('timeout', options.status !== undefined
    ? `'${options.name}' did not reach ${options.status} ${within}. It is ${last.status ?? 'todo'}, ${stands}`
    : `Nothing changed in '${options.name}' ${within}. It was ${stands}`, 408);
}

/** Block until anything in the hive changes, and say what did. */
export async function waitForAnyChange(store: Store, options: Pick<WaitOptions, 'timeoutSeconds' | 'intervalMs' | 'since'>): Promise<{ reason: 'changed'; waited_ms: number; changes: Change[]; seq: number }> {
  const started = Date.now();
  const deadline = options.timeoutSeconds === 0 ? Infinity : started + options.timeoutSeconds * 1000;
  // Where the hive's feed of changes stood when the wait began.
  let cursor = options.since;

  for (let first = true; ; first = false) {
    if (!first) {
      if (Date.now() >= deadline) break;
      await sleep(Math.min(options.intervalMs, Math.max(0, deadline - Date.now())));
    }
    let feed: { events: Event[]; cursor: number };
    try {
      feed = cursor === undefined
        ? await store.call('changes', { tail: 1 }) as typeof feed
        : await changesSince(store, cursor).then(all => ({ events: all.events, cursor: all.seq }));
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
      by: byline(event.attribution),
      at: event.timestamp,
      ...(event.body === null ? {} : { body: event.body }),
      ...(event.kind === 'update_task' && event.snapshot?.status ? { status: event.snapshot.status } : {}),
    }));
    return { reason: 'changed', waited_ms: Date.now() - started, changes, seq: feed.cursor };
  }
  throw new HiveNoteError('timeout', `Nothing changed within ${options.timeoutSeconds} seconds`, 408);
}
