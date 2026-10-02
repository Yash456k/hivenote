import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { sandbox, fixture, cliJson, run, cli, actor, closeServer, serverUrl, root } from './helpers.mjs';

async function exercise(args, env) {
  const hive = (...rest) => cliJson([...args, ...rest], { env });
  const name = 'CLI Résumé 日本語';
  const created = await hive('create', name, '--description', 'A note', '--content', 'alpha unique beta');
  assert.equal(created.note.rev, 1);
  assert.equal((await hive('list')).total, 1);
  assert.equal((await hive('read', name)).notes[0].content, 'alpha unique beta');
  assert.equal((await hive('search', 'unique')).total, 1);
  assert.equal((await hive('edit', name, '--old-str', 'unique', '--new-str', 'edited')).note.content, 'alpha edited beta');
  assert.equal((await hive('append', name, '--body', 'CLI activity')).note.rev, 2);
  assert.equal((await hive('replace', name, '--content', 'replacement', '--base-rev', '2')).note.rev, 3);
  assert.equal((await hive('revision', name, '--rev', '1')).note.content, 'alpha unique beta');
  assert.equal((await hive('history', name)).total, 4);
  const stale = await run(process.execPath, [cli, ...args, 'replace', name, '--content', 'stale', '--base-rev', '1'], { env });
  assert.notEqual(stale.code, 0);
  assert.match(`${stale.stderr}\n${stale.stdout}`, /conflict|revision|409/iu);
  assert.equal((await hive('delete', name, '--base-rev', '3')).note.rev, 4);
  // A deleted note is still found by name to look back at or restore.
  assert.equal((await hive('history', name)).total, 5);
  assert.equal((await hive('restore', name, '--rev', '1', '--base-rev', '4')).note.rev, 5);
  await hive('create', 'CLI task', '--kind', 'task');
  assert.ok((await hive('claim', 'CLI task')).note.claimed_by);
  assert.equal((await hive('release', 'CLI task')).note.claimed_by, null);
  assert.equal((await hive('update-task', 'CLI task', '--status', 'done')).note.status, 'done');
  assert.equal((await hive('changes', '--since', '0', '--limit', '100')).events.length, 10);
  return created;
}

test('real local CLI subprocesses implement every operation, errors and paths with spaces/non-ASCII', { timeout: 120_000 }, async t => {
  const dir = await sandbox(t, 'cli-local');
  const db = join(dir, 'notes with spaces 日本語.sqlite');
  const env = { HIVENOTE_HOME: join(dir, 'isolated config') };
  const help = await run(process.execPath, [cli, '--help'], { env });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /hivenote|usage/iu);
  const version = await run(process.execPath, [cli, '--version'], { env });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  await exercise(['--db', db], env);
  await access(db);
});

test('real remote CLI subprocesses use authenticated HTTP and never create a local database', { timeout: 120_000 }, async t => {
  const dir = await sandbox(t, 'cli-remote');
  const store = new SqliteStore(join(dir, 'authority.sqlite'), actor());
  const token = store.tokenCreate('cli-device', 'rw');
  const ro = store.tokenCreate('reader', 'ro');
  const server = await startServer(store, { host: '127.0.0.1', port: 0 });
  t.after(async () => { await closeServer(server); store.close(); });
  const url = serverUrl(server);
  const configHome = join(dir, 'remote config');
  const env = { HIVENOTE_HOME: configHome, HIVENOTE_TOKEN: token.token };
  const created = await exercise(['--url', url], env);
  assert.equal(created.note.last_attribution.principal, token.principal);
  assert.equal(created.note.last_attribution.verified, true);
  await assert.rejects(access(join(configHome, 'data.db')));
  const missing = await run(process.execPath, [cli, '--url', url, 'list'], { env: { ...env, HIVENOTE_TOKEN: '' } });
  assert.notEqual(missing.code, 0);
  const forbidden = await run(process.execPath, [cli, '--url', url, 'create', 'not-allowed'], { env: { ...env, HIVENOTE_TOKEN: ro.token } });
  assert.notEqual(forbidden.code, 0);
  const conflictingMode = await run(process.execPath, [cli, '--url', url, '--db', join(dir, 'must not exist.sqlite'), 'list'], { env });
  assert.notEqual(conflictingMode.code, 0);
  await assert.rejects(access(join(dir, 'must not exist.sqlite')));
  store.tokenRevoke(token.device);
  const revoked = await run(process.execPath, [cli, '--url', url, 'list'], { env });
  assert.notEqual(revoked.code, 0);
});
