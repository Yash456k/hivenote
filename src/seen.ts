import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Event, type Note } from './contract.js';
import { configDirectory } from './config.js';
import { brief, type BriefNote } from './views.js';

/**
 * What a worker last saw of the queen's hive: the notes it read or wrote, and the names and
 * descriptions it listed. While she can't be reached, reads answer from this, and say so.
 * It belongs to one queen: connecting to another starts it again.
 */

interface Seen {
  queen: string;
  /** When the queen last answered. */
  at: string;
  notes: Record<string, { note: Note; updates: Event[]; seen: string }>;
  briefs: Record<string, BriefNote>;
}

/** Past this the notes seen longest ago are let go (their names and descriptions stay). */
const MAX_BYTES = 20 * 1024 * 1024;

export function seenPath(): string { return join(configDirectory(), 'seen.json'); }

export class SeenCache {
  private data: Seen | undefined;
  private dirty = false;

  constructor(private readonly queen: string, private readonly path = seenPath()) {}

  private get(): Seen {
    if (!this.data) {
      try {
        const read = JSON.parse(readFileSync(this.path, 'utf8')) as Seen;
        if (read.queen === this.queen && read.notes && read.briefs) this.data = read;
      } catch { /* nothing seen yet, or another queen's */ }
      this.data ??= { queen: this.queen, at: '', notes: {}, briefs: {} };
    }
    return this.data;
  }

  /**
   * The queen answered just now. Saved with the next change, or once a minute: rewriting a large file on every
   * command would cost each one far more than the answer itself.
   */
  answered(): void {
    const data = this.get(), now = new Date();
    if (!this.dirty && data.at && now.getTime() - Date.parse(data.at) < 60_000) return;
    data.at = now.toISOString();
    this.dirty = true;
  }
  /** When she last answered; empty when never. */
  since(): string { return this.get().at; }

  /** Whole notes, from a read or a write's answer, with the progress lines that came with them. */
  saw(notes: Note[], updates: Event[] = []): void {
    const data = this.get();
    const now = new Date().toISOString();
    for (const note of notes) {
      if (note.deleted_at) { this.forget(note.id); continue; }
      const lines = updates.filter(update => update.note_id === note.id && update.body !== null);
      const before = data.notes[note.id];
      // Progress lines are never taken away, so lines seen earlier still hold when none came this time.
      data.notes[note.id] = { note, updates: lines.length || !before ? lines : before.updates, seen: now };
      data.briefs[note.id] = brief(note);
    }
    this.dirty = true;
  }

  /** Names and descriptions, from a listing or a search. */
  listed(entries: (BriefNote & { snippet?: unknown })[]): void {
    const data = this.get();
    for (const { snippet: _snippet, ...entry } of entries) {
      if (typeof entry.id !== 'string') continue;
      data.briefs[entry.id] = entry;
      // A note that changed since it was read is no longer known whole: its old text under maybe an old name would
      // be answered as if it were current, and a write by that name could land on the wrong note.
      const whole = data.notes[entry.id]?.note;
      if (whole && (whole.updated_at !== entry.updated_at || whole.name !== entry.name)) delete data.notes[entry.id];
      // The text is what was seen; a newer change to the state (a mark) is taken from the listing.
      if (whole && data.notes[entry.id] && entry.status !== undefined) data.notes[entry.id]!.note.status = entry.status as Note['status'];
    }
    this.dirty = true;
  }

  /** A whole listing came back: whatever is not in it is no longer hers. */
  keepOnly(ids: Set<string>): void {
    const data = this.get();
    for (const id of Object.keys(data.briefs)) if (!ids.has(id)) delete data.briefs[id];
    for (const id of Object.keys(data.notes)) if (!ids.has(id)) delete data.notes[id];
    this.dirty = true;
  }

  /** She has no note by this name now. */
  forgetName(name: string): void {
    const data = this.get();
    for (const [id, entry] of Object.entries(data.notes)) if (entry.note.name === name) delete data.notes[id];
    for (const [id, entry] of Object.entries(data.briefs)) if (entry.name === name) delete data.briefs[id];
    this.dirty = true;
  }

  forget(id: string): void {
    const data = this.get();
    delete data.notes[id];
    delete data.briefs[id];
    this.dirty = true;
  }

  byName(name: string): Note | undefined {
    return Object.values(this.get().notes).map(entry => entry.note).filter(note => note.name === name).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
  }
  byId(id: string): Note | undefined { return this.get().notes[id]?.note; }
  /** The id of a note by its name, from a whole note or a listing. */
  idOf(name: string): string | undefined {
    return this.byName(name)?.id ?? Object.values(this.get().briefs).find(entry => entry.name === name)?.id;
  }
  updatesOf(id: string): Event[] { return this.get().notes[id]?.updates ?? []; }
  notes(): Note[] { return Object.values(this.get().notes).map(entry => entry.note); }
  briefs(): BriefNote[] { return Object.values(this.get().briefs); }

  save(): void {
    if (!this.dirty || !this.data) return;
    const data = this.data;
    let text = JSON.stringify(data);
    if (text.length > MAX_BYTES) {
      // Each note's size is measured once and the oldest let go until the rest fit; the file is then written once.
      let over = text.length - MAX_BYTES;
      for (const [id, entry] of Object.entries(data.notes).sort(([, a], [, b]) => (a.seen < b.seen ? -1 : 1))) {
        if (over <= 0) break;
        over -= JSON.stringify(id).length + JSON.stringify(entry).length + 2;
        delete data.notes[id];
      }
      text = JSON.stringify(data);
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch { /* only a copy for later; the command itself worked */ }
    this.dirty = false;
  }
}
