import { HiveNoteError } from './contract.js';
import { queenTooOld, validateServerUrl } from './client.js';

/** Checks made before `hivenote merge` sends anything. */

/** The queen at this address answers, and is new enough. Nothing is sent otherwise. */
export async function reachQueen(address: string): Promise<string> {
  const url = validateServerUrl(address).origin;
  let health: { ok?: boolean; version?: string } | undefined;
  try {
    health = await (await fetch(new URL('/health', url), { redirect: 'error', signal: AbortSignal.timeout(10000) })).json() as typeof health;
  } catch { throw new HiveNoteError('queen_unreachable', `Can't reach the queen at ${url}. Nothing was sent`, 503); }
  if (health?.ok !== true) throw new HiveNoteError('not_a_queen', `${url} answered, but it isn't a HiveNote queen. Nothing was sent`, 502);
  if (!(Number(String(health.version ?? '0').split('.')[0]) >= 1)) throw queenTooOld(health.version);
  return url;
}

export const writes = (n: number): string => `${n} write${n === 1 ? '' : 's'}`;
