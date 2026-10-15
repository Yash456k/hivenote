import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { byline, HiveNoteError, type Event, type Method, type Note, type Params } from './contract.js';
import { HttpStore, queenTooOld } from './client.js';
import { describe, reachQueen, send, type Report } from './merge.js';
import { configDirectory } from './config.js';
import { keepAliveFetch } from './helper.js';
import { assertSupportedNode, quietSqliteWarning } from './runtime.js';
import type { SqliteStore } from './sqlite.js';

/**
 * A standby copy of the queen's hive, and the temporary queen that serves it while she is down.
 *
 * `hivenote standby` keeps the copy on a worker by following the queen's feed of changes: each change comes with
 * the note as it then was, under the queen's own numbers, ids and versions. Her tokens are copied too (only their
 * hashes, and only for a standby token), so every worker's token works against the copy.
 *
 * `hivenote serve standby` serves the copy and records the queen's last change it had. The writes made on it keep
 * their answers, which say what was asked; `hivenote merge` sends them to the main queen when she is back, oldest
 * first, with their own op_ids, so a write she already has is never made twice. A change to a note she changed
 * meanwhile is reported and not sent, so nothing of hers is overwritten.
 */

export function standbyPath(): string { return join(configDirectory(), 'standby.db'); }
function statePath(): string { return join(configDirectory(), 'standby.json'); }

/** Which queen the copy is of; once it served, her last change it had, and the latest change merge has sent. */
interface State { queen: string; took_over?: number; merged?: number }

function readState(): State | undefined {
  try { return JSON.parse(readFileSync(statePath(), 'utf8')) as State; } catch { return undefined; }
}
function writeState(state: State): void {
  const temporary = `${statePath()}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
  renameSync(temporary, statePath());
}

async function openCopy(options: { keepReceipts?: boolean } = {}): Promise<SqliteStore> {
  assertSupportedNode();
  quietSqliteWarning();
  const { SqliteStore } = await import('./sqlite.js');
  return new SqliteStore(standbyPath(), undefined, options);
}

function pidPath(): string { return join(configDirectory(), 'standby.pid'); }
/** serve standby says which process serves the copy; the copy is in use while that process lives. A crash leaves a file whose process is gone. */
export function markServing(): void { writeFileSync(pidPath(), `${process.pid}\n`, { mode: 0o600 }); }
function inUse(): boolean {
  let pid: number;
  try { pid = Number(readFileSync(pidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Put the copy aside under a new name and start again; it is not deleted. */
function setAside(say: (line: string) => void, why: string): void {
  if (inUse()) throw new HiveNoteError('busy', 'The standby copy is being served (hivenote serve standby). Stop that first', 409);
  const kept = join(configDirectory(), `standby-${new Date().toISOString().replace(/[:.]/gu, '-')}.db`);
  renameSync(standbyPath(), kept);
  rmSync(`${standbyPath()}-shm`, { force: true });
  rmSync(statePath(), { force: true });
  say(`${why}, so a new copy is started. The old one is kept as ${kept}`);
}

/** The queen's tokens, hashes included. Only a standby token is given them. */
async function queenTokens(url: string, token: string): Promise<Record<string, unknown>[]> {
  let response: Response;
  try {
    response = await fetch(new URL('/v1/standby', url), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}', signal: AbortSignal.timeout(10000) });
  } catch { throw new HiveNoteError('transport_error', 'Unable to reach HiveNote server', 503); }
  const version = response.headers.get('x-hivenote-version');
  if (version && Number(version.split('.')[0]) < 1) { await response.body?.cancel(); throw queenTooOld(version); }
  const payload = await response.json().catch(() => undefined) as { result?: Record<string, unknown>[]; error?: { code?: string; message?: string } } | undefined;
  if (response.ok && Array.isArray(payload?.result)) return payload.result;
  if (!payload?.error && response.status >= 500) throw new HiveNoteError('transport_error', 'Unable to reach HiveNote server', 503);
  throw new HiveNoteError(payload?.error?.code ?? 'http_error', payload?.error?.message ?? `Server returned HTTP ${response.status}`, response.status);
}

/**
 * `hivenote standby`: keep the copy current, until stopped. While the queen can't be reached it keeps trying,
 * and after a restart it carries on from the last change it has.
 */
export async function keepStandby(url: string, token: string, say: (line: string) => void, current: (value: object) => void): Promise<never> {
  const state = readState();
  if (state?.took_over !== undefined) {
    // It served as a temporary queen. Its writes must reach the main queen before it follows her again.
    const copy = await openCopy();
    const { latest, after } = copy.changeCount(state.took_over);
    copy.close();
    if (inUse()) throw new HiveNoteError('busy', 'The standby copy is being served (hivenote serve standby). Stop that first', 409);
    if (after && state.merged !== latest) {
      throw new HiveNoteError('not_merged', `This machine's standby copy served as a temporary queen, and ${changes(after)} made on it ${after === 1 ? 'is' : 'are'} not merged. When the main queen is back, run hivenote merge ${state.queen} first`, 409);
    }
    if (after) setAside(say, 'The standby copy here served as a temporary queen and is merged');
    else writeState({ queen: url });
  }
  let copy = await openCopy();
  stopOnSignal(() => copy.close());
  const queen = new HttpStore(url, token, { fetch: keepAliveFetch() });
  let cursor = copy.changeCount().latest;
  let checked = false, tokensAt = 0, caughtUp = false, away = false;
  for (;;) {
    try {
      if (readState()?.took_over !== undefined) throw new HiveNoteError('serving', 'This copy is now served as a temporary queen (hivenote serve standby), so it stopped following the queen', 409);
      // Tokens first: asking for them is also how a queen too old to be followed is found out, before anything is kept.
      if (Date.now() - tokensAt > 60_000) { copy.copyTokens(await queenTokens(url, token)); tokensAt = Date.now(); }
      if (!checked) {
        // A copy of some other hive, or of one put back from an older backup, can't be carried on.
        const { events } = await queen.call('changes', { since: Math.max(cursor - 1, 0), limit: 1 }) as { events: Event[] };
        if (cursor && events[0]?.op_id !== copy.opIdAt(cursor)) {
          copy.close();
          setAside(say, `The standby copy here does not match the hive at ${url}`);
          copy = await openCopy();
          cursor = 0;
          tokensAt = 0;
          continue;
        }
        writeState({ queen: url });
        checked = true;
      }
      const page = await queen.call('changes', { since: cursor, limit: 100, ...(caughtUp ? { hold: 8000 } : {}) }) as { events: Event[]; has_more: boolean };
      cursor = copy.follow(page.events, cursor);
      if (away) say(`the queen at ${url} answers again`);
      away = false;
      if (!page.has_more && !caughtUp) current({ standby: url, copy: standbyPath(), seq: cursor });
      caughtUp = !page.has_more;
    } catch (error) {
      if (!(error instanceof HiveNoteError && (error.code === 'transport_error' || error.code === 'busy'))) { copy.close(); throw error; }
      if (!away) say(`can't reach the queen at ${url}. The copy has her changes up to ${cursor}. If she stays down, this machine can serve it: hivenote serve standby`);
      away = true;
      await sleep(3000);
    }
  }
}

function stopOnSignal(stop: () => void): void {
  const exit = (): void => { stop(); process.exit(0); };
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
}

/** Refuse to serve the copy while the main queen still answers: two queens at once split the hive. */
export async function refuseWhileUp(): Promise<void> {
  const state = readState();
  if (!state || state.took_over !== undefined) return;
  let up = false;
  try { up = (await (await fetch(new URL('/health', state.queen), { redirect: 'error', signal: AbortSignal.timeout(3000) })).json() as { ok?: boolean }).ok === true; } catch { /* down, as expected */ }
  if (up) throw new HiveNoteError('queen_is_up', `The queen at ${state.queen} still answers. Serving the copy now would make two queens, and the hive splits. If she is broken all the same: hivenote serve standby --anyway`, 409);
}

/** `hivenote serve standby`: the copy becomes a temporary queen. The queen's last change it had is recorded once. */
export async function takeOver(): Promise<{ queen: string; seq: number }> {
  const state = readState();
  if (!state || !existsSync(standbyPath())) throw new HiveNoteError('no_standby', 'There is no standby copy on this machine. Keep one while the queen is up: hivenote standby', 404);
  if (state.took_over !== undefined) return { queen: state.queen, seq: state.took_over };
  const copy = await openCopy();
  const seq = copy.changeCount().latest;
  copy.close();
  writeState({ ...state, took_over: seq });
  return { queen: state.queen, seq };
}

/** For status: this machine served as a temporary queen, and holds changes the main queen does not have yet. */
export async function temporaryQueen(): Promise<{ hive: 'temporary queen'; queen: string; copy: string; changes: number } | undefined> {
  const state = readState();
  if (state?.took_over === undefined || !existsSync(standbyPath())) return undefined;
  const copy = await openCopy();
  try {
    const { latest, after } = copy.changeCount(state.merged ?? state.took_over);
    if (state.merged === latest) return undefined;
    return { hive: 'temporary queen', queen: state.queen, copy: standbyPath(), changes: after };
  } finally { copy.close(); }
}

/** `hivenote merge MAIN`: send the writes made on the temporary queen to the main queen, oldest first. */
export async function merge(address: string, token: string): Promise<Report> {
  const state = readState();
  if (state?.took_over === undefined || !existsSync(standbyPath())) {
    throw new HiveNoteError('no_standby', 'This machine has not served as a temporary queen, so there is nothing to merge. To send the writes kept on this machine, run hivenote merge with no address', 404);
  }
  const tookOver = state.took_over;
  const url = await reachQueen(address);
  const copy = await openCopy();
  try {
    const { latest } = copy.changeCount();
    const outgoing = copy.writesMadeHere().map(write => ({
      ...forMain(write),
      note: { id: write.note.id },
      change: write.method === 'take' ? `take ${write.note.name}` : describe(write.method, write.params, write.note.name),
      by: byline(write.attribution),
      // Who made it, as a label: the main queen records it as unverified, not as this machine's own write.
      labels: { agent: byline(write.attribution).slice(0, 256), ...(write.attribution.session ? { session: write.attribution.session } : {}) },
      // The main queen's changes to the note that the copy has were seen; those it does not know were made meanwhile.
      skip: copy.changesOf(write.note.id, tookOver),
      meanwhile: (event: Event) => !copy.knows(event.op_id),
    }));
    const sent = await send(outgoing, labels => new HttpStore(url, token, { ...labels, quiet: true, relayed: true }), `hivenote merge ${url}`, () => {});
    writeState({ ...state, merged: latest });
    const left = sent.not_merged.length ? ` What was not merged is still in this machine's copy: HIVENOTE_DB=${standbyPath()} hivenote read NAME` : '';
    return {
      merged_into: url, ...sent,
      next: `Stop hivenote serve standby here. On every worker, run hivenote connect ${url} and press Enter to keep its token.${left}`,
    };
  } finally { copy.close(); }
}

/** A write as the main queen is sent it: by the note's id, which a rename on either side does not change. */
function forMain({ method, params, note }: { method: Method; params: Params; note: Note }): { method: Method; params: Params } {
  // take picked the task here; on the main queen it is a mark of that task.
  if (method === 'take') return { method: 'update_task', params: { id: note.id, status: 'doing', op_id: params.op_id } };
  if (method === 'create') return { method, params };
  // A claim is checked against the main queen's history instead, before the write is sent.
  const { note: _name, claim: _claim, ...rest } = params;
  return { method, params: { ...rest, id: note.id } };
}

const changes = (n: number): string => `${n} change${n === 1 ? '' : 's'}`;

