import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The package version, read from package.json so it is defined in one place. */
export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const METHODS = ['list','read','search','create','edit','replace','append','delete','history','revision','restore','changes','update_task','take'] as const;
export type Method = typeof METHODS[number];
export const MUTATIONS = new Set<Method>(['create','edit','replace','append','delete','restore','update_task','take']);
export type Params = Record<string, unknown>;
export interface Store { call(method: Method, params?: Params): Promise<unknown>; close?(): void; }
export interface Actor {
  principal: string; device: string; scope: 'ro'|'rw'; verified: boolean;
  agent?: string; session?: string;
}
export interface Attribution { principal: string; device: string; verified: boolean; labels_verified: false; agent?: string; session?: string; }
export interface Note {
  id: string; name: string; description: string; content: string; kind: 'note'|'task';
  rev: number; status: 'todo'|'doing'|'done'|'cancelled'|null; due_at: string|null;
  claimed_by: string|null; claim_expires_at: string|null; metadata: Record<string, unknown>;
  created_at: string; updated_at: string; activity_at: string; deleted_at: string|null;
  last_attribution: Attribution; last_activity_attribution: Attribution;
}
/** What a task said before its status was changed: the state the change replaced. */
export interface Previous { status: Note['status']; by: string; at: string }
/**
 * Who made a change, in one word: the agent, and the machine it came from when a token
 * proves which machine that is. Five Codex agents on five machines are then five names.
 */
export function byline(who: Attribution | undefined): string {
  if (!who) return 'someone';
  if (!who.agent) return who.device;
  return who.verified && who.device !== who.agent ? `${who.agent}@${who.device}` : who.agent;
}
/** How long ago something happened, in one word: 40s, 3m, 2h, 5d. */
export function age(from: string, to: string | number = Date.now()): string {
  const seconds = Math.max(0, Math.round(((typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from)) / 1000));
  for (const [size, unit] of [[86400, 'd'], [3600, 'h'], [60, 'm']] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  }
  return `${seconds}s`;
}
export interface Event {
  seq: number; note_id: string; kind: string; revision: number|null;
  snapshot: Note|null; body: string|null; op_id: string; attribution: Attribution; timestamp: string;
}
export class HiveNoteError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); this.name = 'HiveNoteError'; }
}
export function isMethod(value: unknown): value is Method { return typeof value === 'string' && (METHODS as readonly string[]).includes(value); }
export function clientParams(method: Method, params: Params = {}): Params {
  if (!params || typeof params !== 'object' || Array.isArray(params) || ![Object.prototype, null].includes(Object.getPrototypeOf(params) as object|null)) {
    throw new HiveNoteError('validation_error', 'params must be a JSON object');
  }
  const out: Params = MUTATIONS.has(method) && params.op_id === undefined ? {...params, op_id: randomUUID()} : {...params};
  if (method === 'create' && out.id === undefined && typeof out.op_id === 'string') {
    // Keep the pre-rename UUID namespace so existing operation retries retain their IDs.
    // Client-generated UUIDv8 derived from op_id: explicit CLI replay also preserves ID.
    const hash = createHash('sha256').update('sticky-notes:create:' + out.op_id).digest('hex');
    const variant = ((parseInt(hash[16]!, 16) & 3) | 8).toString(16);
    out.id = `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-${variant}${hash.slice(17,20)}-${hash.slice(20,32)}`;
  }
  return out;
}

/* Wire contract (notes are named by `note`, their name; `id` is still accepted from older clients) (all optional fields omitted, not undefined):
 list {offset?,limit?,kind?,status?,ready?:true,folder?,detail?:'brief'|'full'} => {notes: BriefNote[] (or Omit<Note,'content'>[] when full), total,offset,has_more,seq}, by name
 ready: todo tasks whose prerequisites are all done, oldest first. folder: names that start with folder + '/'.
 A task's entry has waits_on: the names of its prerequisites that are not done yet, when there are any.
 read {ids?:string[],names?:string[]} exactly one selector => {notes:Note[],missing:string[],waits_on?:{[name]:string[]},seq}
 seq is the number of the hive's latest change when the answer was made: changes {since:seq} gives what came after.
 search {query,offset?,limit?,detail?} => {notes:(BriefNote&{snippet})[],total,offset,has_more}
 create {id?:UUID,name,description,content,kind?,metadata?,status?,due_at?,after?:string[],op_id}
 after names the tasks a task waits on. They are stored by id in metadata["hivenote:after"], so a rename keeps the link;
 the answer gives them by name as after.
 edit {note|id,old_str,new_str,op_id}; replace {note|id,content?,name?,description?,metadata?,op_id}
 append {note|id,body,op_id}; delete {note|id,op_id}
 history {note|id,offset?,limit?} => {events:Event[],total,offset,has_more} (deleted IDs allowed)
 revision {note|id,rev} => {note:Note}
 restore {note|id,rev,op_id} (deleted ID allowed)
 changes {since?:seq,limit?,hold?:ms} | {tail:1-100} => {events:Event[],cursor,has_more}
 hold (at most 8000) keeps the question open until something comes after since, or the time is up; how wait wakes at once.
 update_task {note|id,status?,due_at?:ISO|null,metadata?,claim?:true,after?:string[],not_after?:string[],op_id}
 after adds tasks to wait on, not_after removes them.
 take {op_id} claims the oldest todo task whose prerequisites are all done or, when there is none, the doing task
 idle longest past the takeover time; error nothing_ready, 404, when there is neither.
 Every mutation returns immutable {note:Note,event_seq:number,op_id:string}; append leaves rev unchanged.
 update_task with a status also returns previous:{status,by,at}, what the task said before.
 claim (with status doing) takes the task only if nobody else has it: when another agent marked it doing, done or
 cancelled, nothing changes and the answer is the error taken, 409, details {status,by,at}. A doing task with nothing
 done on it for the takeover time (off unless set in the hive's config.json) is taken all the same, and the answer has taken_over:{from,at}.
 All errors HiveNoteError; conflict 409 details {current:Note}. Metadata/references inert.
 */
