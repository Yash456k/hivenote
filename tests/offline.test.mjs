import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cli, closeServer, params, run, sandbox } from './helpers.mjs';

test('while the queen is away only new notes are kept; merge sends them once, and the agent settles conflicts', { timeout: 60_000 }, async t => {
  const dir = await sandbox(t, 'offline');
  const store = new SqliteStore(join(dir, 'queen.db'), actor());
  t.after(() => store.close());
  const { token } = store.tokenCreate('laptop');
  let server = await startServer(store, { port: 0 });
  const port = server.address().port;
  t.after(() => closeServer(server));
  await store.call('create', params({ name: 'build-api', description: 'Build the API', content: 'Three endpoints', kind: 'task' }));
  const env = { HIVENOTE_URL: `http://127.0.0.1:${port}`, HIVENOTE_TOKEN: token, HIVENOTE_HOME: join(dir, 'worker') };
  const hive = (...words) => run(process.execPath, [cli, '--agent', 'builder', ...words], { env });
  const json = async (...words) => { const answer = await hive(...words); assert.equal(answer.code, 0, answer.stderr); return JSON.parse(answer.stdout); };

  await closeServer(server);
  // New notes and tasks are kept.
  const added = [await json('add', 'api/contract', 'What the API promises', 'POST /bookings'), await json('task', 'outage', 'Write up the outage')];
  assert.deepEqual(added.map(({ ok, kept }) => [ok, kept]), [['queued', 1], ['queued', 2]]);
  // Anything that changes a note she holds, or reads, is refused, and nothing is kept for it.
  for (const words of [['append', 'build-api', 'Schema is in'], ['mark', 'build-api', 'done'], ['mark', 'build-api', 'done', 'All three work'], ['edit', 'build-api', 'Three', 'Four'], ['take'], ['read', 'build-api']]) {
    const answer = await hive(...words);
    assert.notEqual(answer.code, 0, words.join(' '));
    assert.equal(JSON.parse(answer.stderr).kept, 2, words.join(' '));
  }

  // Back, and nothing is sent until merge. Meanwhile someone on the queen used the name outage.
  server = await startServer(store, { port });
  assert.equal((await json('list')).kept, 2);
  assert.equal((await store.call('list', {})).total, 1);
  assert.equal((await store.call('history', { note: 'build-api' })).total, 1);
  await store.call('create', params({ name: 'outage', description: 'Down at noon', content: 'Written on the queen' }));

  const first = await json('merge');
  assert.deepEqual([first.applied, first.already], [1, 0]);
  assert.deepEqual(first.conflicts.map(item => [item.note, item.kind, item.by]), [['outage', 'task', 'builder']]);
  assert.match(first.conflicts[0].why, /'outage' already exists/u);
  assert.equal(first.conflicts.length && first.conflicts[0].note, 'outage');
  assert.equal((await store.call('read', { names: ['api/contract'] })).notes[0].content, 'POST /bookings');
  // Merge again: nothing is made twice.
  const latest = store.changeCount().latest;
  assert.equal((await json('merge')).applied, 0);
  assert.equal(store.changeCount().latest, latest);

  // The agent sees the conflict with both sides, and settles it under another name.
  const shown = await json('conflicts');
  assert.equal(shown.total, 1);
  assert.deepEqual([shown.conflicts[0].description, shown.conflicts[0].on_the_queen.content], ['Write up the outage', 'Written on the queen']);
  const resolved = await json('resolve', 'outage', 'as', 'outage-writeup');
  assert.deepEqual([resolved.note, resolved.conflicts_left], ['outage-writeup', 0]);
  const [mine, theirs] = (await store.call('read', { names: ['outage-writeup', 'outage'] })).notes;
  assert.deepEqual([mine.kind, mine.status, mine.last_attribution.agent, theirs.content], ['task', 'todo', 'builder', 'Written on the queen']);
  const status = await hive('status');
  assert.deepEqual([JSON.parse(status.stdout).kept, JSON.parse(status.stdout).conflicts, status.stderr], [0, 0, '']);
});
