/**
 * What a person sees when they run hivenote in a terminal. Agents and scripts always get
 * JSON; the CLI only calls this when stdout is a terminal and no agent is detected.
 */

interface Brief { name: string; description: string; kind: string; status?: string | null; snippet?: string; updated_at?: string; updated_by?: string }
interface Note extends Brief { id: string; content: string; rev: number; last_attribution?: Who }
interface Who { agent?: string; device?: string }
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

const who = (by: Who | undefined): string => by?.agent ?? by?.device ?? 'someone';
const notes = (count: unknown): string => `${String(count)} note${count === 1 ? '' : 's'}`;

/** For tasks, the sticker: status, who changed it last, and how long ago. */
function sticker(note: Brief): string {
  if (note.kind !== 'task') return '';
  const parts = [note.status ?? 'todo', note.updated_by, note.updated_at && ago(note.updated_at)].filter(Boolean);
  return dim(`[${parts.join(' · ')}]`);
}

function listing(notes: Brief[], empty: string): string {
  if (!notes.length) return empty;
  const width = Math.min(32, Math.max(...notes.map(note => note.name.length)));
  return notes.map(note => {
    const line = `${bold(note.name.padEnd(width))}  ${note.description}${note.kind === 'task' ? `  ${sticker(note)}` : ''}`;
    return note.snippet ? `${line}\n${' '.repeat(width + 2)}${dim(note.snippet.replaceAll('\n', ' '))}` : line;
  }).join('\n');
}

function page(note: Note, updates: Event[]): string {
  const lines = [bold(note.name), dim(note.description)];
  if (note.kind === 'task') lines.push(sticker({ ...note, updated_by: who(note.last_attribution) }));
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
    case 'list': return listing(v.notes as Brief[], 'No notes yet. Add one: hivenote add NAME "description" "text"');
    case 'tasks': return listing(v.notes as Brief[], 'No tasks yet. Add one: hivenote task NAME "description"');
    case 'search': return listing(v.notes as Brief[], 'Nothing matches.');
    case 'read': {
      const pages = (v.notes as Note[]).map(item => page(item, (v.updates as Event[] | undefined) ?? []));
      if ((v.missing as string[]).length) pages.push(dim(`Not found: ${(v.missing as string[]).join(', ')}`));
      const tooBig = v.too_big as string[] | undefined;
      if (tooBig?.length) pages.push(dim(`Too much to show at once: ${tooBig.join(', ')}. Read them separately.`));
      return pages.join(`\n\n${dim('─'.repeat(40))}\n\n`);
    }
    case 'wait': return `${dim(v.reason === 'status' ? 'Reached the status you waited for.' : 'It changed.')}\n\n${page(note!, (v.updates as Event[] | undefined) ?? [])}`;
    case 'history': return history(v.events as Event[]);
    case 'add': return `Added ${bold(note!.name)}`;
    case 'task': return `Added task ${bold(note!.name)}`;
    case 'edit': return `Edited ${bold(note!.name)}`;
    case 'append': return `Added progress to ${bold(note!.name)}`;
    case 'replace': return `Rewrote ${bold(note!.name)}`;
    case 'describe': return `Changed the description of ${bold(note!.name)}`;
    case 'delete': return `Deleted ${bold(note!.name)} ${dim(`(undo: hivenote restore ${note!.name} ${note!.rev - 1})`)}`;
    case 'restore': return `Restored ${bold(note!.name)}`;
    case 'mark': return `Marked ${bold(note!.name)} ${note!.status ?? 'todo'}`;
    case 'status': return v.hive === 'queen'
      ? `Connected to the queen at ${String(v.url)}\n${dim(`${notes(v.notes)} · queen ${String(v.queen_version)} · this machine ${String(v.this_version)} · ${String(v.round_trip_ms)} ms`)}`
      : `Using this machine's own hive at ${String(v.db)}\n${dim(`${notes(v.notes)} · version ${String(v.version)}`)}`;
    case 'connect': return `Connected to the queen at ${String(v.connected)} (${notes(v.entries)}). Every hivenote command here now uses that hive.`;
    case 'disconnect': return 'Disconnected. This machine uses its own hive again. To shut the old token out too, run hivenote token remove LABEL on the queen.';
    case 'serve': return `This machine is now the queen, sharing its hive at ${String(v.serving)}\n${dim(`Dashboard: ${String(v.dashboard)}`)}\n${dim('Let a machine in: hivenote token add LABEL here, then hivenote connect URL on that machine.')}`;
    case 'ui': return `Dashboard: ${String(v.dashboard)}`;
    case 'backup': return `Backed up to ${String(v.path)}`;
    case 'token': {
      if (Array.isArray(value)) {
        const rows = value as { device: string; scope: string; revoked: number; created_at: string }[];
        if (!rows.length) return 'No tokens yet. Add one: hivenote token add LABEL';
        return rows.map(row => `${bold(row.device.padEnd(16))} ${row.scope === 'ro' ? 'read-only ' : 'read/write'}  ${dim(row.revoked ? 'removed' : `added ${ago(row.created_at)}`)}`).join('\n');
      }
      if (typeof v.token === 'string') {
        return `Token for ${bold(String(v.device))} (${v.scope === 'ro' ? 'read-only' : 'read/write'}):\n\n  ${v.token}\n\n${dim('Copy it now; it is never shown again. On that machine run: hivenote connect URL')}`;
      }
      return `Removed ${String(v.removed)} token${v.removed === 1 ? '' : 's'} for ${bold(String(v.device))}`;
    }
  }
  return JSON.stringify(value, null, 2);
}
