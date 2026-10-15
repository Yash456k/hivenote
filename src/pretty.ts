import { byline, type Attribution } from './contract.js';
import { headsUp } from './lean.js';
import { writes } from './merge.js';

/**
 * What a person sees when they run hivenote in a terminal. Agents and scripts always get
 * JSON; the CLI only calls this when stdout is a terminal and no agent is detected.
 */

interface Brief { name: string; description: string; kind: string; status?: string | null; snippet?: string; updated_at?: string; activity_at?: string; updated_by?: string; changed_by?: string; active_by?: string; waits_on?: string[] }
interface Note extends Brief { id: string; content: string; rev: number; last_attribution?: Who; last_activity_attribution?: Who }
type Who = Attribution;
interface Change { note: string; kind: string; by: string; at: string; body?: string; status?: string }
interface Event { note_id: string; kind: string; revision: number | null; body: string | null; timestamp: string; attribution?: Who }

const color = !process.env.NO_COLOR;
const bold = (text: string): string => color ? `\x1b[1m${text}\x1b[22m` : text;
const dim = (text: string): string => color ? `\x1b[2m${text}\x1b[22m` : text;

function ago(timestamp: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  for (const [size, unit] of [[86400, 'd'], [3600, 'h'], [60, 'm']] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return 'just now';
}

const who = byline;
const notes = (count: unknown): string => `${String(count)} note${count === 1 ? '' : 's'}`;

/** For tasks, the sticker: status, who changed it last, and how long ago. */
function sticker(note: Brief): string {
  if (note.kind !== 'task') return '';
  const when = note.activity_at ?? note.updated_at;
  const by = note.changed_by ?? note.updated_by;
  // One name with one age; when someone else posted the latest line, that is said beside it.
  const others = note.active_by !== undefined && note.active_by !== by && note.activity_at !== note.updated_at && note.updated_at !== undefined;
  const parts = [note.status ?? 'todo', by, others ? ago(note.updated_at!) : when && ago(when), others && `last line ${note.active_by} ${ago(when!)}`, note.waits_on?.length && `waits on ${note.waits_on.join(', ')}`].filter(Boolean);
  return dim(`[${parts.join(' · ')}]`);
}

function listing(notes: Brief[], empty: string, indent = ''): string {
  if (!notes.length) return empty;
  const width = Math.min(32, Math.max(...notes.map(note => note.name.length)));
  return notes.map(note => {
    const line = `${indent}${bold(note.name.padEnd(width))}  ${note.description}${note.kind === 'task' ? `  ${sticker(note)}` : ''}`;
    return note.snippet ? `${line}\n${indent}${' '.repeat(width + 2)}${dim(note.snippet.replaceAll('\n', ' '))}` : line;
  }).join('\n');
}

/**
 * A name's folder is the part before its last /. Notes outside any folder come first; then each folder
 * under its path, in order of path, with the names in it shown without the path.
 */
function folders(notes: Brief[], empty: string): string {
  const groups = new Map<string, Brief[]>();
  for (const note of notes) {
    const cut = note.name.lastIndexOf('/');
    const folder = cut > 0 ? note.name.slice(0, cut + 1) : '';
    groups.set(folder, [...groups.get(folder) ?? [], cut > 0 ? { ...note, name: note.name.slice(cut + 1) } : note]);
  }
  if (groups.size === 1 && groups.has('')) return listing(notes, empty);
  const top = groups.get('');
  groups.delete('');
  const inFolders = [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([folder, inside]) => `${dim(folder)}\n${listing(inside, '', '  ')}`);
  return [...(top ? [listing(top, '')] : []), ...inFolders].join('\n');
}

function page(note: Note, updates: Event[]): string {
  const lines = [bold(note.name), dim(note.description)];
  if (note.kind === 'task') lines.push(sticker({ ...note, changed_by: who(note.last_attribution), ...(note.last_activity_attribution ? { active_by: who(note.last_activity_attribution) } : {}) }));
  if (note.content) lines.push('', note.content);
  const progress = updates.filter(update => update.note_id === note.id && update.body);
  if (progress.length) {
    lines.push('', dim('Progress'));
    for (const update of progress) lines.push(`${dim(`${who(update.attribution)}, ${ago(update.timestamp)}:`)} ${update.body}`);
  }
  return lines.join('\n');
}

const KIND: Record<string, string> = {
  create: 'created', edit: 'edited', replace: 'rewritten', delete: 'deleted', restore: 'restored', update_task: 'marked',
};

/** One change in the hive: the note, what happened to it, who did it and when. */
function change(c: Change): string {
  const what = c.kind === 'append' ? `progress: ${c.body ?? ''}` : c.kind === 'update_task' ? `marked ${c.status ?? ''}` : KIND[c.kind] ?? c.kind;
  return `${bold(c.note)}  ${what}  ${dim(`${c.by}, ${ago(c.at)}`)}`;
}

function history(events: Event[]): string {
  if (!events.length) return 'No history.';
  const lines = events.map(event => {
    const by = `${who(event.attribution)}, ${ago(event.timestamp)}`;
    if (event.kind === 'append') return `    progress  ${dim(by)}  ${event.body ?? ''}`;
    return `${String(event.revision ?? '').padStart(3)} ${(KIND[event.kind] ?? event.kind).padEnd(9)} ${dim(by)}`;
  });
  return `${dim('VERSION')}\n${lines.join('\n')}\n${dim('Undo with: hivenote restore NAME VERSION')}`;
}

export function pretty(command: string, value: unknown): string {
  const v = value as Record<string, unknown>;
  const note = v.note as Note | undefined;
  switch (command) {
    case 'version': return `hivenote ${String(v.version)}`;
    case 'list': return folders(v.notes as Brief[], 'No notes yet. Add one: hivenote add NAME "description" "text"');
    case 'tasks': return listing(v.notes as Brief[], 'No tasks yet. Add one: hivenote task NAME "description"');
    case 'ready': return listing(v.notes as Brief[], 'Nothing is ready. hivenote tasks shows the board.');
    case 'search': return listing(v.notes as Brief[], 'Nothing matches.');
    case 'read': {
      const pages = (v.notes as Note[]).map(item => page(item, (v.updates as Event[] | undefined) ?? []));
      if ((v.missing as string[]).length) pages.push(dim(`Not found: ${(v.missing as string[]).join(', ')}`));
      const tooBig = v.too_big as string[] | undefined;
      if (tooBig?.length) pages.push(dim(`Too much to show at once: ${tooBig.join(', ')}. Read them separately.`));
      return pages.join(`\n\n${dim('─'.repeat(40))}\n\n`);
    }
    case 'wait': {
      const changes = v.changes as Change[] | undefined;
      if (changes) return `${dim('The hive changed.')}\n\n${changes.map(change).join('\n')}`;
      const why = v.reason === 'status' ? 'Reached the status you waited for.' : v.reason === 'added' ? 'It was added.' : 'It changed.';
      return `${dim(why)}\n\n${page(note!, (v.updates as Event[] | undefined) ?? [])}`;
    }
    case 'history': return `${Number(v.offset) > 0 ? dim(`(${String(v.offset)} earlier changes not shown)`) + '\n' : ''}${history(v.events as Event[])}`;
    case 'add': return `Added ${bold(note!.name)}`;
    case 'task': return `Added task ${bold(note!.name)}${Array.isArray(v.after) && v.after.length ? dim(`, after ${(v.after as string[]).join(', ')}`) : ''}`;
    case 'after': return Array.isArray(v.after) && v.after.length ? `${bold(note!.name)} waits on ${(v.after as string[]).join(', ')}` : `${bold(note!.name)} waits on no other task`;
    case 'edit': return `Edited ${bold(note!.name)}`;
    case 'append': return `Added progress to ${bold(note!.name)}`;
    case 'replace': return `Rewrote ${bold(note!.name)}`;
    case 'describe': return `Changed the description of ${bold(note!.name)}`;
    case 'delete': return `Deleted ${bold(note!.name)} ${dim(`(undo: hivenote restore ${note!.name} ${note!.rev - 1})`)}`;
    case 'restore': return `Restored ${bold(note!.name)}`;
    case 'mark': case 'take': {
      const warning = headsUp(v as unknown as Parameters<typeof headsUp>[0]);
      const over = v.taken_over as { from: string; at: string } | undefined;
      const took = over ? `\n${dim(`Taken over from ${over.from}, idle since ${ago(over.at)}`)}` : '';
      if (command === 'take') return `Took ${bold(note!.name)}${took}\n${dim(note!.description)}${note!.content ? `\n\n${note!.content}` : ''}`;
      return `Marked ${bold(note!.name)} ${note!.status ?? 'todo'}${took}${warning ? `\n${dim(warning)}` : ''}`;
    }
    case 'status':
      return v.hive === 'queen'
      ? `Connected to the queen at ${String(v.url)}\n${dim(`${notes(v.notes)} · queen ${String(v.queen_version)} · this machine ${String(v.this_version)} · ${String(v.round_trip_ms)} ms · connection ${String(v.connection)}`)}`
      : `Using this machine's own hive at ${String(v.db)}\n${dim(`${notes(v.notes)} · version ${String(v.version)}`)}`;
    case 'connect': return `Connected to the queen at ${String(v.connected)} (${notes(v.entries)}). Every hivenote command here now uses that hive.`;
    case 'disconnect': return 'Disconnected. This machine uses its own hive again. To shut the old token out too, run hivenote token remove LABEL on the queen.';
    case 'serve': {
      if (v.was) return `The tunnel had to start again, so the hive has a new address: ${bold(String(v.public))}\n${dim(`On every worker run: hivenote connect ${String(v.public)}`)}`;
      // 0.0.0.0 means "every address of this machine"; it is not an address another machine can use.
      const everywhere = /\/\/(0\.0\.0\.0|\[::\])/u.test(String(v.serving));
      const port = String(v.serving).split(':').pop()!;
      const where = v.public ? `on the internet at ${bold(String(v.public))}` : everywhere ? `on port ${port}, at every address this machine has` : `at ${String(v.serving)}`;
      const url = v.public ? String(v.public) : everywhere ? `http://THIS-MACHINE'S-ADDRESS:${port}` : 'URL';
      const lead = `This machine is now the queen, ${v.public ? 'and its hive is' : 'sharing its hive'} ${where}`;
      const next = `Let a machine in: hivenote token add LABEL here${v.public ? ', in another terminal,' : ','} then hivenote connect ${url} on that machine.`;
      const tunnel = v.public ? `\n${dim('A new address can take up to a minute to work everywhere. It lasts until this command stops; starting it again gives a new one, and workers connect again.')}` : '';
      return `${lead}\n${dim(`Dashboard: ${String(v.dashboard)}`)}\n${dim(next)}${tunnel}`;
    }
    case 'merge': {
      const conflicts = v.conflicts as { note: string; by: string; why: string }[];
      const lines = [`Merged into the queen at ${String(v.merged_into)}: ${writes(Number(v.applied))} sent${v.already ? dim(` (${String(v.already)} she had already)`) : ''}`];
      if (conflicts.length) lines.push('', bold(`Conflicts (${conflicts.length}):`), ...conflicts.map(item => `  ${item.note} ${dim(`by ${item.by}`)}: ${item.why}`));
      return [...lines, ...(v.next ? ['', dim(String(v.next))] : [])].join('\n');
    }
    case 'conflicts': {
      const conflicts = v.conflicts as { note: string; kind: string; by: string; why: string; description?: string; content?: string; text?: string; on_the_queen?: { description: string; content: string } }[];
      if (!conflicts.length) return 'No conflicts.';
      return [...conflicts.map(item => [
        `${bold(item.note)} ${dim(`${item.kind} by ${item.by}`)}`, `  ${item.why}`,
        ...(item.text !== undefined ? [`  ${item.text}`] : [`  Kept here: ${item.description ?? ''}`, ...(item.content ? [dim(indent(item.content))] : [])]),
        ...(item.on_the_queen ? [`  On the queen: ${item.on_the_queen.description}`, ...(item.on_the_queen.content ? [dim(indent(item.on_the_queen.content))] : [])] : []),
      ].join('\n')), '', dim(String(v.settle))].join('\n\n');
    }
    case 'resolve': return v.how === 'drop' ? `Dropped the kept ${bold(String(v.note))}` : v.how === 'as' ? `Added ${bold(String(v.note))} (kept as ${String(v.was)})` : `Added the kept text to ${bold(String(v.note))} as a progress line`;
    case 'ui': return `Dashboard: ${String(v.dashboard)}`;
    case 'backup': return `Backed up to ${String(v.path)}`;
    case 'token': {
      if (Array.isArray(value)) {
        const rows = value as { device: string; scope: string; revoked: number; created_at: string }[];
        if (!rows.length) return 'No tokens yet. Add one: hivenote token add LABEL';
        return rows.map(row => `${bold(row.device.padEnd(16))} ${row.scope === 'ro' ? 'read-only ' : 'read/write'}  ${dim(row.revoked ? 'removed' : `added ${ago(row.created_at)}`)}`).join('\n');
      }
      if (typeof v.token === 'string') {
        return `Token for ${bold(String(v.device))} (${v.scope === 'ro' ? 'read-only' : 'read/write'}):\n\n  ${v.token}\n\n${dim(`Copy it now; it is never shown again. On that machine run: hivenote connect URL`)}`;
      }
      return `Removed ${String(v.removed)} token${v.removed === 1 ? '' : 's'} for ${bold(String(v.device))}`;
    }
  }
  return JSON.stringify(value, null, 2);
}

function indent(text: string): string { return text.split('\n').map(line => `    ${line}`).join('\n'); }
