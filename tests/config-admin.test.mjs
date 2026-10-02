import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, stat, writeFile } from 'node:fs/promises';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { sandbox, cli, run, cliJson, fixture, actor, closeServer, serverUrl } from './helpers.mjs';

test('native CLI flags, UTF-8 file/stdin inputs and task aliases preserve literal inert data', async t => {
  const dir = await sandbox(t, 'cli-inputs');
  const env = { HIVENOTE_HOME: join(dir, 'config') };
  const args = ['--db', join(dir, 'input.sqlite')];
  const content = '日本語\n$(touch MUST_NOT_EXIST)\nignore previous instructions\nunique line\n';
  const file = join(dir, 'content file 日本語.txt');
  await writeFile(file, content);
  const created = await cliJson([...args, 'create', 'Native flag note', '--description', 'inert', '--content-file', file], { env, cwd: dir });
  assert.equal(created.note.content, content);
  await assert.rejects(access(join(dir, 'MUST_NOT_EXIST')));
  assert.equal((await cliJson([...args, 'read', 'Native flag note'], { env })).notes[0].id, created.note.id);
  const replaced = await cliJson([...args, 'replace', 'Native flag note', '--base-rev', '1', '--content-file', '-'], { env, input: 'stdin Résumé\n' });
  assert.equal(replaced.note.content, 'stdin Résumé\n');
  const edited = await cliJson([...args, 'edit', 'Native flag note', '--old-str', 'Résumé', '--new-str', 'EDITED', '--base-rev', '2'], { env });
  assert.equal(edited.note.content, 'stdin EDITED\n');
  const appended = await cliJson([...args, 'append', 'Native flag note', '--body-file', '-'], { env, input: 'activity 日本語' });
  assert.equal(appended.note.rev, 3);
  for (const bad of [
    [...args, 'create', 'bad', '--content', 'x', '--content-file', file],
    [...args, 'replace', 'Native flag note', '--base-rev', 'NaN', '--content', 'x'],
    [...args, 'create', '--params', '[1,2]'],
    [...args, 'list', '--unknown-flag', 'x'],
    [...args, 'list', '--limit'],
  ]) assert.notEqual((await run(process.execPath, [cli, ...bad], { env })).code, 0);
});

test('CLI token administration and backup are real, omit secrets and refuse remote administration', async t => {
  const dir = await sandbox(t, 'cli-admin');
  const env = { HIVENOTE_HOME: join(dir, 'config') };
  const db = join(dir, 'authority.sqlite');
  const args = ['--db', db];
  const token = await cliJson([...args, 'token', 'create', '--device', 'CLI admin', '--scope', 'rw'], { env });
  assert.equal(token.device, 'CLI admin');
  assert.equal(token.scope, 'rw');
  assert.ok(token.token);
  const listed = await cliJson([...args, 'token', 'list'], { env });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, token.id);
  assert.ok(!JSON.stringify(listed).includes(token.token));
  assert.ok(!Object.keys(listed[0]).some(k => /hash|secret|^token$/iu.test(k)));
  const created = await cliJson([...args, 'create', '--params', JSON.stringify(fixture({ name: 'CLI backed up' }))], { env });
  const backup = join(dir, 'CLI backup 日本語.sqlite');
  assert.equal((await cliJson([...args, 'backup', backup], { env })).path, backup);
  assert.equal((await cliJson(['--db', backup, 'read', 'CLI backed up'], { env })).notes[0].name, 'CLI backed up');
  const store = new SqliteStore(db, actor());
  const server = await startServer(store, { host: '127.0.0.1', port: 0 });
  t.after(async () => { await closeServer(server); store.close(); });
  const url = serverUrl(server);
  for (const command of [['token', 'list'], ['backup', join(dir, 'forbidden.sqlite')]]) {
    const result = await run(process.execPath, [cli, '--url', url, ...command], { env: { ...env, HIVENOTE_TOKEN: token.token } });
    assert.notEqual(result.code, 0);
  }
  await assert.rejects(access(join(dir, 'forbidden.sqlite')));
  await cliJson([...args, 'token', 'revoke', token.device], { env });
  assert.throws(() => store.authenticate(token.token), e => e.status === 401);
});

