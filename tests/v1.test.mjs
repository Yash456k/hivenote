import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { detectAgent, isSupportedNode, MINIMUM_NODE } from '../dist/runtime.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cli, cliJson, fixture, run, sandbox } from './helpers.mjs';

test('wait holds on for a note that does not exist yet, and wait with no name wakes on any change', async t => {
  const db = join(await sandbox(t, 'wait-new'), 'notes.db');
  await cliJson(['--db', db, 'add', 'old-note', 'here from the start']);
  const forNote = run(process.execPath, [cli, '--db', db, 'wait', 'api-notes']);
  const forAnything = run(process.execPath, [cli, '--db', db, 'wait']);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await cliJson(['--db', db, 'add', 'api-notes', 'the API']);

  const [note, anything] = await Promise.all([forNote, forAnything]);
  assert.equal(note.code, 0, note.stderr);
  assert.match(note.stderr, /waiting for it to be added/u);
  assert.equal(JSON.parse(note.stdout).reason, 'added');
  assert.deepEqual(JSON.parse(anything.stdout).changes.map(change => [change.note, change.kind]), [['api-notes', 'create']]);
});

test('wait holds on for as long as its last word says', async t => {
  const db = join(await sandbox(t, 'wait-limit'), 'notes.db');
  await cliJson(['--db', db, 'task', 'ship-it', 'Ship it']);
  const started = Date.now();
  const short = await run(process.execPath, [cli, '--db', db, 'wait', 'ship-it', 'done', '1s']);
  assert.equal(JSON.parse(short.stderr).error.code, 'timeout');
  assert.match(short.stderr, /within 1 seconds/u);
  assert.ok(Date.now() - started < 8000, 'gave up after about a second, not nine minutes');
  // forever has no limit, and still wakes the moment the task is done.
  const forever = run(process.execPath, [cli, '--db', db, 'wait', 'ship-it', 'done', 'forever']);
  await cliJson(['--db', db, 'mark', 'ship-it', 'done']);
  assert.equal(JSON.parse((await forever).stdout).note.status, 'done');
});

test('local CLI commands print no SQLite experimental warning', async t => {
  const db = join(await sandbox(t, 'quiet'), 'notes.db');
  const result = await run(process.execPath, [cli, '--db', db, 'list']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
});

test('wait wakes when another process marks a task done, and shows its progress', async t => {
  const db = join(await sandbox(t, 'wait'), 'notes.db');
  await cliJson(['--db', db, 'task', 'build-api', 'Build the API']);
  const waiting = run(process.execPath, [cli, '--db', db, 'wait', 'build-api', 'done']);
  await new Promise(resolve => setTimeout(resolve, 500));
  await cliJson(['--db', db, 'append', 'build-api', 'endpoints done']);
  await cliJson(['--db', db, 'mark', 'build-api', 'done']);

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
  await assert.rejects(store.call('replace', { id: note.id, content: 'fix pending' }), error => error.code === 'validation_error');
  const [current] = (await store.call('read', { ids: [note.id] })).notes;
  assert.equal(current.rev, 1);
});

test('hivenote ui serves the dashboard; only the page it opened can read, and never write', async t => {
  const db = join(await sandbox(t, 'ui'), 'notes.db');
  await cliJson(['--db', db, 'add', 'context', 'Shared context']);
  const child = spawn(process.execPath, [cli, 'ui', '0'], { env: { ...process.env, HIVENOTE_DB: db } });
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
  await cliJson(['--db', hive, 'add', 'on-hive', 'Lives on the hive machine']);
  const { token } = await cliJson(['--db', hive, 'token', 'add', 'laptop']);
  const server = spawn(process.execPath, [cli, 'serve', ':0'], { env: { ...process.env, HIVENOTE_DB: hive } });
  t.after(() => server.kill());
  const { serving } = await new Promise(resolve => server.stdout.once('data', chunk => resolve(JSON.parse(String(chunk)))));
  const url = `http://127.0.0.1:${new URL(serving).port}`;

  const refused = await run(process.execPath, [cli, 'connect', url], { env: laptop, input: 'wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' });
  assert.notEqual(refused.code, 0);
  assert.equal((await cliJson(['status'], { env: laptop })).hive, 'local', 'nothing saved after a bad token');

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
  const created = await cliJson(['--db', db, 'add', 'labeled', 'x'], { env: { CODEX_CI: '1' } });
  assert.equal(created.note.last_attribution.agent, 'codex');
  const explicit = await cliJson(['--db', db, '--agent', 'me', 'add', 'explicit', 'x'], { env: { CODEX_CI: '1' } });
  assert.equal(explicit.note.last_attribution.agent, 'me');
});

test('a task goes by name from start to done, and kebab-case names are searchable', async t => {
  const db = join(await sandbox(t, 'names'), 'notes.db');
  await cliJson(['--db', db, 'task', 'build-api', 'Build the API']);
  await cliJson(['--db', db, 'mark', 'build-api', 'doing']);
  await cliJson(['--db', db, 'append', 'build-api', 'Endpoint works']);
  const done = await cliJson(['--db', db, 'mark', 'build-api', 'done']);
  assert.equal(done.note.status, 'done');
  // Plain words are searched as words, so kebab-case names are found.
  assert.equal((await cliJson(['--db', db, 'search', 'build-api'])).total, 1);
  const read = await cliJson(['--db', db, 'read', 'build-api']);
  assert.equal(read.updates[0].body, 'Endpoint works');
  const missing = await run(process.execPath, [cli, '--db', db, 'append', 'nope', 'x']);
  assert.match(missing.stderr, /No note named 'nope'/u);
});

test('a worker keeps waiting when the queen restarts mid-wait', async t => {
  const dir = await sandbox(t, 'wait-restart');
  const hive = join(dir, 'hive.db');
  await cliJson(['--db', hive, 'task', 'ship-it', 'Ship it']);
  const { token } = await cliJson(['--db', hive, 'token', 'add', 'worker']);
  const serve = port => spawn(process.execPath, [cli, 'serve', `:${port}`], { env: { ...process.env, HIVENOTE_DB: hive } });
  const listening = child => new Promise(resolve => child.stdout.once('data', chunk => resolve(Number(new URL(JSON.parse(String(chunk)).serving).port))));
  let queen = serve(0);
  const port = await listening(queen);
  t.after(() => queen.kill());
  const env = { HIVENOTE_TOKEN: token };
  const waiting = run(process.execPath, [cli, '--url', `http://127.0.0.1:${port}`, 'wait', 'ship-it', 'done'], { env });
  await new Promise(resolve => setTimeout(resolve, 600));
  queen.kill();
  await new Promise(resolve => queen.once('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 1500));
  queen = serve(port);
  await listening(queen);
  await cliJson(['--db', hive, 'mark', 'ship-it', 'done']);
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).note.status, 'done');
});

test('serve public runs the tunnel program, prints the address it gives, and stops it on the way out', { skip: process.platform === 'win32' }, async t => {
  const dir = await sandbox(t, 'tunnel');
  // Stands in for cloudflared: it says what the real one says once Cloudflare has the tunnel.
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, `#!${process.execPath}
import('node:fs').then(fs => fs.writeFileSync(process.argv[1] + '.pid', String(process.pid)));
console.error('INF |  https://busy-bees-test.trycloudflare.com  |');
console.error('INF Registered tunnel connection connIndex=0');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const env = { HIVENOTE_HOME: join(dir, 'home'), HIVENOTE_DB: join(dir, 'hive.db'), HIVENOTE_CLOUDFLARED: fake };
  // Nobody has agreed to a public hive on this machine yet. A script is told what it means, and how to agree.
  const refused = await run(process.execPath, [cli, 'serve', 'public', ':0'], { env });
  assert.equal(refused.stderr.trim(), JSON.stringify({ error: JSON.parse(refused.stderr).error }), 'one line of JSON, and no SQLite warning');
  assert.equal(JSON.parse(refused.stderr).error.code, 'consent_needed');
  assert.match(refused.stderr, /passes through Cloudflare.*hivenote serve public yes/u);
  const queen = spawn(process.execPath, [cli, 'serve', 'public', ':0', 'yes'], { env: { ...process.env, ...env } });
  t.after(() => queen.kill());
  const said = JSON.parse(String(await new Promise(resolve => queen.stdout.once('data', resolve))));
  assert.equal(said.public, 'https://busy-bees-test.trycloudflare.com');
  assert.ok(existsSync(join(env.HIVENOTE_HOME, 'public-agreed')), 'the yes is remembered for this machine');
  assert.equal((await (await fetch(`${said.serving}/health`)).json()).queen, true);
  const tunnel = Number(readFileSync(`${fake}.pid`, 'utf8'));
  queen.kill();
  await new Promise(resolve => queen.once('exit', resolve));
  const running = () => { try { process.kill(tunnel, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && running(); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(running(), false, 'the tunnel program was left running');
});

test('stopping serve public while the tunnel is still opening ends it, tunnel program included', { skip: process.platform === 'win32' }, async t => {
  const dir = await sandbox(t, 'tunnel-stop');
  // A cloudflared that never gets its tunnel, as when Cloudflare is slow to answer.
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, `#!${process.execPath}
import('node:fs').then(fs => fs.writeFileSync(process.argv[1] + '.pid', String(process.pid)));
console.error('INF Requesting new quick Tunnel on trycloudflare.com...');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const queen = spawn(process.execPath, [cli, 'serve', 'public', ':0', 'yes'], { env: { ...process.env, HIVENOTE_HOME: join(dir, 'home'), HIVENOTE_DB: join(dir, 'hive.db'), HIVENOTE_CLOUDFLARED: fake } });
  t.after(() => queen.kill('SIGKILL'));
  for (let i = 0; i < 100 && !existsSync(`${fake}.pid`); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const tunnel = Number(readFileSync(`${fake}.pid`, 'utf8'));
  const exited = new Promise(resolve => queen.once('exit', resolve));
  queen.kill('SIGINT');
  assert.equal(await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('still running'), 5000))]), 0);
  const running = () => { try { process.kill(tunnel, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && running(); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(running(), false, 'the tunnel program was left running');
});

test('a downloaded cloudflared that is not the expected file is deleted, never run', async t => {
  const dir = join(await sandbox(t, 'download'), 'data');
  const server = http.createServer((request, response) => { response.end('#!/bin/sh\necho not cloudflared\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { download } = await import('../dist/tunnel.js');
  await assert.rejects(download(dir, () => {}, `http://127.0.0.1:${server.address().port}/`), error => error.code === 'tunnel_unavailable');
  assert.deepEqual(readdirSync(dir), [], 'nothing was kept');
});

test('connecting to a hive at its new address offers the token this machine already has', async t => {
  const dir = await sandbox(t, 'reconnect');
  const hive = join(dir, 'hive.db');
  const moved = join(dir, 'moved.db');
  await cliJson(['--db', hive, 'add', 'on-hive', 'Lives on the hive']);
  const { token } = await cliJson(['--db', hive, 'token', 'add', 'laptop']);
  const serve = db => {
    const queen = spawn(process.execPath, [cli, 'serve', ':0'], { env: { ...process.env, HIVENOTE_DB: db } });
    t.after(() => queen.kill());
    return new Promise(resolve => queen.stdout.once('data', chunk => resolve(`http://127.0.0.1:${new URL(JSON.parse(String(chunk)).serving).port}`)));
  };
  // This test is the person at the laptop's terminal: it answers what connect asks.
  const home = process.env.HIVENOTE_HOME;
  process.env.HIVENOTE_HOME = join(dir, 'laptop');
  t.after(() => { process.env.HIVENOTE_HOME = home; });
  const { connect } = await import('../dist/connect.js');
  const person = answers => { const asked = []; return { asked, tty: true, ask: async question => { asked.push(question); return answers.shift(); } }; };

  const first = person([token]);
  const old = await serve(hive);
  await connect(old, first);
  assert.deepEqual(first.asked, ['Token: ']);

  // The queen moves: her hive is copied to another machine, which serves it at a new address.
  await cliJson(['--db', hive, 'backup', moved]);
  const second = person(['']);
  const address = await serve(moved);
  assert.equal((await connect(address, second)).connected, address);
  assert.deepEqual(second.asked, [`Use the token saved for ${old}? [Y/n] `], 'Enter accepts, and no token is typed');
  assert.deepEqual((await cliJson(['list'], { env: { HIVENOTE_HOME: join(dir, 'laptop') } })).notes.map(note => note.name), ['on-hive']);
});
