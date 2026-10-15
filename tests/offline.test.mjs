import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cli, closeServer, params, run, sandbox } from './helpers.mjs';

test('writes made while the queen is away are kept, and sent only by merge, once, in order', { timeout: 60_000 }, async t => {
  const dir = await sandbox(t, 'offline');
  const store = new SqliteStore(join(dir, 'queen.db'), actor());
  t.after(() => store.close());
  const { token } = store.tokenCreate('laptop');
  let server = await startServer(store, { port: 0 });
  const port = server.address().port;
  t.after(() => closeServer(server));
  await store.call('create', params({ name: 'build-api', description: 'Build the API', content: 'Three endpoints', kind: 'task' }));
  await store.call('create', params({ name: 'deploy', description: 'Ship it', content: '', kind: 'task' }));
  const env = { HIVENOTE_URL: `http://127.0.0.1:${port}`, HIVENOTE_TOKEN: token, HIVENOTE_HOME: join(dir, 'worker') };
  const hive = (...words) => run(process.execPath, [cli, '--agent', 'builder', ...words], { env });

  await closeServer(server);
  const kept = [
    await hive('append', 'build-api', 'Schema is in'),
    await hive('mark', 'build-api', 'done', 'All three work'),
    await hive('add', 'api/contract', 'What the API promises', 'POST /bookings'),
    await hive('mark', 'deploy', 'done'),
    await hive('edit', 'deploy', 'old text', 'new text'),
  ];
  assert.ok(kept.every(answer => answer.code === 0), kept.map(answer => answer.stderr).join('\n'));
  assert.deepEqual(kept.map(answer => JSON.parse(answer.stdout)).map(({ ok, kept }) => [ok, kept]), [['queued', 1], ['queued', 3], ['queued', 4], ['queued', 5], ['queued', 6]]);
  // Taking a task and reading need the queen, and say how many writes are kept.
  for (const words of [['mark', 'build-api', 'doing'], ['take'], ['read', 'build-api']]) {
    const answer = await hive(...words);
    assert.notEqual(answer.code, 0);
    assert.equal(JSON.parse(answer.stderr).kept, 6, words.join(' '));
  }

  // Back, and nothing is sent until merge: commands work, and each says what is kept.
  server = await startServer(store, { port });
  const back = await hive('list');
  assert.equal(back.code, 0, back.stderr);
  assert.equal(JSON.parse(back.stdout).kept, 6);
  assert.equal(JSON.parse((await hive('status')).stdout).kept, 6);
  assert.equal((await store.call('list', {})).total, 2);
  assert.equal((await store.call('history', { note: 'build-api' })).total, 1);
  // Meanwhile someone on the queen takes deploy: the kept mark must not overwrite that.
  await store.call('update_task', params({ note: 'deploy', status: 'doing' }));

  const merge = async () => {
    const answer = await hive('merge');
    assert.equal(answer.code, 0, answer.stderr);
    return JSON.parse(answer.stdout);
  };
  const first = await merge();
  assert.deepEqual([first.applied, first.already], [4, 0]);
  assert.deepEqual(first.not_merged.map(item => [item.change, item.by]), [['mark deploy done', 'builder'], ['edit deploy', 'builder']]);
  assert.match(first.not_merged[0].why, /changed it on the queen meanwhile/u);
  assert.match(first.not_merged[1].why, /earlier write to it made here was not merged/u);
  assert.equal(first.kept, undefined);
  const history = (await store.call('history', { note: 'build-api' })).events.map(event => [event.kind, event.body ?? event.snapshot.status, event.attribution.agent]);
  assert.deepEqual(history, [['create', 'todo', undefined], ['append', 'Schema is in', 'builder'], ['append', 'All three work', 'builder'], ['update_task', 'done', 'builder']]);
  assert.equal((await store.call('read', { names: ['deploy'] })).notes[0].status, 'doing');
  assert.equal(existsSync(join(env.HIVENOTE_HOME, 'not-merged.jsonl')), true);

  // Again: nothing is kept, so nothing is sent twice.
  const latest = store.changeCount().latest;
  const second = await merge();
  assert.deepEqual([second.applied, second.already, second.not_merged.length], [0, 0, 0]);
  assert.equal(store.changeCount().latest, latest);
  const status = await hive('status');
  assert.equal(JSON.parse(status.stdout).kept, 0);
  assert.equal(status.stderr, '');
});
