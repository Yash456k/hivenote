import { age, byline, type Event, type Note, type Previous } from './contract.js';
import { AFTER_KEY } from './views.js';

/**
 * What an agent or a script is shown by default: the parts of an answer it acts on.
 *
 * The hive stores more than that. A note carries its id, four timestamps and two records
 * of who touched it, every progress line is a whole event, and every write answers with
 * the note it changed. Measured over five multi-agent runs, more than half of what agents
 * were shown was that wrapping. `--full` prints the stored answer instead.
 *
 * Times are given as ages (`"ago":"3m"`), not timestamps. An agent rarely knows what time
 * it is, so an age is what it can act on, and a timestamp costs five times the tokens.
 */

type Json = Record<string, unknown>;
interface Receipt {
  note: Note; previous?: Previous; after?: string[]; taken_over?: { from: string; at: string }; waiting?: string[];
  task?: { note: Note; updates?: Event[]; updates_has_more?: boolean; seq?: number };
}

/** A note as text to act on: what it is, its state, who changed it last, and what it says. */
function note(stored: Note, now: number): Json {
  const out: Json = { name: stored.name, description: stored.description, kind: stored.kind };
  if (stored.status !== null) out.status = stored.status;
  if (stored.due_at !== null) out.due_at = stored.due_at;
  // The tasks it waits on are kept there by id; they are shown by name as waits_on instead.
  const { [AFTER_KEY]: _after, ...metadata } = stored.metadata ?? {};
  if (Object.keys(metadata).length) out.metadata = metadata;
  out.updated_by = byline(stored.last_attribution);
  out.ago = age(stored.updated_at, now);
  out.content = stored.content;
  return out;
}

/** A note's progress lines, oldest first. */
function progress(stored: Note, updates: Event[] = [], now: number): Json[] {
  return updates
    .filter(update => update.note_id === stored.id && update.body !== null)
    .map(update => ({ by: byline(update.attribution), ago: age(update.timestamp, now), text: update.body }));
}

/** A note with its progress lines under it, and for a task the unfinished tasks it waits on. */
function page(stored: Note, updates: Event[] = [], now: number, waitsOn?: string[]): Json {
  return { ...note(stored, now), ...(waitsOn?.length ? { waits_on: waitsOn } : {}), progress: progress(stored, updates, now) };
}

/**
 * The lines that differ between two texts, in order: `was` and `now` for a changed passage,
 * and `after` (the line before it) to place one that was only added.
 */
export function textChanges(before: string, after: string): Json[] {
  const a = before.split('\n'), b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  // Longest common run of lines through the part that differs; a very large one is given as a single change.
  const keep: [number, number][] = [];
  if (x.length * y.length <= 1_000_000) {
    const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    for (let i = 0, j = 0; i < x.length && j < y.length;) {
      if (x[i] === y[j]) keep.push([i++, j++]);
      else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
      else j++;
    }
  }
  const changes: Json[] = [];
  let i = 0, j = 0;
  for (const [ki, kj] of [...keep, [x.length, y.length] as [number, number]]) {
    if (ki > i || kj > j) {
      const was = x.slice(i, ki).join('\n'), now = y.slice(j, kj).join('\n');
      // An added passage is placed by the nearest line before it that says something; a blank line places nothing.
      let at = head + j - 1;
      while (at >= 0 && !b[at]!.trim()) at--;
      // A change in blank lines alone is not worth a reader's attention.
      if (was.trim() || now.trim()) changes.push(ki > i ? { was, now } : { ...(at < 0 ? {} : { after: b[at] }), added: now });
    }
    i = ki + 1; j = kj + 1;
  }
  return changes;
}

/**
 * What is new in a note the reader has seen before: its state and the new progress. If its
 * text was rewritten, the passages that changed, or the whole text when that is shorter
 * or the earlier text is not to hand.
 */
function fresh(stored: Note, updates: Event[], news: News, now: number): Json {
  // Added since then: all of it is new to the reader.
  if (news.created?.includes(stored.id)) return page(stored, updates, now);
  const out: Json = { name: stored.name };
  if (stored.status !== null) out.status = stored.status;
  out.updated_by = byline(stored.last_attribution);
  out.ago = age(stored.updated_at, now);
  if (news.rewritten.includes(stored.id)) {
    const before = news.before?.[stored.id];
    if (before === undefined) {
      out.description = stored.description;
      out.content = stored.content;
    } else {
      if (before.description !== stored.description) out.description = stored.description;
      const changes = textChanges(before.content, stored.content);
      if (changes.length) {
        if (JSON.stringify(changes).length < stored.content.length) out.text_changes = changes;
        else out.content = stored.content;
      } else if (before.description === stored.description) {
        // Rewritten and put back, or rewritten to the same words: say who did what, so an agent
        // whose own edit was undone does not go on believing it is there.
        out.text = `the same as at ${news.since}`;
        out.rewritten = (news.rewrites ?? []).filter(rewrite => rewrite.id === stored.id).map(rewrite => ({ kind: rewrite.kind, by: rewrite.by, ago: age(rewrite.at, now) }));
      }
    }
  }
  out.progress = progress(stored, updates, now);
  return out;
}

/** One line of a note's history: which version, what was done, who did it and how long ago. */
function change(event: Event, now: number): Json {
  const out: Json = {};
  if (event.revision !== null) out.version = event.revision;
  out.kind = event.kind;
  if (event.kind === 'update_task' && event.snapshot?.status) out.status = event.snapshot.status;
  out.by = byline(event.attribution);
  out.ago = age(event.timestamp, now);
  if (event.body !== null) out.text = event.body;
  return out;
}

/**
 * An entry of a listing, or one change a wait woke for: its time as an age, and no id.
 * In a listing the age is since anything happened to the note, a progress line included,
 * so a task whose agent is still writing progress does not look abandoned.
 */
function aged({ id: _id, updated_at, activity_at, at, updated_by, changed_by, active_by, ...entry }: Json, now: number): Json {
  const when = activity_at ?? updated_at ?? at;
  if (typeof when !== 'string') return entry;
  const who = changed_by ?? updated_by;
  if (who === undefined) return { ...entry, ago: age(when, now) };
  // The name and the age are of one event. When someone else posted the latest line, that is
  // said beside it, so a stalled task does not look alive under the name of whoever marked it.
  if (active_by === undefined || active_by === who || activity_at === updated_at || typeof updated_at !== 'string') return { ...entry, updated_by: who, ago: age(when, now) };
  return { ...entry, updated_by: who, ago: age(updated_at, now), last_line: { by: active_by, ago: age(when, now) } };
}

/** A name as one word of a shell command. */
export function word(name: string): string {
  return /^[\w.-]+$/u.test(name) ? name : `'${name.replaceAll("'", "'\\''")}'`;
}

/**
 * Marking a task never locks it. When a mark replaces a state another agent set (a finished
 * task reopened, a task already being worked on), say so in the answer, so an agent acting
 * on an old look at the board finds out at once and can put it right.
 */
export function headsUp({ note: task, previous, task: shown, taken_over }: Receipt): string | undefined {
  // Taken over from an agent that had gone quiet: the answer says that itself.
  if (!previous || taken_over || previous.by === byline(task.last_attribution)) return undefined;
  const ago = age(previous.at, task.updated_at);
  const closed = previous.status === 'done' || previous.status === 'cancelled';
  if (closed && (task.status === 'todo' || task.status === 'doing')) {
    return `This task was ${previous.status} (${previous.by}, ${ago} ago) and you have reopened it. If you had not seen that, read it, and put it back with: hivenote mark ${word(task.name)} ${previous.status}`;
  }
  if (previous.status === 'doing' && task.status === 'doing') {
    const look = shown ? 'Its progress is in this answer: check it before you start' : `Read its progress before you start: hivenote read ${word(task.name)}`;
    return `${previous.by} marked this doing ${ago} ago and may be working on it. ${look}`;
  }
  if (previous.status === 'doing' && task.status === 'todo') {
    return `${previous.by} marked this doing ${ago} ago and you have set it back to todo. If they are still on it, put it back with: hivenote mark ${word(task.name)} doing`;
  }
  return undefined;
}

const DID: Record<string, string> = {
  add: 'added', task: 'added', edit: 'edited', append: 'appended', replace: 'replaced',
  describe: 'described', delete: 'deleted', restore: 'restored', mark: 'marked', take: 'taken', after: 'updated',
};

/** A write is answered with what happened, not with the note that was just sent. */
function done(command: string, receipt: Receipt, now: number): Json {
  const { note: saved, previous, task, after, taken_over } = receipt;
  const out: Json = { ok: DID[command], note: saved.name };
  if (command === 'task') out.status = saved.status;
  if (after) out.after = after;
  if (command === 'edit' || command === 'replace' || command === 'describe' || command === 'restore') out.version = saved.rev;
  if (command === 'restore' && saved.status !== null) out.status = saved.status;
  if (command === 'delete') out.undo = `hivenote restore ${word(saved.name)} ${saved.rev - 1}`;
  if (command === 'delete' && receipt.waiting?.length) out.heads_up = `${receipt.waiting.join(', ')} waited on this and no longer ${receipt.waiting.length === 1 ? 'does' : 'do'}. Check whether ${receipt.waiting.length === 1 ? 'it still makes' : 'they still make'} sense`;
  if (command === 'mark' || command === 'take') {
    out.status = saved.status;
    if (previous) out.was = previous.status;
    if (taken_over) out.taken_over = { from: taken_over.from, idle: age(taken_over.at, saved.updated_at) };
    const warning = headsUp(receipt);
    if (warning) out.heads_up = warning;
    if (receipt.waiting?.length) out.heads_up = `${warning ? `${warning} ` : ''}${receipt.waiting.join(', ')} waited on this and no longer ${receipt.waiting.length === 1 ? 'does' : 'do'}. Check whether ${receipt.waiting.length === 1 ? 'it still makes' : 'they still make'} sense; cancel or delete ${receipt.waiting.length === 1 ? 'it' : 'them'} if not`;
    // A task that was just taken is shown, so whoever took it can start without reading it first.
    if (task) {
      out.description = task.note.description;
      out.content = task.note.content;
      out.progress = progress(task.note, task.updates, now);
      if (task.updates_has_more) out.earlier_progress = `hivenote history ${word(saved.name)}`;
      if (typeof task.seq === 'number') out.seq = task.seq;
    }
  }
  return out;
}

interface Read {
  notes: Note[]; missing: string[]; updates?: Event[]; updates_has_more?: boolean;
  waits_on?: Record<string, string[]>;
  news?: News;
}
/**
 * Set by `--since`: which of the notes changed after that point, which were added, which were
 * rewritten (by whom, and what each said before).
 */
interface News {
  since: number; touched: string[]; rewritten: string[]; created?: string[];
  before?: Record<string, { content: string; description: string }>;
  rewrites?: { id: string; kind: string; by: string; at: string }[];
}

/** The lean form of one command's answer. Commands about machines are short already. */
export function lean(command: string, value: unknown, now = Date.now()): unknown {
  const v = value as Json;
  switch (command) {
    case 'list': case 'tasks': case 'ready': case 'search':
      return { ...v, notes: (v.notes as Json[]).map(entry => aged(entry, now)) };
    case 'read': {
      const { notes, missing, updates = [], updates_has_more: more, waits_on: waitsOn = {}, news, ...rest } = v as unknown as Read & { seq?: number };
      const gaps = missing.length ? { missing } : {};
      if (news) {
        const unchanged = notes.filter(stored => !news.touched.includes(stored.id)).map(stored => stored.name);
        const changed = notes.filter(stored => news.touched.includes(stored.id)).map(stored => fresh(stored, updates, news, now));
        return { notes: changed, ...(unchanged.length ? { unchanged } : {}), ...gaps, ...rest };
      }
      // Said in full, because an agent that never saw the guide does not connect a bare number with the flag.
      const again = notes.length && typeof rest.seq === 'number' ? { only_new: `hivenote read ${notes.map(stored => word(stored.name)).join(' ')} --since ${rest.seq}` } : {};
      return { notes: notes.map(stored => page(stored, updates, now, waitsOn[stored.name])), ...gaps, ...rest, ...again, ...(more ? { earlier_progress: `hivenote history ${notes.length === 1 ? word(notes[0]!.name) : 'NAME'}` } : {}) };
    }
    case 'wait': {
      // How long the wait took is of no use to whoever waited.
      const { waited_ms: _waited, note: stored, updates = [], updates_has_more: _more, changes, news, ...rest } = v as { waited_ms?: number; note?: Note; updates?: Event[]; updates_has_more?: boolean; changes?: Json[]; news?: News };
      if (changes) return { ...rest, changes: changes.map(({ body, ...entry }) => ({ ...aged(entry, now), ...(body === undefined ? {} : { text: body }) })) };
      return { ...rest, note: news ? fresh(stored!, updates, news, now) : page(stored!, updates, now) };
    }
    case 'history':
      return { ...v, events: (v.events as Event[]).map(event => change(event, now)) };
    default:
      return Object.hasOwn(DID, command) ? done(command, v as unknown as Receipt, now) : value;
  }
}

/** A refused edit comes with the note as it now stands; show that lean too. */
export function leanDetails(details: unknown): unknown {
  const current = (details as { current?: Note } | undefined)?.current;
  return current && typeof current === 'object' && 'content' in current ? { current: note(current, Date.now()) } : details;
}
