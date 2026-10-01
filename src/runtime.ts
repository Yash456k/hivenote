import { HiveNoteError } from './contract.js';

/**
 * The oldest Node release whose built-in SQLite includes full-text search (FTS5).
 * Node 22.12 hides node:sqlite behind a flag, and 22.13–22.15 ship it without FTS5,
 * so HiveNote cannot create its search index there.
 */
export const MINIMUM_NODE = '22.16.0';

function parts(version: string): number[] {
  return version.replace(/^v/u, '').split('.').map(part => Number.parseInt(part, 10) || 0);
}

export function isSupportedNode(version: string): boolean {
  const current = parts(version);
  const minimum = parts(MINIMUM_NODE);
  for (let i = 0; i < minimum.length; i++) {
    if ((current[i] ?? 0) !== minimum[i]) return (current[i] ?? 0) > minimum[i]!;
  }
  return true;
}

export function assertSupportedNode(version = process.versions.node): void {
  if (!isSupportedNode(version)) {
    throw new HiveNoteError('unsupported_node', `HiveNote needs Node ${MINIMUM_NODE} or newer for its built-in SQLite; this is Node ${version}.`, 500);
  }
}

let quieted = false;

/**
 * Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" whenever
 * node:sqlite loads. Agents run HiveNote constantly, so drop that one warning and
 * let every other warning through.
 */
export function quietSqliteWarning(): void {
  if (quieted) return;
  quieted = true;
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.startsWith('SQLite is an experimental feature')) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

/**
 * Which agent is running this command, from the markers agents set for the shell
 * commands they run. Innermost first: an agent started from inside another one
 * inherits the outer agent's markers. Like --agent, this is a self-reported label.
 */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERMES_SESSION_ID || env.HERMES_AGENT) return 'hermes';
  if (env.CODEX_CI || env.CODEX_PERMISSION_PROFILE || env.CODEX_SANDBOX) return 'codex';
  if (env.CLAUDECODE) return 'claude-code';
  return undefined;
}
