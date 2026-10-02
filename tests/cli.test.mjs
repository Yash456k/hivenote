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
  const created = await hive('add', name, 'A note', 'alpha unique beta');
  assert.equal(created.note.rev, 1);
  assert.equal((await hive('list')).total, 1);
  assert.equal((await hive('read', name)).notes[0].content, 'alpha unique beta');
  assert.equal((await hive('search', 'unique')).total, 1);
  assert.equal((await hive('edit', name, 'unique', 'edited')).note.content, 'alpha edited beta');
  assert.equal((await hive('append', name, 'CLI activity')).note.rev, 2);
  assert.equal((await hive('replace', name, 'replacement')).note.rev, 3);
  assert.equal((await hive('describe', name, 'A better description')).note.description, 'A better description');
  assert.equal((await hive('delete', name)).note.rev, 5);
  // A deleted note is still found by name to look back at or bring back.
  assert.equal((await hive('history', name)).total, 6);
  assert.equal((await hive('restore', name, '1')).note.content, 'alpha unique beta');
  await hive('task', 'CLI task', 'Do the thing');
  assert.equal((await hive('mark', 'CLI task', 'doing')).note.status, 'doing');
  const board = await hive('tasks');
  assert.equal(board.notes[0].status, 'doing');
  assert.ok(board.notes[0].updated_by, 'the board shows who is on the task');
  assert.equal((await hive('mark', 'CLI task', 'done')).note.status, 'done');
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
  const forbidden = await run(process.execPath, [cli, '--url', url, 'add', 'not-allowed', 'nope'], { env: { ...env, HIVENOTE_TOKEN: ro.token } });
  assert.notEqual(forbidden.code, 0);
  const conflictingMode = await run(process.execPath, [cli, '--url', url, '--db', join(dir, 'must not exist.sqlite'), 'list'], { env });
  assert.notEqual(conflictingMode.code, 0);
  await assert.rejects(access(join(dir, 'must not exist.sqlite')));
  store.tokenRevoke(token.device);
  const revoked = await run(process.execPath, [cli, '--url', url, 'list'], { env });
  assert.notEqual(revoked.code, 0);
});
