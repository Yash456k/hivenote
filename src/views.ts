import type { Event, Note } from './contract.js';
import { invalid } from './validate.js';

/** How stored rows become notes and events, and the shapes list and search return. */

export type Row = Record<string, unknown>;

/** Columns of the notes table, in the order save() writes them. */
export const NOTE_COLUMNS = [
  'id', 'name', 'description', 'content', 'kind', 'rev', 'status', 'due_at', 'claimed_by', 'claim_expires_at',
  'metadata', 'created_at', 'updated_at', 'activity_at', 'deleted_at', 'last_attribution', 'last_activity_attribution',
] as const;

/** Columns stored as JSON text. */
export const JSON_COLUMNS: readonly string[] = ['metadata', 'last_attribution', 'last_activity_attribution'];

export function toNote(row: Row): Note {
  return {
    ...row,
    metadata: JSON.parse(row.metadata as string),
    last_attribution: JSON.parse(row.last_attribution as string),
    last_activity_attribution: JSON.parse(row.last_activity_attribution as string),
  } as unknown as Note;
}

export function toEvent(row: Row): Event {
  return {
    ...row,
    snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot as string),
    attribution: JSON.parse(row.attribution as string),
  } as unknown as Event;
}

/** Everything except content. */
export function summary(note: Note): Omit<Note, 'content'> {
  const { content: _content, ...rest } = note;
  return rest;
}

/** What an agent needs to decide whether to read a note: identity, what it is for, and task state. */
export interface BriefNote {
  id: string;
  name: string;
  description: string;
  kind: Note['kind'];
  updated_at: string;
  status?: NonNullable<Note['status']>;
  due_at?: string;
  claimed_by?: string;
}

export function brief(note: Note): BriefNote {
  const entry: BriefNote = { id: note.id, name: note.name, description: note.description, kind: note.kind, updated_at: note.updated_at };
  if (note.status !== null) entry.status = note.status;
  if (note.due_at !== null) entry.due_at = note.due_at;
  if (note.claimed_by !== null) entry.claimed_by = note.claimed_by;
  return entry;
}

/** list and search return brief entries unless the caller asks for full summaries. */
export function view(detail: unknown): (note: Note) => BriefNote | Omit<Note, 'content'> {
  if (detail === undefined || detail === 'brief') return brief;
  if (detail === 'full') return summary;
  return invalid("detail must be 'brief' or 'full'");
}
