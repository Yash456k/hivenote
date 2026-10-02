import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { detectAgent, isSupportedNode, MINIMUM_NODE } from '../dist/runtime.js';
import { spawn } from 'node:child_process';
import { cli, cliJson, fixture, run, sandbox } from './helpers.mjs';

test('list and search return brief entries by default and full summaries on request', async t => {
  const dir = await sandbox(t, 'brief');
  const store = new SqliteStore(join(dir, 'notes.db'));
  t.after(() => store.close());
  await store.call('create', fixture({ name: 'design', description: 'Current design decisions', content: 'needle' }));
  await store.call('create', { name: 'ship', description: 'Release checklist', content: 'needle', kind: 'task' });

  const brief = await store.call('list');
  const note = brief.notes.find(entry => entry.name === 'design');
  assert.deepEqual(Object.keys(note).sort(), ['description', 'id', 'kind', 'name', 'updated_at']);
  const task = brief.notes.find(entry => entry.name === 'ship');
  assert.equal(task.status, 'todo');
  assert.ok(!Object.hasOwn(task, 'due_at'), 'unset task fields are omitted');

  const full = await store.call('list', { detail: 'full' });
  assert.ok(Object.hasOwn(full.notes[0], 'last_attribution'));
  assert.ok(!Object.hasOwn(full.notes[0], 'content'));

  const found = await store.call('search', { query: 'needle' });
  assert.equal(found.total, 2);
  assert.equal(typeof found.notes[0].snippet, 'string');
  assert.ok(!Object.hasOwn(found.notes[0], 'last_attribution'));

  await assert.rejects(store.call('list', { detail: 'everything' }), error => error.code === 'validation_error');
});

test('CLI list --full switches to full summaries', async t => {
  const db = join(await sandbox(t, 'cli-full'), 'notes.db');
  await cliJson(['--db', db, 'create', 'context', '--description', 'Shared context']);
  const brief = await cliJson(['--db', db, 'list']);
  const full = await cliJson(['--db', db, 'list', '--full']);
  assert.ok(!Object.hasOwn(brief.notes[0], 'rev'));
  assert.equal(full.notes[0].rev, 1);
});

test('Node version floor is 22.16 because earlier SQLite builds lack full-text search', () => {
  assert.equal(MINIMUM_NODE, '22.16.0');
  for (const version of ['22.16.0', 'v22.23.3', '24.0.0', '26.1.0']) assert.ok(isSupportedNode(version), version);
  for (const version of ['20.20.1', '22.12.0', '22.15.9', 'v18.0.0']) assert.ok(!isSupportedNode(version), version);
});

test('local CLI commands print no SQLite experimental warning', async t => {
  const db = join(await sandbox(t, 'quiet'), 'notes.db');
  const result = await run(process.execPath, [cli, '--db', db, 'list']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
});

test('wait wakes when another process marks a task done, and shows its progress', async t => {
  const db = join(await sandbox(t, 'wait'), 'notes.db');
  const created = await cliJson(['--db', db, 'create', 'build-api', '--kind', 'task', '--description', 'Build the API']);
  const waiting = run(process.execPath, [cli, '--db', db, 'wait', '--name', 'build-api', '--status', 'done', '--interval-ms', '100', '--timeout-seconds', '30']);
  await new Promise(resolve => setTimeout(resolve, 500));
  await cliJson(['--db', db, 'append', created.note.id, '--body', 'endpoints done']);
  await cliJson(['--db', db, 'update-task', created.note.id, '--base-rev', '1', '--status', 'done']);

  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  const woke = JSON.parse(result.stdout);
  assert.equal(woke.reason, 'status');
  assert.equal(woke.note.status, 'done');
  assert.deepEqual(woke.updates.map(update => update.body), ['endpoints done']);
});

test('wait without --status wakes on any change, including an append', async t => {
  const db = join(await sandbox(t, 'wait-change'), 'notes.db');
  const created = await cliJson(['--db', db, 'create', 'notes', '--description', 'Scratch']);
  const waiting = run(process.execPath, [cli, '--db', db, 'wait', '--id', created.note.id, '--interval-ms', '100', '--timeout-seconds', '30']);
  await new Promise(resolve => setTimeout(resolve, 500));
  await cliJson(['--db', db, 'append', created.note.id, '--body', 'ping']);
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'changed');
});

test('wait returns at once when the status already matches, and fails clearly otherwise', async t => {
  const db = join(await sandbox(t, 'wait-edges'), 'notes.db');
  const task = await cliJson(['--db', db, 'create', 'done-already', '--kind', 'task', '--status', 'done']);
  await cliJson(['--db', db, 'create', 'plain', '--description', 'not a task']);

  const immediate = await cliJson(['--db', db, 'wait', '--id', task.note.id, '--status', 'done']);
  assert.equal(immediate.waited_ms, 0);

  const expectError = async (args, code) => {
    const result = await run(process.execPath, [cli, '--db', db, 'wait', ...args]);
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stderr).error.code, code);
  };
  await expectError(['--name', 'plain', '--timeout-seconds', '1', '--interval-ms', '100'], 'timeout');
  await expectError(['--name', 'missing', '--timeout-seconds', '1'], 'not_found');
  await expectError(['--name', 'plain', '--status', 'done'], 'validation_error');
  await expectError(['--name', 'plain', '--id', task.note.id], 'invalid_args');
  await expectError(['--name', 'plain', '--status', 'finished'], 'invalid_args');
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

test('hivenote ui serves the dashboard and lets this machine read without a token, never write', async t => {
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

  const call = (method, params, headers = {}) => fetch(new URL('/v1/call', dashboard), {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method, params }),
  });
  const listed = await (await call('list', {})).json();
  assert.equal(listed.result.notes[0].name, 'context');
  const recent = await (await call('changes', { tail: 5 })).json();
  assert.equal(recent.result.events.length, 1);
  assert.equal((await call('create', { name: 'nope', description: '', content: '' })).status, 403);
  // Anything relayed by a proxy or tunnel still needs a token.
  assert.equal((await call('list', {}, { 'x-forwarded-for': '203.0.113.9' })).status, 401);
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
