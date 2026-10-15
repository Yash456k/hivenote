import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cli, closeServer, params, root, run, sandbox } from './helpers.mjs';

test('a worker keeps working while the queen is away, and merge gives her its writes once', { timeout: 90_000 }, async t => {
  const dir = await sandbox(t, 'offline');
  const store = new SqliteStore(join(dir, 'queen.db'), actor());
  t.after(() => store.close());
  const { token } = store.tokenCreate('laptop');
  let server = await startServer(store, { port: 0 });
  const port = server.address().port;
  t.after(() => closeServer(server));
  await store.call('create', params({ name: 'build-api', description: 'Build the API', content: 'Three endpoints', kind: 'task' }));
  await store.call('create', params({ name: 'contract', description: 'What the API promises', content: 'POST /bookings' }));
  const env = { HIVENOTE_URL: `http://127.0.0.1:${port}`, HIVENOTE_TOKEN: token, HIVENOTE_HOME: join(dir, 'worker') };
  const hive = (...words) => run(process.execPath, [cli, '--agent', 'builder', ...words], { env });
  const json = async (...words) => { const answer = await hive(...words); assert.equal(answer.code, 0, `${words.join(' ')}: ${answer.stderr}`); return JSON.parse(answer.stdout); };
  const refused = async (...words) => { const answer = await hive(...words); assert.notEqual(answer.code, 0, words.join(' ')); return JSON.parse(answer.stderr.trim().split('\n').at(-1)); };

  // The worker looks around while she is up, so it has something to go on.
  await json('list');
  await json('read', 'build-api', 'contract');
  await closeServer(server);

  // Reads answer from what it last saw, and say so.
  const list = await json('list');
  assert.deepEqual(list.notes.map(note => note.name).sort(), ['build-api', 'contract']);
  assert.match(list.offline.heads_up, /can't be reached/u);
  assert.equal((await json('read', 'contract')).notes[0].content, 'POST /bookings');
  assert.equal((await json('search', 'bookings')).notes[0].name, 'contract');

  // New notes, progress on her notes, and anything done to a note made here are kept.
  assert.equal((await json('append', 'build-api', 'Schema is in')).ok, 'queued');
  assert.equal((await json('task', 'outage', 'Write up the outage', 'Down at noon')).ok, 'queued');
  await json('add', 'api/notes', 'Notes on the API', 'draft');
  await json('edit', 'api/notes', 'draft', 'first version');
  await json('append', 'api/notes', 'Reviewed by planner');
  await json('mark', 'outage', 'doing');
  assert.equal((await json('read', 'api/notes')).notes[0].content, 'first version');
  assert.equal((await json('list')).kept, 4);

  // A change to one of her notes waits for her, and nothing is kept for it.
  for (const words of [['edit', 'contract', 'POST', 'PUT'], ['mark', 'build-api', 'done'], ['mark', 'build-api', 'done', 'All three work'], ['delete', 'contract'], ['take']]) {
    const error = await refused(...words);
    assert.equal(error.error.code, 'queen_unreachable', words.join(' '));
    assert.equal(error.kept, 4, words.join(' '));
  }

  // She is back. Nothing is sent until merge. Meanwhile someone on her side took the name outage.
  server = await startServer(store, { port });
  assert.equal((await store.call('history', { note: 'build-api' })).total, 1);
  await store.call('create', params({ name: 'outage', description: 'Down at noon', content: 'Written on the queen' }));
  // Notes made here show up beside hers until they are merged.
  assert.ok((await json('list')).notes.some(note => note.name === 'api/notes'));

  const first = await json('merge');
  assert.deepEqual([first.applied, first.already], [3, 0]);
  assert.deepEqual(first.conflicts.map(item => [item.note, item.kind]), [['outage', 'task']]);
  assert.match(first.conflicts[0].why, /'outage' already exists/u);
  const [buildApi, apiNotes, outage] = (await store.call('read', { names: ['build-api', 'api/notes', 'outage'] })).notes;
  assert.equal(buildApi.status, 'todo');
  assert.equal(apiNotes.content, 'first version');
  assert.equal(outage.content, 'Written on the queen');
  const progress = note => store.call('history', { note }).then(page => page.events.filter(event => event.kind === 'append').map(event => [event.body, event.attribution.agent]));
  assert.deepEqual(await progress('api/notes'), [['Reviewed by planner', 'builder']]);
  assert.deepEqual(await progress('build-api'), [['Schema is in', 'builder']]);
  // Again: nothing is made twice.
  const latest = (await store.call('changes', { tail: 1 })).cursor;
  assert.equal((await json('merge')).applied, 0);
  assert.equal((await store.call('changes', { tail: 1 })).cursor, latest);

  // The agent sees the conflict beside what she has, and settles it under another name.
  const shown = await json('conflicts');
  assert.deepEqual([shown.total, shown.conflicts[0].description, shown.conflicts[0].on_the_queen.content], [1, 'Write up the outage', 'Written on the queen']);
  const resolved = await json('resolve', 'outage', 'as', 'outage-writeup');
  assert.deepEqual([resolved.note, resolved.conflicts_left], ['outage-writeup', 0]);
  const [mine] = (await store.call('read', { names: ['outage-writeup'] })).notes;
  assert.deepEqual([mine.kind, mine.status, mine.content], ['task', 'doing', 'Down at noon']);
  const status = await hive('status');
  assert.deepEqual([JSON.parse(status.stdout).kept, JSON.parse(status.stdout).conflicts, status.stderr], [0, 0, '']);
});

test('a hive made by 0.5.0 opens as it is, with nothing to upgrade', async t => {
  const dir = await sandbox(t, 'v05');
  const path = join(dir, 'data.db');
  copyFileSync(join(root, 'tests/fixtures/hive-0.5.0.db'), path);
  const store = new SqliteStore(path, actor());
  t.after(() => store.close());
  assert.deepEqual((await store.call('list', {})).notes.map(note => note.name).sort(), ['build-api', 'deploy/notes']);
  assert.deepEqual(store.tokenList().map(row => [row.device, row.scope]), [['laptop', 'rw'], ['dashboard', 'ro']]);
  await store.call('create', params({ name: 'after-1-0', description: 'Written by 1.0', content: '', kind: 'task', after: ['build-api'] }));
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
});
