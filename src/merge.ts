import { age, byline, HiveNoteError, type Event, type Method, type Params, type Store } from './contract.js';
import { queenTooOld, validateServerUrl } from './client.js';

/**
 * Sending writes made away from the queen: a worker's kept writes (`hivenote merge`), or what was written on a
 * temporary queen (`hivenote merge MAIN-ADDRESS`). Both go the same way and answer with the same report.
 *
 * Writes go oldest first, each with the op_id it was made with, so one the queen already has is never made twice,
 * after a crash part way through or when merge runs again. One that would replace what she changed meanwhile is
 * reported and not sent, so nothing of hers is overwritten; so is one she refuses. A note with a write that was not
 * sent keeps the rest of its writes back too, so they are not applied out of order.
 */

type Labels = { agent?: string; session?: string };

/** One write to send, and how to tell what the queen did to its note meanwhile. */
export interface Outgoing {
  method: Method;
  /** As sent, with the op_id it was made with. */
  params: Params;
  /** The note, by id or by name: whose history is read, and whose later writes are kept back if this one is not sent. */
  note: { id: string } | { note: string };
  /** The write in a few words, as the command that made it. */
  change: string;
  by: string;
  labels: Labels;
  /** How many of the note's first changes the writer had seen; only those after are read. */
  skip: number;
  /** Whether a change of hers, after those, was made without the writer knowing of it. */
  meanwhile(event: Event): boolean;
}

export interface NotMerged { change: string; by: string; why: string }
export interface Report { merged_into: string; applied: number; already: number; not_merged: NotMerged[]; next?: string }

/** Writes that replace what a note says or its status; they are sent only if the queen left the note alone meanwhile. */
const WHOLE = new Set<Method>(['replace', 'delete', 'restore', 'update_task']);

/** The queen at this address answers, and is new enough. Nothing is sent otherwise. */
export async function reachQueen(address: string): Promise<string> {
  const url = validateServerUrl(address).origin;
  let health: { ok?: boolean; version?: string; standby_for?: string } | undefined;
  try {
    health = await (await fetch(new URL('/health', url), { redirect: 'error', signal: AbortSignal.timeout(10000) })).json() as typeof health;
  } catch { throw new HiveNoteError('queen_unreachable', `Can't reach the queen at ${url}. Nothing was sent`, 503); }
  if (health?.ok !== true) throw new HiveNoteError('not_a_queen', `${url} answered, but it isn't a HiveNote queen. Nothing was sent`, 502);
  if (health.standby_for) throw new HiveNoteError('temporary_queen', `${url} is a temporary queen standing in for ${health.standby_for}, not the main queen. Nothing was sent. Give the main queen's address`, 409);
  if (!(Number(String(health.version ?? '0').split('.')[0]) >= 1)) throw queenTooOld(health.version);
  return url;
}

/**
 * Send the writes, oldest first. `settled` is told of each one as soon as it is sent, found already there, or
 * not merged, so a merge cut short carries on where it stopped. `again` is the command that carries on.
 */
export async function send(
  outgoing: Iterable<Outgoing>, reach: (labels: Labels) => Store, again: string,
  settled: (write: Outgoing, notMerged?: NotMerged) => void,
): Promise<Omit<Report, 'merged_into' | 'next'>> {
  const reader = reach({});
  let applied = 0, already = 0;
  const notMerged: NotMerged[] = [];
  const held = new Set<string>();
  const key = (write: Outgoing): string => JSON.stringify(write.note);
  const refuse = (write: Outgoing, why: string): void => {
    const item = { change: write.change, by: write.by, why };
    notMerged.push(item);
    held.add(key(write));
    settled(write, item);
  };
  for (const write of outgoing) {
    if (held.has(key(write))) { refuse(write, 'an earlier write to it made here was not merged'); continue; }
    try {
      const theirs = await history(reader, write.note, write.skip);
      if (theirs.some(event => event.op_id === write.params.op_id)) { already++; settled(write); continue; }
      const other = WHOLE.has(write.method) ? theirs.find(event => event.kind !== 'append' && write.meanwhile(event)) : undefined;
      if (other) { refuse(write, `${byline(other.attribution)} changed it on the queen meanwhile, ${age(other.timestamp)} ago`); continue; }
      await reach(write.labels).call(write.method, write.params);
      applied++;
      settled(write);
    } catch (error) {
      if (!(error instanceof HiveNoteError)) throw error;
      // The queen has it already, and no longer keeps the answer she gave.
      if (error.code === 'op_id_conflict') { already++; settled(write); continue; }
      if (error.code === 'transport_error' || error.code === 'busy' || error.status === 401) {
        throw new HiveNoteError(error.code, `${error.message}. ${writes(applied)} ${applied === 1 ? 'was' : 'were'} merged before that. Run ${again} again; nothing is applied twice`, error.status);
      }
      refuse(write, error.message);
    }
  }
  return { applied, already, not_merged: notMerged };
}

/** The queen's changes to a note after its first `skip`; none when she has no such note. */
async function history(queen: Store, note: Outgoing['note'], skip: number): Promise<Event[]> {
  const events: Event[] = [];
  for (let offset = skip; ;) {
    let page: { events: Event[]; has_more: boolean };
    try {
      page = await queen.call('history', { ...note, offset, limit: 100 }) as typeof page;
    } catch (error) {
      if (error instanceof HiveNoteError && error.code === 'not_found') return events;
      throw error;
    }
    events.push(...page.events);
    if (!page.has_more || !page.events.length) return events;
    offset += page.events.length;
  }
}

/** A write in a few words, as the command that made it. */
export function describe(method: Method, params: Params, name: string): string {
  if (method === 'create') return `${params.kind === 'task' ? 'task' : 'add'} ${name}`;
  if (method === 'update_task') return typeof params.status === 'string' ? `mark ${name} ${params.status}` : `after ${name}`;
  if (method === 'replace' && params.content === undefined && params.description !== undefined) return `describe ${name}`;
  return `${method} ${name}`;
}

export const writes = (n: number): string => `${n} write${n === 1 ? '' : 's'}`;
