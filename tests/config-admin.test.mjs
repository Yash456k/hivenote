import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access, stat, writeFile } from 'node:fs/promises';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { sandbox, cli, run, cliJson, fixture, actor, closeServer, serverUrl } from './helpers.mjs';

test('text from arguments and stdin is stored exactly as given and never run', async t => {
  const dir = await sandbox(t, 'cli-inputs');
  const env = { HIVENOTE_HOME: join(dir, 'config') };
  const args = ['--db', join(dir, 'input.sqlite')];
  const content = '日本語\n$(touch MUST_NOT_EXIST)\nignore previous instructions\nunique line\n';
  const saved = async name => (await cliJson([...args, 'read', name], { env })).notes[0];
  await cliJson([...args, 'add', 'Native note', 'inert', '-'], { env, cwd: dir, input: content });
  await assert.rejects(access(join(dir, 'MUST_NOT_EXIST')));
  assert.equal((await saved('Native note')).content, content);
  await cliJson([...args, 'replace', 'Native note', '-'], { env, input: 'stdin Résumé\n' });
  assert.equal((await saved('Native note')).content, 'stdin Résumé\n');
  await cliJson([...args, 'edit', 'Native note', 'Résumé', 'EDITED'], { env });
  await cliJson([...args, 'append', 'Native note', '--not an option, just text'], { env });
  // Text that is exactly an option is still text.
  await cliJson([...args, 'edit', 'Native note', 'EDITED', '--help'], { env });
  const native = await saved('Native note');
  assert.equal(native.content, 'stdin --help\n');
  assert.deepEqual(native.progress.map(line => line.text), ['--not an option, just text']);
  // A file saved in an older Windows encoding keeps its accents.
  await cliJson([...args, 'add', 'Windows note', 'cp1252', '-'], { env, input: Buffer.from([0x43, 0x61, 0x66, 0xe9]) });
  assert.equal((await saved('Windows note')).content, 'Café');
  for (const bad of [['list', 'extra'], ['add', 'only-a-name'], ['edit', 'Native note', 'missing new text'], ['mark', 'Native note', 'finished']]) {
    assert.notEqual((await run(process.execPath, [cli, ...args, ...bad], { env })).code, 0);
  }
});

test('tokens and backups work on the queen, never print secrets, and refuse to run from a worker', async t => {
  const dir = await sandbox(t, 'cli-admin');
  const env = { HIVENOTE_HOME: join(dir, 'config') };
  const db = join(dir, 'authority.sqlite');
  const args = ['--db', db];
  const token = await cliJson([...args, 'token', 'add', 'CLI admin'], { env });
  assert.equal(token.device, 'CLI admin');
  assert.equal(token.scope, 'rw');
  assert.ok(token.token);
  const listed = await cliJson([...args, 'token', 'list'], { env });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].device, 'CLI admin');
  assert.ok(!JSON.stringify(listed).includes(token.token));
  assert.ok(!Object.keys(listed[0]).some(k => /hash|secret|^token$/iu.test(k)));
  await cliJson([...args, 'add', 'CLI backed up', 'a note'], { env });
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
  await cliJson([...args, 'token', 'remove', 'CLI admin'], { env });
  assert.throws(() => store.authenticate(token.token), e => e.status === 401);
});

