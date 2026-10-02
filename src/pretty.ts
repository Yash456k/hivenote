/**
 * What a person sees when they run hivenote in a terminal. Agents and pipes always get
 * JSON; the CLI only calls this when stdout is a terminal and no agent is detected.
 */

interface Brief { id: string; name: string; description: string; kind: string; status?: string | null; snippet?: string; claimed_by?: string | null }
interface Note extends Brief { content: string; rev: number }
interface Update { note_id: string; body: string | null; timestamp: string; attribution?: { agent?: string; device?: string } }

const color = !process.env.NO_COLOR;
const bold = (text: string): string => color ? `\x1b[1m${text}\x1b[22m` : text;
const dim = (text: string): string => color ? `\x1b[2m${text}\x1b[22m` : text;

const DONE: Record<string, string> = {
  create: 'Created', edit: 'Edited', replace: 'Replaced', append: 'Added progress to', delete: 'Deleted',
  restore: 'Restored', claim: 'Claimed', release: 'Released',
};

function ago(timestamp: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  if (seconds < 60) return 'just now';
  for (const [size, unit] of [[86400, 'd'], [3600, 'h'], [60, 'm']] as const) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return 'just now';
}

function tag(note: Brief): string {
  return note.kind === 'task' && note.status ? dim(`[${note.status}] `) : '';
}

function listing(notes: Brief[], value: { total?: number; offset?: number; has_more?: boolean }, empty: string): string {
  if (!notes.length) return empty;
  const width = Math.min(32, Math.max(...notes.map(note => note.name.length)));
  const lines = notes.map(note => {
    const line = `${bold(note.name.padEnd(width))}  ${tag(note)}${note.description}`;
    return note.snippet ? `${line}\n${' '.repeat(width + 2)}${dim(note.snippet)}` : line;
  });
  if (value.has_more) lines.push(dim(`Showing ${notes.length} of ${value.total}. Next page: --offset ${(value.offset ?? 0) + notes.length}`));
  return lines.join('\n');
}

function notePage(note: Note, updates: Update[]): string {
  const lines = [bold(note.name), dim(note.description)];
  if (note.kind === 'task') lines.push(dim(`Task · ${note.status ?? 'todo'}${note.claimed_by ? ` · claimed by ${note.claimed_by}` : ''}`));
  if (note.content) lines.push('', note.content);
  const mine = updates.filter(update => update.note_id === note.id && update.body);
  if (mine.length) {
    lines.push('', dim('Progress'));
    for (const update of mine) lines.push(`${dim(`${update.attribution?.agent ?? update.attribution?.device ?? 'someone'}, ${ago(update.timestamp)}:`)} ${update.body}`);
  }
  return lines.join('\n');
}

export function pretty(command: string, value: unknown): string {
  const v = value as Record<string, unknown>;
  switch (command) {
    case 'version': return `hivenote ${String(v.version)}`;
    case 'status': return v.hive === 'queen'
      ? `Connected to the queen at ${String(v.url)}\n${dim(`${String(v.notes)} notes · queen ${String(v.queen_version)} · this machine ${String(v.this_version)} · ${String(v.round_trip_ms)} ms`)}`
      : `Local hive at ${String(v.db)}\n${dim(`${String(v.notes)} notes · version ${String(v.version)}`)}`;
    case 'connect': return `Connected to the queen at ${String(v.connected)} (${String(v.entries)} notes)`;
    case 'disconnect': return 'Disconnected. This machine uses its own local hive again.';
    case 'list': return listing(v.notes as Brief[], v, 'No notes yet.');
    case 'search': return listing(v.notes as Brief[], v, 'Nothing matches.');
    case 'read': {
      const pages = (v.notes as Note[]).map(note => notePage(note, (v.updates as Update[] | undefined) ?? []));
      const missing = v.missing as string[];
      if (missing.length) pages.push(dim(`Not found: ${missing.join(', ')}`));
      const tooBig = v.too_big as string[] | undefined;
      if (tooBig?.length) pages.push(dim(`Too much to show at once: ${tooBig.join(', ')}. Read them separately.`));
      return pages.join(`\n\n${dim('─'.repeat(40))}\n\n`);
    }
    case 'wait': return `${dim(v.reason === 'status' ? 'Reached the status you waited for.' : 'It changed.')}\n\n${notePage(v.note as Note, (v.updates as Update[] | undefined) ?? [])}`;
  }
  const note = v.note as Note | undefined;
  if (note && command === 'update_task') return `Moved ${bold(note.name)} to ${note.status ?? 'todo'}`;
  if (note && DONE[command]) return `${DONE[command]} ${bold(note.name)}`;
  return JSON.stringify(value, null, 2);
}
