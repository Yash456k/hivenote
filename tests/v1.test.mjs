import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { detectAgent, isSupportedNode, MINIMUM_NODE } from '../dist/runtime.js';
import { spawn } from 'node:child_process';
import { cli, cliJson, fixture, run, sandbox } from './helpers.mjs';

test('local CLI commands print no SQLite experimental warning', async t => {
  const db = join(await sandbox(t, 'quiet'), 'notes.db');
  const result = await run(process.execPath, [cli, '--db', db, 'list']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
});

test('wait wakes when another process marks a task done, and shows its progress', async t => {
  const db = join(await sandbox(t, 'wait'), 'notes.db');
  await cliJson(['--db', db, 'create', 'build-api', '--kind', 'task', '--description', 'Build the API']);
  const waiting = run(process.execPath, [cli, '--db', db, 'wait', 'build-api', '--status', 'done', '--interval-ms', '100', '--timeout-seconds', '30']);
  await new Promise(resolve => setTimeout(resolve, 500));
  await cliJson(['--db', db, 'append', 'build-api', '--body', 'endpoints done']);
  await cliJson(['--db', db, 'update-task', 'build-api', '--status', 'done']);

  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  const woke = JSON.parse(result.stdout);
  assert.equal(woke.reason, 'status');
  assert.equal(woke.note.status, 'done');
  assert.deepEqual(woke.updates.map(update => update.body), ['endpoints done']);
});

test('edits and replacements that change nothing are rejected instead of creating revisions', async t => {
  const dir = await sandbox(t, 'noop');
  const store = new SqliteStore(join(dir, 'notes.db'));
  t.after(() => store.close());
  const { note } = await store.call('create', fixture({ content: 'fix pending' }));
  await assert.rejects(store.call('edit', { id: note.id, old_str: 'x', new_str: 'x' }), error => error.code === 'validation_error');
  await assert.rejects(store.call('replace', { id: note.id, base_rev: 1, content: 'fix pending' }), error => error.code === 'validation_error');
  const [current] = (await store.call('read', { ids: [note.id] })).notes;
  assert.equal(current.rev, 1);
});

test('hivenote ui serves the dashboard; only the page it opened can read, and never write', async t => {
  const db = join(await sandbox(t, 'ui'), 'notes.db');
  await cliJson(['--db', db, 'create', 'context', '--description', 'Shared context']);
  const child = spawn(process.execPath, [cli, '--db', db, 'ui', '--no-open', '--port', '0']);
  t.after(() => child.kill());
  const { dashboard } = await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(JSON.parse(String(chunk))));
    child.once('exit', code => reject(new Error(`ui exited with ${code}`)));
  });
  const page = await fetch(dashboard);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/u);
  assert.match(await page.text(), /HiveNote/u);

  const key = new URL(dashboard).hash.replace('#k=', '');
  const call = (method, params, headers = { authorization: `Bearer ${key}` }) => fetch(new URL('/v1/call', dashboard), {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method, params }),
  });
  const listed = await (await call('list', {})).json();
  assert.equal(listed.result.notes[0].name, 'context');
  const recent = await (await call('changes', { tail: 5 })).json();
  assert.equal(recent.result.events.length, 1);
  assert.equal((await call('create', { name: 'nope', description: '', content: '' })).status, 403);
  // Without the key nothing reads, even from this machine or through a proxy that hides itself.
  assert.equal((await call('list', {}, {})).status, 401);
  assert.equal((await call('list', {}, { 'x-real-ip': '203.0.113.9' })).status, 401);
});

test('hivenote connect checks the token, then every command uses the remote hive until disconnect', async t => {
  const dir = await sandbox(t, 'connect');
  const hive = join(dir, 'hive.db');
  const laptop = { HIVENOTE_HOME: join(dir, 'laptop') };
  await cliJson(['--db', hive, 'create', 'on-hive', '--description', 'Lives on the hive machine']);
  const { token } = await cliJson(['--db', hive, 'token', 'create', '--device', 'laptop', '--scope', 'rw']);
  const server = spawn(process.execPath, [cli, '--db', hive, 'serve', '--port', '0']);
  t.after(() => server.kill());
  const { listening } = await new Promise(resolve => server.stdout.once('data', chunk => resolve(JSON.parse(String(chunk)))));
  const url = `http://127.0.0.1:${listening.port}`;

  const refused = await run(process.execPath, [cli, 'connect', url], { env: laptop, input: 'wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' });
  assert.notEqual(refused.code, 0);
  assert.equal((await cliJson(['config', 'show'], { env: laptop })).url, undefined, 'nothing saved after a bad token');

  assert.equal((await cliJson(['connect', url], { env: laptop, input: token + '\n' })).connected, url);
  assert.deepEqual((await cliJson(['list'], { env: laptop })).notes.map(note => note.name), ['on-hive']);
  const status = await cliJson(['status'], { env: laptop });
  assert.equal(status.hive, 'queen');
  assert.equal(status.notes, 1);
  await cliJson(['disconnect'], { env: laptop });
  assert.equal((await cliJson(['list'], { env: laptop })).total, 0);
  assert.equal((await cliJson(['status'], { env: laptop })).hive, 'local');

  await cliJson(['connect', url], { env: laptop, input: token + '\n' });
  server.kill();
  await new Promise(resolve => server.once('exit', resolve));
  const down = await run(process.execPath, [cli, 'status'], { env: laptop });
  assert.notEqual(down.code, 0);
  assert.match(down.stderr, /Can't reach the queen/u);
});

test('writes are labeled with the agent running the command, innermost agent first', async t => {
  assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectAgent({ CLAUDECODE: '1', CODEX_CI: '1' }), 'codex', 'Codex started from Claude Code');
  assert.equal(detectAgent({ HERMES_SESSION_ID: 'x', CLAUDECODE: '1' }), 'hermes');
  assert.equal(detectAgent({}), undefined);
  const db = join(await sandbox(t, 'label'), 'notes.db');
  const created = await cliJson(['--db', db, 'create', 'labeled'], { env: { CODEX_CI: '1' } });
  assert.equal(created.note.last_attribution.agent, 'codex');
  const explicit = await cliJson(['--db', db, '--agent', 'me', 'create', 'explicit'], { env: { CODEX_CI: '1' } });
  assert.equal(explicit.note.last_attribution.agent, 'me');
});

test('commands take a note by name, update-task needs no revision, retries and kebab-case search work', async t => {
  const db = join(await sandbox(t, 'names'), 'notes.db');
  await cliJson(['--db', db, 'create', 'build-api', '--kind', 'task', '--description', 'Build the API']);
  await cliJson(['--db', db, 'claim', 'build-api']);
  await cliJson(['--db', db, 'append', 'build-api', '--body', 'Endpoint works']);
  const done = await cliJson(['--db', db, 'update-task', 'build-api', '--status', 'done', '--op-id', 'finish-1']);
  assert.equal(done.note.status, 'done');
  // Repeating a write with the same --op-id returns the first answer instead of failing.
  assert.equal((await cliJson(['--db', db, 'update-task', 'build-api', '--status', 'done', '--op-id', 'finish-1'])).note.rev, done.note.rev);
  // Plain words are searched as words, so kebab-case names are found.
  assert.equal((await cliJson(['--db', db, 'search', 'build-api'])).total, 1);
  const read = await cliJson(['--db', db, 'read', 'build-api']);
  assert.equal(read.updates[0].body, 'Endpoint works');
  const missing = await run(process.execPath, [cli, '--db', db, 'append', 'nope', '--body', 'x']);
  assert.match(missing.stderr, /No note named 'nope'/u);
});

test('a worker keeps waiting when the queen restarts mid-wait', async t => {
  const dir = await sandbox(t, 'wait-restart');
  const hive = join(dir, 'hive.db');
  await cliJson(['--db', hive, 'create', 'ship-it', '--kind', 'task']);
  const { token } = await cliJson(['--db', hive, 'token', 'create', '--device', 'worker']);
  const serve = port => spawn(process.execPath, [cli, '--db', hive, 'serve', '--port', String(port)]);
  const listening = child => new Promise(resolve => child.stdout.once('data', chunk => resolve(JSON.parse(String(chunk)).listening.port)));
  let queen = serve(0);
  const port = await listening(queen);
  t.after(() => queen.kill());
  const env = { HIVENOTE_TOKEN: token };
  const waiting = run(process.execPath, [cli, '--url', `http://127.0.0.1:${port}`, 'wait', 'ship-it', '--status', 'done', '--interval-ms', '200', '--timeout-seconds', '30'], { env });
  await new Promise(resolve => setTimeout(resolve, 600));
  queen.kill();
  await new Promise(resolve => queen.once('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 1500));
  queen = serve(port);
  await listening(queen);
  await cliJson(['--db', hive, 'update-task', 'ship-it', '--status', 'done']);
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).note.status, 'done');
});
