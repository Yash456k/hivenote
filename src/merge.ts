import { HiveNoteError } from './contract.js';
import { validateServerUrl } from './client.js';

/** Checks made before `hivenote merge` sends anything. */

/**
 * The queen at this address answers. Nothing is sent otherwise. A queen before 1.0 takes kept notes and progress
 * (create and append by id, with their op_ids); only a note kept with --after needs 1.0, and is checked as it goes.
 */
export async function reachQueen(address: string): Promise<{ url: string; old: boolean; version?: string }> {
  const url = validateServerUrl(address).origin;
  let health: { ok?: boolean; version?: string } | undefined;
  try {
    health = await (await fetch(new URL('/health', url), { redirect: 'error', signal: AbortSignal.timeout(10000) })).json() as typeof health;
  } catch { throw new HiveNoteError('queen_unreachable', `Can't reach the queen at ${url}. Nothing was sent`, 503); }
  if (health?.ok !== true) throw new HiveNoteError('not_a_queen', `${url} answered, but it isn't a HiveNote queen. Nothing was sent`, 502);
  const old = !(Number(String(health.version ?? '0').split('.')[0]) >= 1);
  return { url, old, ...(health.version ? { version: health.version } : {}) };
}

export const writes = (n: number): string => `${n} write${n === 1 ? '' : 's'}`;
