import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /** more: she had older progress lines than the ones kept here. */
  notes: Record<string, { note: Note; updates: Event[]; seen: string; more?: boolean }>;
  /** A task's entry carries waits_on: the unfinished tasks it waited on, by name, as she last said. */
  briefs: Record<string, BriefNote>;
}

/** Past this the notes seen longest ago are let go (their names and descriptions stay). */
const MAX_BYTES = 20 * 1024 * 1024;

export function seenPath(): string { return join(configDirectory(), 'seen.json'); }

/** Set when a command could not reach the queen, so the next ones within a while don't wait as long on her. */
export function downPath(): string { return join(configDirectory(), 'queen-down'); }
/** Whether a command found the queen unreachable within the last two minutes. */
export function recentlyDown(path = downPath()): boolean {
  try { return Date.now() - statSync(path).mtimeMs < 120_000; } catch { return false; }
}
export function markDown(down: boolean, path = downPath()): void {
  try {
    if (!down) { rmSync(path, { force: true }); return; }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { /* a hint for speed only */ }
}

export class SeenCache {
  private data: Seen | undefined;
  private dirty = false;
  /**
   * What this command changed, so saving puts only that over the file as it is then: other commands on this
   * machine save too, and writing back a copy read at the start would undo what they saw meanwhile.
   */
  private readonly changed = { notes: new Set<string>(), briefs: new Set<string>(), goneNotes: new Set<string>(), goneBriefs: new Set<string>() };

  constructor(private readonly queen: string, private readonly path = seenPath()) {}

  private load(): Seen | undefined {
    try {
      const read = JSON.parse(readFileSync(this.path, 'utf8')) as Seen;
      if (read.queen === this.queen && read.notes && read.briefs) return read;
    } catch { /* nothing seen yet, or another queen's */ }
    return undefined;
  }

  private get(): Seen {
    this.data ??= this.load() ?? { queen: this.queen, at: '', notes: {}, briefs: {} };
    return this.data;
  }

  private setNote(id: string, value: Seen['notes'][string]): void { this.get().notes[id] = value; this.changed.notes.add(id); this.changed.goneNotes.delete(id); this.dirty = true; }
  private dropNote(id: string): void { delete this.get().notes[id]; this.changed.goneNotes.add(id); this.changed.notes.delete(id); this.dirty = true; }
  private setBrief(id: string, value: BriefNote): void { this.get().briefs[id] = value; this.changed.briefs.add(id); this.changed.goneBriefs.delete(id); this.dirty = true; }
  private dropBrief(id: string): void { delete this.get().briefs[id]; this.changed.goneBriefs.add(id); this.changed.briefs.delete(id); this.dirty = true; }

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

  /**
   * Whole notes, from a read or a write's answer, with the progress lines that came with them.
   * A read also says what each task waits on (waits_on, by note name) and whether older lines were left out (more);
   * what an answer does not say is kept as it was.
   */
  saw(notes: Note[], updates: Event[] = [], said: { waits_on?: Record<string, string[]>; more?: boolean } = {}): void {
    const data = this.get();
    const now = new Date().toISOString();
    for (const note of notes) {
      if (note.deleted_at) { this.forget(note.id); continue; }
      // Names are unique among her live notes: anything else seen under this name is not this note.
      this.forgetName(note.name, note.id);
      const lines = updates.filter(update => update.note_id === note.id && update.body !== null);
      const before = data.notes[note.id];
      // Progress lines are never taken away, so lines seen earlier still hold when none came this time.
      const kept = lines.length || !before ? lines : before.updates;
      // She says once for a whole read whether lines were left out: a note with fewer than her 20 had all of its own.
      const more = said.more === undefined ? before?.more : said.more && (notes.length === 1 || lines.length >= 20);
      const waits = said.waits_on === undefined ? data.briefs[note.id]?.waits_on : said.waits_on[note.name];
      this.setNote(note.id, { note, updates: kept, seen: now, ...(more ? { more } : {}) });
      this.setBrief(note.id, { ...brief(note), ...(waits?.length ? { waits_on: waits } : {}) });
    }
  }

  /** A progress line this machine added while she was up: her answer to it carries the note, not the line. */
  addLine(event: Event): void {
    const entry = this.get().notes[event.note_id];
    if (!entry || entry.updates.some(update => update.op_id === event.op_id)) return;
    this.setNote(event.note_id, { ...entry, updates: [...entry.updates, event] });
  }

  /** Whether she had older progress lines for this note than the ones kept here. */
  moreOf(id: string): boolean { return this.get().notes[id]?.more === true; }

  /** Names and descriptions, from a listing or a search. A search does not say what a task waits on; a listing does. */
  listed(entries: (BriefNote & { snippet?: unknown })[], search = false): void {
    const data = this.get();
    for (const { snippet: _snippet, ...entry } of entries) {
      if (typeof entry.id !== 'string') continue;
      this.forgetName(entry.name, entry.id);
      const waits = search ? data.briefs[entry.id]?.waits_on : undefined;
      this.setBrief(entry.id, waits?.length && entry.waits_on === undefined ? { ...entry, waits_on: waits } : entry);
      // A note that changed since it was read is no longer known whole: its old text under maybe an old name would
      // be answered as if it were current, and a write by that name could land on the wrong note.
      const whole = data.notes[entry.id];
      if (!whole) continue;
      if (whole.note.updated_at !== entry.updated_at || whole.note.name !== entry.name) this.dropNote(entry.id);
      // The text is what was seen; a newer change to the state (a mark) is taken from the listing.
      else if (entry.status !== undefined && whole.note.status !== entry.status) this.setNote(entry.id, { ...whole, note: { ...whole.note, status: entry.status as Note['status'] } });
    }
  }

  /** A whole listing came back: whatever is not in it is no longer hers. */
  keepOnly(ids: Set<string>): void {
    const data = this.get();
    for (const id of Object.keys(data.briefs)) if (!ids.has(id)) this.dropBrief(id);
    for (const id of Object.keys(data.notes)) if (!ids.has(id)) this.dropNote(id);
  }

  /** She has no note by this name now, other than the one with this id. */
  forgetName(name: string, except?: string): void {
    const data = this.get();
    for (const [id, entry] of Object.entries(data.notes)) if (entry.note.name === name && id !== except) this.dropNote(id);
    for (const [id, entry] of Object.entries(data.briefs)) if (entry.name === name && id !== except) this.dropBrief(id);
  }

  forget(id: string): void { this.dropNote(id); this.dropBrief(id); }

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
    // What is on disk now, with this command's changes put over it.
    const ours = this.data;
    const data = this.load() ?? { queen: this.queen, at: '', notes: {}, briefs: {} };
    for (const id of this.changed.goneNotes) delete data.notes[id];
    for (const id of this.changed.goneBriefs) delete data.briefs[id];
    for (const id of this.changed.notes) if (ours.notes[id]) data.notes[id] = ours.notes[id]!;
    for (const id of this.changed.briefs) if (ours.briefs[id]) data.briefs[id] = ours.briefs[id]!;
    if (ours.at > data.at) data.at = ours.at;
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
    this.data = data;
    this.dirty = false;
    for (const set of Object.values(this.changed)) set.clear();
  }
}
