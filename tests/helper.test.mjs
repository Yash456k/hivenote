import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cliJson, closeServer, sandbox, serverUrl } from './helpers.mjs';

test('commands on a worker share one connection to the queen, and the helper leaves when idle', { timeout: 60_000 }, async t => {
  const dir = await sandbox(t, 'helper');
  const store = new SqliteStore(join(dir, 'hive.db'), actor());
  const { token } = store.tokenCreate('laptop', 'rw');
  const server = await startServer(store, { host: '127.0.0.1', port: 0 });
  let connections = 0;
  server.on('connection', () => { connections++; });
  t.after(async () => { await closeServer(server); store.close(); });
  // The helper stays for 3 idle seconds here, not ten minutes.
  const env = { HIVENOTE_HOME: join(dir, 'laptop'), HIVENOTE_URL: serverUrl(server), HIVENOTE_TOKEN: token, HIVENOTE_HELPER: '3' };
  const hive = (...args) => cliJson(args, { env });
  const kept = async () => (await hive('status')).connection === 'kept open';

  // The first command goes to the queen itself and starts the helper behind it.
  await hive('add', 'plan', 'The plan', 'step one');
  for (let i = 0; i < 100 && !await kept(); i++) await sleep(100);
  assert.ok(await kept(), 'the helper is up');

  const before = connections;
  await hive('--agent', 'builder-1', 'append', 'plan', 'step one done');
  await hive('edit', 'plan', 'step one', 'step two');
  assert.equal((await hive('search', 'two')).total, 1);
  const { notes: [plan], updates } = await hive('read', 'plan');
  assert.equal(plan.content, 'step two');
  assert.deepEqual(updates.map(update => [update.body, update.attribution.agent]), [['step one done', 'builder-1']]);
  assert.equal(connections - before, 0, 'four commands, no new connection to the queen');
  // A real error from the queen comes back through the helper as itself.
  await assert.rejects(hive('read', 'no-such-note'), /No note named/u);

  await sleep(3500);
  for (let i = 0; i < 50 && await kept(); i++) await sleep(100);
  assert.equal(await kept(), false, 'the helper left');
  assert.equal((await hive('list')).total, 1, 'and commands still work without it');
});
