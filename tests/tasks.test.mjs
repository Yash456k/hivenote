import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cli, cliJson, closeServer, params, run, sandbox, serverUrl } from './helpers.mjs';

// The error is the last line; a worker may say first that the queen runs another version.
const failed = result => JSON.parse(result.stderr.trim().split('\n').at(-1)).error;

test('a task waits on others: ready shows what can start, and the link survives a rename', async t => {
  const db = join(await sandbox(t, 'after'), 'notes.db');
  const hive = (...words) => cliJson(['--db', db, ...words]);
  await hive('task', 'build-api', 'Build the API');
  assert.deepEqual((await hive('task', 'review-api', 'Review it', '--after', 'build-api')).after, ['build-api']);
  await hive('task', 'deploy', 'Ship it', '--after', 'build-api,review-api');

  assert.deepEqual((await hive('ready')).notes.map(task => task.name), ['build-api']);
  const board = await hive('tasks');
  assert.deepEqual(board.notes.find(task => task.name === 'deploy').waits_on, ['build-api', 'review-api']);

  // Stored by id: renaming a task keeps every task that waits on it waiting on it.
  const store = new SqliteStore(db, actor());
  await store.call('replace', params({ note: 'build-api', name: 'build-backend' }));
  // Other metadata can be set without dropping what it waits on.
  await store.call('update_task', params({ note: 'deploy', metadata: { priority: 1 } }));
  store.close();
  assert.deepEqual((await hive('read', 'deploy')).notes[0].waits_on, ['build-backend', 'review-api']);

  await hive('mark', 'build-backend', 'done');
  assert.deepEqual((await hive('ready')).notes.map(task => task.name), ['review-api']);
  assert.deepEqual((await hive('after', 'deploy', 'not', 'review-api')).after, ['build-backend']);
  assert.deepEqual((await hive('ready')).notes.map(task => task.name), ['review-api', 'deploy']);

  // A task can't end up waiting on itself through others.
  const loop = await run(process.execPath, [cli, '--db', db, 'after', 'build-backend', 'deploy']);
  assert.match(failed(loop).message, /'build-backend' cannot wait on 'deploy', which already waits on 'build-backend'/u);
});

test('restore and a reused name never leave tasks stuck, and a caller\'s own metadata after is kept', async t => {
  const store = new SqliteStore(join(await sandbox(t, 'after-restore'), 'notes.db'), actor());
  t.after(() => store.close());
  const task = (name, extra = {}) => store.call('create', params({ name, description: name, content: '', kind: 'task', ...extra }));
  await task('a'); await task('b');
  const waited = await store.call('update_task', params({ note: 'a', after: ['b'] }));
  await store.call('update_task', params({ note: 'a', not_after: ['b'] }));
  await store.call('update_task', params({ note: 'b', after: ['a'] }));
  // The version where a waited on b comes back without that wait, which would now be a loop.
  await store.call('restore', params({ note: 'a', rev: waited.note.rev }));
  assert.deepEqual((await store.call('list', { ready: true })).notes.map(note => note.name), ['a']);

  // deploy waited on a build that was deleted; a new, unrelated build does not hold it up.
  await task('build'); await task('deploy', { after: ['build'] });
  await store.call('delete', params({ note: 'build' }));
  await task('build');
  assert.equal((await store.call('read', { names: ['deploy'] })).waits_on, undefined);

  const own = await store.call('create', params({ name: 'meal', description: '', content: '', metadata: { after: 'lunch' } }));
  assert.deepEqual(own.note.metadata, { after: 'lunch' });
});

test('take gives each ready task to exactly one of many agents asking at once', { timeout: 120_000 }, async t => {
  const dir = await sandbox(t, 'take');
  const store = new SqliteStore(join(dir, 'queen.db'), actor());
  const { token } = store.tokenCreate('laptop');
  const server = await startServer(store, { port: 0 });
  t.after(async () => { await closeServer(server); store.close(); });
  for (let i = 1; i <= 12; i++) await store.call('create', params({ name: `t${i}`, description: `Task ${i}`, content: '', kind: 'task' }));
  // Waits on t1, which is being done, not done: no agent may get it.
  await store.call('create', params({ name: 'last', description: 'After t1', content: '', kind: 'task', after: ['t1'] }));

  const env = { HIVENOTE_URL: serverUrl(server), HIVENOTE_TOKEN: token, HIVENOTE_HOME: join(dir, 'worker') };
  const answers = await Promise.all(Array.from({ length: 16 }, (_, i) => run(process.execPath, [cli, '--agent', `agent-${i}`, 'take'], { env })));
  const taken = answers.filter(answer => answer.code === 0).map(answer => JSON.parse(answer.stdout));
  assert.equal(taken.length, 12);
  assert.deepEqual(taken.map(task => task.note).sort(), Array.from({ length: 12 }, (_, i) => `t${i + 1}`).sort());
  assert.ok(taken.every(task => task.ok === 'taken' && task.status === 'doing' && task.description.startsWith('Task')));
  const refused = answers.filter(answer => answer.code !== 0).map(failed);
  assert.equal(refused.length, 4);
  assert.ok(refused.every(error => error.code === 'nothing_ready' && /1 task waits on others to be done, and 12 tasks are being done/u.test(error.message)));
});

test('a doing task left idle is taken over, and the answer says from whom', async t => {
  const dir = await sandbox(t, 'takeover');
  const env = { HIVENOTE_HOME: join(dir, 'home') };
  mkdirSync(env.HIVENOTE_HOME, { recursive: true });
  writeFileSync(join(env.HIVENOTE_HOME, 'config.json'), JSON.stringify({ takeover: '1s' }));
  const db = join(dir, 'notes.db');
  const as = (agent, ...words) => run(process.execPath, [cli, '--db', db, '--agent', agent, ...words], { env });
  await as('planner', 'task', 'build-api', 'Build the API');
  await as('builder', 'mark', 'build-api', 'doing');
  assert.equal(failed(await as('reviewer', 'mark', 'build-api', 'doing')).code, 'taken');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const over = JSON.parse((await as('reviewer', 'mark', 'build-api', 'doing')).stdout);
  assert.deepEqual([over.status, over.taken_over.from, over.taken_over.idle, over.heads_up], ['doing', 'builder', '1s', undefined]);
  // take finds such a task too when nothing else is ready.
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(JSON.parse((await as('fixer', 'take')).stdout).taken_over.from, 'reviewer');
});

test('a name with a / is in a folder, and list FOLDER/ shows what is in it', async t => {
  const db = join(await sandbox(t, 'folders'), 'notes.db');
  const hive = (...words) => cliJson(['--db', db, ...words]);
  await hive('add', 'deploy/staging-notes', 'How we ship to staging');
  await hive('add', 'deploy/prod/runbook', 'When production breaks');
  await hive('add', 'api-decisions', 'Why the API is the way it is');
  assert.deepEqual((await hive('list', 'deploy/')).notes.map(note => note.name).sort(), ['deploy/prod/runbook', 'deploy/staging-notes']);
  // The whole list keeps the shape agents already read.
  const all = await hive('list');
  assert.equal(all.total, 3);
  assert.deepEqual(Object.keys(all.notes[0]).sort(), ['ago', 'description', 'kind', 'name']);
});

test('a worker on a queen older than 1.0 is told to update her, and nothing changes', async t => {
  const dir = await sandbox(t, 'old-queen');
  const store = new SqliteStore(join(dir, 'queen.db'), actor());
  const { token } = store.tokenCreate('laptop');
  const server = await startServer(store, { port: 0 });
  t.after(async () => { await closeServer(server); store.close(); });
  await store.call('create', params({ name: 'build-api', description: 'Build', content: '', kind: 'task' }));
  // A 0.5 queen: no take method, and no parameters it doesn't know.
  const old = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { method, params: sent = {} } = JSON.parse(Buffer.concat(chunks));
    const refuse = (code, message) => { response.writeHead(400, { 'content-type': 'application/json', 'x-hivenote-version': '0.5.0' }); response.end(JSON.stringify({ error: { code, message } })); };
    if (method === 'take') return refuse('invalid_request', 'Expected {method, params, agent?, session?}');
    if (['after', 'not_after', 'ready', 'folder'].some(key => key in sent)) return refuse('validation_error', `Unknown parameter for ${method}`);
    const answer = await fetch(serverUrl(server) + request.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: request.headers.authorization }, body: Buffer.concat(chunks) });
    response.writeHead(answer.status, { 'content-type': 'application/json', 'x-hivenote-version': '0.5.0' });
    response.end(await answer.text());
  });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(old));
  const env = { HIVENOTE_URL: serverUrl(old), HIVENOTE_TOKEN: token, HIVENOTE_HOME: join(dir, 'worker') };
  for (const words of [['take'], ['ready'], ['task', 'deploy', 'Ship it', '--after', 'build-api'], ['list', 'deploy/']]) {
    const error = failed(await run(process.execPath, [cli, ...words], { env }));
    assert.equal(error.code, 'queen_too_old', words.join(' '));
    assert.match(error.message, /queen runs HiveNote 0\.5\.0, and this needs 1\.0 or newer there\. Nothing was changed/u);
  }
  assert.equal((await store.call('list', {})).total, 1);
  assert.equal((await cliJson(['tasks'], { env })).total, 1);
});
