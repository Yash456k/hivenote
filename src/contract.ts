import { createHash, randomUUID } from 'node:crypto';

export const METHODS = ['list','read','search','create','edit','replace','append','delete','history','revision','restore','changes','claim','release','update_task'] as const;
export type Method = typeof METHODS[number];
export const MUTATIONS = new Set<Method>(['create','edit','replace','append','delete','restore','claim','release','update_task']);
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
export interface Event {
  seq: number; note_id: string; kind: string; revision: number|null;
  snapshot: Note|null; body: string|null; op_id: string; attribution: Attribution; timestamp: string;
}
export class StickyError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); this.name = 'StickyError'; }
}
export function isMethod(value: unknown): value is Method { return typeof value === 'string' && (METHODS as readonly string[]).includes(value); }
export function clientParams(method: Method, params: Params = {}): Params {
  const out: Params = MUTATIONS.has(method) && params.op_id === undefined ? {...params, op_id: randomUUID()} : {...params};
  if (method === 'create' && out.id === undefined && typeof out.op_id === 'string') {
    // Client-generated UUIDv8 derived from op_id: explicit CLI replay also preserves ID.
    const hash = createHash('sha256').update('sticky-notes:create:' + out.op_id).digest('hex');
    const variant = ((parseInt(hash[16]!, 16) & 3) | 8).toString(16);
    out.id = `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-${variant}${hash.slice(17,20)}-${hash.slice(20,32)}`;
  }
  return out;
}

/* Stable v0.1 wire contract (all optional fields omitted, not undefined):
 list {offset?,limit?,kind?,status?} => {notes: Omit<Note,'content'>[], total,offset,has_more}
 read {ids?:string[],names?:string[]} exactly one selector => {notes:Note[],missing:string[]}
 search {query,offset?,limit?} => {notes:(Omit<Note,'content'>&{snippet})[],total,offset,has_more}
 create {id?:UUID,name,description,content,kind?,metadata?,status?,due_at?,op_id}
 edit {id,old_str,new_str,base_rev?,op_id}; replace {id,content?,name?,description?,metadata?,base_rev,op_id}
 append {id,body,op_id}; delete {id,base_rev,op_id}
 history {id,offset?,limit?} => {events:Event[],total,offset,has_more} (deleted IDs allowed)
 revision {id,rev} => {note:Note}
 restore {id,rev,base_rev,op_id} (deleted ID allowed)
 changes {since?:seq,limit?} => {events:Event[],cursor,has_more}
 claim {id,ttl_seconds?:number,force?:boolean,base_rev?,op_id} default 900 seconds
 release {id,force?:boolean,base_rev?,op_id}
 update_task {id,base_rev,status?,due_at?:ISO|null,metadata?,op_id}
 Every mutation returns immutable {note:Note,event_seq:number,op_id:string}; append leaves rev unchanged.
 All errors StickyError; conflict 409 details {current:Note}. Metadata/references inert.
 */
