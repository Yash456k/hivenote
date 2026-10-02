import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { HttpStore } from '../dist/client.js';
import { startServer } from '../dist/http.js';
import { sandbox, fixture, params, serverUrl, closeServer } from './helpers.mjs';

async function setup(t) {
  const dir = await sandbox(t, 'review-storage');
  const path = join(dir, 'notes.db');
  const store = new SqliteStore(path);
  const token = store.tokenCreate('review-client', 'rw');
  const server = await startServer(store, { port: 0 });
  t.after(async () => { await closeServer(server); store.close(); });
  return { path, store, token, client: new HttpStore(serverUrl(server), token.token, { retries: 0 }) };
}

test('reject ill-formed Unicode before current state, snapshots or receipts diverge', async t => {
  const { store, client } = await setup(t);
  for (const broken of ['before\uD800after', '\uDC00', '\uD800\uD800']) {
    for (const field of ['name', 'description', 'content']) {
      await assert.rejects(client.call('create', fixture({ [field]: broken })), e => e.status === 400);
    }
  }
  assert.equal((await store.call('list')).total, 0);
  assert.equal((await store.call('changes')).events.length, 0);
  const content = 'valid pair: 😀 — 日本語';
  const created = await client.call('create', fixture({ content }));
  assert.equal(created.note.content, content);
  assert.equal((await client.call('read', { ids: [created.note.id] })).notes[0].content, content);
  assert.equal((await client.call('revision', { id: created.note.id, rev: 1 })).note.content, content);
  await assert.rejects(client.call('append', { id: created.note.id, body: '\uD800' }), e => e.status === 400);
  await assert.rejects(client.call('edit', { id: created.note.id, old_str: 'valid', new_str: '\uD800' }), e => e.status === 400);
});

test('revocation committed during write-lock acquisition denies the pending HTTP mutation', { timeout: 15000 }, async t => {
  const { path, store, token, client } = await setup(t);
  // Separate process holds the revocation transaction. It commits only after
  // the HTTP server has completed its last pre-dispatch authentication read.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    db.prepare('UPDATE clients SET revoked=1 WHERE id=?').run(process.argv[2]);
    process.on('message', message => {
      if (message === 'commit') {
        db.exec('COMMIT'); db.close(); process.send('committed'); process.disconnect();
      }
    });
    process.send('locked');
  `, path, token.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let childErrors = '';
  child.stderr.on('data', data => { childErrors += data; });
  const exit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [locked] = await once(child, 'message');
  assert.equal(locked, 'locked', childErrors);
  let authentications = 0;
  const authenticate = store.authenticate.bind(store);
  store.authenticate = raw => {
    const actor = authenticate(raw);
    if (++authentications === 2) child.send('commit');
    return actor;
  };
  await assert.rejects(client.call('create', fixture({ name: 'must-not-commit' })), e => e.status === 401);
  const [code] = await exit;
  assert.equal(code, 0, childErrors);
  assert.equal((await store.call('list')).total, 0);
  assert.equal((await store.call('changes')).events.length, 0);
});

test('cached verified actors cannot replay receipts or read after revocation', async t => {
  const { store, token } = await setup(t);
  const actor = store.authenticate(token.token);
  const request = params(fixture());
  store.execute('create', request, actor);
  store.tokenRevoke(token.device);
  assert.throws(() => store.execute('create', request, actor), e => e.status === 401);
  assert.throws(() => store.execute('list', {}, actor), e => e.status === 401);
});
