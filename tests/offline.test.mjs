import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cli, closeServer, params, run, sandbox } from './helpers.mjs';

test('writes made while the queen is away are kept, and sent once, in order, when she is back', { timeout: 60_000 }, async t => {
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

  await closeServer(server);
  const kept = [
    await hive('append', 'build-api', 'Schema is in'),
    await hive('mark', 'build-api', 'done', 'All three work'),
    await hive('add', 'api/contract', 'What the API promises', 'POST /bookings'),
    await hive('edit', 'build-api', 'text that is not there', 'anything'),
  ];
  assert.ok(kept.every(answer => answer.code === 0), kept.map(answer => answer.stderr).join('\n'));
  assert.deepEqual(kept.map(answer => JSON.parse(answer.stdout)).map(({ ok, waiting }) => [ok, waiting]), [['queued', 1], ['queued', 3], ['queued', 4], ['queued', 5]]);
  // Taking a task and reading need the queen, and say so.
  for (const words of [['mark', 'build-api', 'doing'], ['take'], ['read', 'build-api']]) {
    const answer = await hive(...words);
    assert.notEqual(answer.code, 0);
    assert.match(JSON.parse(answer.stderr).error.message, /5 writes made here are waiting to be sent to the queen/u, words.join(' '));
  }
  assert.match((await hive('status')).stderr, /5 writes made here are waiting/u);

  // Back, and the first answer is lost on the way: the worker sends that write again, and it is still made once.
  server = await startServer(store, { port, dropResponseOnce: true });
  const back = await hive('list');
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stderr, /refused when it was sent, so it is dropped: edit build-api\. The old text is not in the note/u);
  assert.deepEqual(JSON.parse(back.stdout).notes.map(note => note.name).sort(), ['api/contract', 'build-api']);
  const history = (await store.call('history', { note: 'build-api' })).events.map(event => [event.kind, event.body ?? event.snapshot.status, event.attribution.agent]);
  assert.deepEqual(history, [['create', 'todo', undefined], ['append', 'Schema is in', 'builder'], ['append', 'All three work', 'builder'], ['update_task', 'done', 'builder']]);

  // Sent once: nothing is waiting, the next command sends nothing again and reports nothing again.
  assert.equal(existsSync(join(env.HIVENOTE_HOME, 'queue.jsonl')), false);
  const status = await hive('status');
  assert.equal(JSON.parse(status.stdout).queued, 0);
  assert.equal(status.stderr, '');
  assert.equal((await store.call('history', { note: 'build-api' })).total, 4);
});
