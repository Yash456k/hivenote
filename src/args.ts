import { HiveNoteError, isMethod, MUTATIONS, type Method } from './contract.js';

/** Reading command-line flags, and which flags each command accepts. */

export type Flags = Map<string, string[]>;
export interface Arguments { positional: string[]; flags: Flags }

const BOOLEAN_FLAGS = new Set(['help', 'version', 'json', 'force', 'full', 'no-open']);
const VALUE_FLAGS = [
  'db', 'url', 'token-file', 'agent', 'session', 'timeout-ms', 'retries', 'params', 'op-id',
  'id', 'ids', 'name', 'names', 'description', 'content', 'content-file', 'body', 'body-file',
  'old-str', 'old-str-file', 'new-str', 'new-str-file', 'base-rev', 'rev', 'query', 'offset', 'limit',
  'kind', 'status', 'due-at', 'metadata', 'since', 'ttl-seconds', 'device', 'scope', 'destination',
  'host', 'port', 'timeout-seconds', 'interval-seconds', 'interval-ms', 'tail',
];
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);
/** Flags that may repeat (read accepts several IDs or names). */
const REPEATABLE = ['id', 'ids', 'name', 'names'];
/** Flags every command accepts. */
const GLOBAL_FLAGS = ['db', 'url', 'token-file', 'agent', 'session', 'help', 'version', 'json'];

const TEXT_FLAGS = ['content', 'content-file', 'body', 'body-file'];
const METHOD_FLAGS: Record<Method, string[]> = {
  list: ['offset', 'limit', 'kind', 'status', 'full'],
  read: ['id', 'ids', 'name', 'names'],
  search: ['query', 'offset', 'limit', 'full'],
  create: ['id', 'name', 'description', 'kind', 'status', 'due-at', 'metadata', ...TEXT_FLAGS],
  edit: ['id', 'base-rev', 'old-str', 'old-str-file', 'new-str', 'new-str-file', ...TEXT_FLAGS],
  replace: ['id', 'base-rev', 'name', 'description', 'metadata', ...TEXT_FLAGS],
  append: ['id', ...TEXT_FLAGS],
  delete: ['id', 'base-rev'],
  history: ['id', 'offset', 'limit'],
  revision: ['id', 'rev'],
  restore: ['id', 'rev', 'base-rev'],
  changes: ['since', 'limit', 'tail'],
  claim: ['id', 'ttl-seconds', 'force', 'base-rev'],
  release: ['id', 'force', 'base-rev'],
  update_task: ['id', 'base-rev', 'status', 'due-at', 'metadata'],
};

function commandFlags(command: string, action: string | undefined): string[] {
  if (isMethod(command)) return [...METHOD_FLAGS[command], 'params', 'timeout-ms', 'retries', ...(MUTATIONS.has(command) ? ['op-id'] : [])];
  switch (command) {
    case 'token': return action === 'create' ? ['device', 'scope'] : action === 'revoke' ? ['id'] : [];
    case 'backup': return ['destination'];
    case 'serve': return ['host', 'port'];
    case 'ui': return ['host', 'port', 'no-open'];
    case 'mcp': return ['timeout-ms', 'retries'];
    case 'wait': return ['id', 'name', 'status', 'timeout-seconds', 'interval-seconds', 'interval-ms', 'timeout-ms', 'retries'];
    case 'config': case 'show': case 'connect': case 'disconnect': return [];
    default: throw new HiveNoteError('invalid_args', 'Unknown command');
  }
}

export function parse(argv: string[]): Arguments {
  const flags: Flags = new Map();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (argument === '-h') { flags.set('help', ['true']); continue; }
    if (!argument.startsWith('--')) { positional.push(argument); continue; }

    const equals = argument.indexOf('=');
    const key = argument.slice(2, equals === -1 ? undefined : equals);
    if (!KNOWN_FLAGS.has(key)) throw new HiveNoteError('invalid_args', `Unknown option --${key}`);
    let value: string;
    if (BOOLEAN_FLAGS.has(key)) {
      value = equals === -1 ? 'true' : argument.slice(equals + 1);
      if (value !== 'true' && value !== 'false') throw new HiveNoteError('invalid_args', `Option --${key} expects true or false`);
    } else if (equals !== -1) {
      value = argument.slice(equals + 1);
    } else {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new HiveNoteError('invalid_args', `Option --${key} requires a value`);
      value = next;
    }
    flags.set(key, [...flags.get(key) ?? [], value]);
  }
  for (const [key, values] of flags) {
    if (values.length > 1 && !REPEATABLE.includes(key)) throw new HiveNoteError('invalid_args', `Option --${key} may only be supplied once`);
  }
  return { flags, positional };
}

/** Reject flags the command does not take, and repeats outside read. */
export function validateFlags(command: string, action: string | undefined, flags: Flags): void {
  const allowed = new Set([...GLOBAL_FLAGS, ...commandFlags(command, action)]);
  for (const [key, values] of flags) {
    if (!allowed.has(key)) throw new HiveNoteError('invalid_args', `Option --${key} is not supported by ${command}`);
    if (values.length > 1 && !(command === 'read' && REPEATABLE.includes(key))) {
      throw new HiveNoteError('invalid_args', `Option --${key} may only be supplied once for ${command}`);
    }
  }
}

export function flag(flags: Flags, name: string): string | undefined {
  return flags.get(name)?.at(-1);
}

export function integerFlag(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new HiveNoteError('invalid_args', `${label} requires an integer`);
  return result;
}

export function jsonFlag(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw new HiveNoteError('invalid_args', `Invalid JSON for ${label}`); }
}
