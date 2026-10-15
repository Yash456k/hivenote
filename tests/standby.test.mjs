import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../dist/sqlite.js';
import { actor, root, sandbox } from './helpers.mjs';

test('a hive made by 0.5.0 opens, keeps its notes and tokens, and is copied first', async t => {
  const dir = await sandbox(t, 'v05');
  const path = join(dir, 'data.db');
  copyFileSync(join(root, 'tests/fixtures/hive-0.5.0.db'), path);
  const store = new SqliteStore(path, actor());
  t.after(() => store.close());
  assert.deepEqual((await store.call('list', {})).notes.map(note => note.name).sort(), ['build-api', 'deploy/notes']);
  assert.deepEqual(store.tokenList().map(row => [row.device, row.scope, row.standby]), [['laptop', 'rw', 0], ['dashboard', 'ro', 0]]);
  assert.equal((await store.call('history', { note: 'plan' })).total, 2);
  assert.equal(store.tokenCreate('msi', 'rw', true).standby, true);
  const copy = new DatabaseSync(`${path}.before-v2`, { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(copy.prepare('SELECT count(*) AS n FROM events').get().n, 6);
  copy.close();
});
