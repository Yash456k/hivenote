import { readFileSync } from 'node:fs';
import { clientParams, HiveNoteError, type Method, type Params } from './contract.js';
import { flag, integerFlag, jsonFlag, type Flags } from './args.js';
import { WAIT_DEFAULTS, type TaskStatus, type WaitOptions } from './wait.js';
import { UUID } from './validate.js';

/** Turning command-line flags into the parameters each method takes. */

let stdin: string | undefined;

function readTextFile(path: string): string {
  try {
    // '-' means stdin; read it once even if several flags use it.
    if (path === '-') return stdin ??= readFileSync(0, 'utf8');
    return readFileSync(path, 'utf8');
  } catch {
    throw new HiveNoteError('invalid_args', 'Cannot read input file');
  }
}

/** --content TEXT or --content-file PATH (never both). */
function textFlag(flags: Flags, key: string): string | undefined {
  const inline = flag(flags, key);
  const file = flag(flags, `${key}-file`);
  if (inline !== undefined && file !== undefined) throw new HiveNoteError('invalid_args', `--${key} and --${key}-file are mutually exclusive`);
  return file === undefined ? inline : readTextFile(file);
}

export function parameters(method: Method, flags: Flags, positional: string[]): Params {
  const raw = flag(flags, 'params');
  const input = raw === undefined ? {} : jsonFlag(raw, '--params');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HiveNoteError('invalid_args', '--params must be a JSON object');
  const params: Params = { ...input };
  const set = (key: string, value: unknown): void => {
    if (Object.hasOwn(params, key)) throw new HiveNoteError('invalid_args', `Supply ${key} only once, via --params or native arguments`);
    params[key] = value;
  };

  // --name is only replace's rename; the note itself is always the positional name.
  const strings = ['name', 'description', 'query', 'kind', 'status'];
  for (const key of strings) if (flag(flags, key) !== undefined) set(key, flag(flags, key));
  for (const key of ['base-rev', 'rev', 'offset', 'limit', 'since', 'ttl-seconds', 'tail']) {
    const value = flag(flags, key);
    if (value !== undefined) set(key.replaceAll('-', '_'), integerFlag(value, `--${key}`));
  }
  if (flags.has('force')) set('force', flag(flags, 'force') === 'true');
  if (flag(flags, 'full') === 'true') set('detail', 'full');
  if (flags.has('due-at')) set('due_at', flag(flags, 'due-at') === 'null' ? null : flag(flags, 'due-at'));
  if (flags.has('metadata')) set('metadata', jsonFlag(flag(flags, 'metadata')!, '--metadata'));
  if (flags.has('op-id')) set('op_id', flag(flags, 'op-id'));

  // Notes are always named by the positional arguments: `read a b`, `append a`, `create a`.
  if (method === 'read') {
    if (positional.length) set('names', positional);
    else if (!Object.hasOwn(params, 'names') && !Object.hasOwn(params, 'ids')) throw new HiveNoteError('invalid_args', 'read takes one or more note names: hivenote read NAME...');
  } else if (positional.length) {
    if (positional.length > 1 && method !== 'search') throw new HiveNoteError('invalid_args', 'Unexpected extra arguments; quote text that has spaces');
    const key = method === 'create' ? 'name' : method === 'search' ? 'query' : 'note';
    set(key, method === 'search' ? positional.join(' ') : positional[0]);
  }

  const content = textFlag(flags, 'content');
  const body = textFlag(flags, 'body');
  if (method === 'edit') {
    const old = textFlag(flags, 'old-str');
    const replacement = textFlag(flags, 'new-str');
    if (old !== undefined) set('old_str', old);
    const choices = [replacement, content, body].filter(value => value !== undefined);
    if (choices.length > 1) throw new HiveNoteError('invalid_args', 'Choose one replacement text option');
    if (choices.length) set('new_str', choices[0]);
  } else if (method === 'append') {
    if (content !== undefined && body !== undefined) throw new HiveNoteError('invalid_args', 'Choose --body or --content, not both');
    if (body !== undefined || content !== undefined) set('body', body ?? content);
  } else if (method === 'create' || method === 'replace') {
    if (content !== undefined && body !== undefined) throw new HiveNoteError('invalid_args', 'Choose --content or --body, not both');
    if (content !== undefined || body !== undefined) set('content', content ?? body);
    if (method === 'create') {
      if (!Object.hasOwn(params, 'description')) params.description = '';
      if (!Object.hasOwn(params, 'content')) params.content = '';
    }
  }
  if ((method === 'replace' || method === 'delete' || method === 'restore') && !Object.hasOwn(params, 'base_rev')) {
    throw new HiveNoteError('invalid_args', `${method} needs --base-rev N, the note's current rev (shown by hivenote read), so it can't undo changes you haven't seen`);
  }
  return clientParams(method, params);
}

const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled'];

export function waitOptions(flags: Flags, positional: string[]): WaitOptions {
  if (positional.length !== 1) throw new HiveNoteError('invalid_args', 'wait takes one note name: hivenote wait NAME [--status done]');
  const name = positional[0]!;

  const status = flag(flags, 'status');
  if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) {
    throw new HiveNoteError('invalid_args', `--status must be one of ${TASK_STATUSES.join(', ')}`);
  }

  const timeoutSeconds = flags.has('timeout-seconds') ? integerFlag(flag(flags, 'timeout-seconds')!, '--timeout-seconds') : WAIT_DEFAULTS.timeoutSeconds;
  if (timeoutSeconds < 0) throw new HiveNoteError('invalid_args', '--timeout-seconds must be 0 (forever) or more');

  // How often to check: --interval-seconds for people and agents, --interval-ms for fine control.
  if (flags.has('interval-seconds') && flags.has('interval-ms')) throw new HiveNoteError('invalid_args', 'Use --interval-seconds or --interval-ms, not both');
  let intervalMs: number = WAIT_DEFAULTS.intervalMs;
  if (flags.has('interval-seconds')) {
    const seconds = integerFlag(flag(flags, 'interval-seconds')!, '--interval-seconds');
    if (seconds < 1 || seconds > 600) throw new HiveNoteError('invalid_args', '--interval-seconds must be between 1 and 600');
    intervalMs = seconds * 1000;
  } else if (flags.has('interval-ms')) {
    intervalMs = integerFlag(flag(flags, 'interval-ms')!, '--interval-ms');
    if (intervalMs < 100 || intervalMs > 600_000) throw new HiveNoteError('invalid_args', '--interval-ms must be between 100 and 600000');
  }

  return {
    name,
    ...(status !== undefined ? { status: status as TaskStatus } : {}),
    timeoutSeconds,
    intervalMs,
  };
}
