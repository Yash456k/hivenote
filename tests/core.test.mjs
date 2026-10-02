import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { sandbox, fixture, params, actor } from './helpers.mjs';

async function storeFor(t, who = actor()) {
  const dir = await sandbox(t, 'core');
  const store = new SqliteStore(join(dir, 'notes.sqlite'), who);
  t.after(() => store.close());
  return { store, dir };
}
const fail = (fn, status, code) => assert.rejects(fn, error => {
  assert.equal(error.status, status, error.message);
  if (code) assert.equal(error.code, code);
  return true;
});

 test('note lifecycle, selectors, pagination, search and immutable revision snapshots', async t => {
  const { store } = await storeFor(t);
  const original = fixture({ name: 'Résumé 日本語 🚀', content: 'unique needle\nalpha\nbeta' });
  const created = await store.call('create', original);
  assert.equal(created.note.rev, 1);
  assert.equal(created.note.content, original.content);
  assert.ok(created.op_id);
  assert.equal(created.note.last_attribution.principal, 'test-user');
  assert.equal(created.note.last_attribution.verified, false); // Direct filesystem access is not token auth.
  const id = created.note.id;
  assert.deepEqual((await store.call('read', { names: [original.name, 'missing'] })).missing, ['missing']);
  assert.equal((await store.call('read', { ids: [id] })).notes[0].id, id);
  await fail(() => store.call('read', { names: [original.name], ids: [id] }), 400);
  const edited = await store.call('edit', { id, old_str: 'alpha', new_str: 'ALPHA', base_rev: 1 });
  assert.equal(edited.note.rev, 2);
  assert.equal(edited.note.content, 'unique needle\nALPHA\nbeta');
  const replaced = await store.call('replace', { id, content: 'new body', description: 'changed', base_rev: 2 });
  assert.equal(replaced.note.rev, 3);
  assert.equal((await store.call('revision', { id, rev: 1 })).note.content, original.content);
  assert.equal((await store.call('revision', { id, rev: 2 })).note.content, edited.note.content);
  await store.call('create', fixture({ name: 'second', content: 'unique needle second' }));
  await store.call('create', fixture({ name: 'third', content: 'unique needle third' }));
  const listed = await store.call('list', { limit: 2, offset: 0 });
  assert.equal(listed.total, 3);
  assert.equal(listed.notes.length, 2);
  assert.equal(listed.has_more, true);
  assert.ok(listed.notes.every(note => !Object.hasOwn(note, 'content')));
  const last = await store.call('list', { limit: 2, offset: 2 });
  assert.equal(last.notes.length, 1);
  assert.equal(last.has_more, false);
  assert.equal(new Set([...listed.notes, ...last.notes].map(note => note.id)).size, 3);
  const found = await store.call('search', { query: 'needle', limit: 1 });
  assert.equal(found.total, 2);
  assert.equal(found.notes.length, 1);
  assert.equal(found.has_more, true);
  assert.equal(typeof found.notes[0].snippet, 'string');
  assert.ok(!Object.hasOwn(found.notes[0], 'content'));
  const next = await store.call('search', { query: 'needle', limit: 1, offset: 1 });
  assert.notEqual(next.notes[0].id, found.notes[0].id);
  assert.equal(next.has_more, false);
});

test('exact edits reject absent/ambiguous matches; optimistic conflicts never mutate', async t => {
  const { store } = await storeFor(t);
  const { note } = await store.call('create', fixture({ content: 'same same\nunique' }));
  await fail(() => store.call('edit', { id: note.id, old_str: 'same', new_str: 'one' }), 409);
  await fail(() => store.call('edit', { id: note.id, old_str: 'absent', new_str: 'x' }), 409);
  await fail(() => store.call('edit', { id: note.id, old_str: '', new_str: 'x' }), 400);
  const edited = await store.call('edit', { id: note.id, old_str: 'unique', new_str: 'edited', base_rev: 1 });
  assert.equal(edited.note.rev, 2);
  for (const [method, body] of [
    ['replace', { content: 'stale' }], ['delete', {}], ['restore', { rev: 1 }],
    ['edit', { old_str: 'edited', new_str: 'stale' }],
  ]) {
    await assert.rejects(store.call(method, { id: note.id, base_rev: 1, ...body }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.details.current.rev, 2);
      return true;
    });
  }
  assert.equal((await store.call('read', { ids: [note.id] })).notes[0].content, edited.note.content);
  assert.equal((await store.call('history', { id: note.id })).total, 2);
});

test('online backup restores notes, history, tombstones, receipts and authentication', async t => {
  const { store, dir } = await storeFor(t);
  const token = store.tokenCreate('backup-device', 'rw');
  const request = params(fixture({ name: 'backup-note' }));
  const created = store.execute('create', request, actor());
  await store.call('replace', { id: created.note.id, content: 'backed-up', base_rev: 1 });
  const other = await store.call('create', fixture({ name: 'backup-deleted' }));
  await store.call('delete', { id: other.note.id, base_rev: 1 });
  const expected = await store.call('changes', { since: 0 });
  const backupPath = join(dir, 'backup with spaces 日本語.sqlite');
  assert.equal((await store.backup(backupPath)).path, backupPath);
  const restored = new SqliteStore(backupPath, actor());
  t.after(() => restored.close());
  assert.equal((await restored.call('read', { ids: [created.note.id] })).notes[0].content, 'backed-up');
  assert.deepEqual(await restored.call('changes', { since: 0 }), expected);
  assert.ok((await restored.call('revision', { id: other.note.id, rev: 2 })).note.deleted_at);
  assert.deepEqual(restored.execute('create', request, actor()), created);
  assert.equal(restored.authenticate(token.token).device, 'backup-device');
});

test('validation, name collision, read-only scope and reopen persistence', async t => {
  const { store, dir } = await storeFor(t);
  const note = await store.call('create', fixture({ name: 'collision' }));
  await fail(() => store.call('create', fixture({ name: 'collision' })), 409);
  await assert.rejects(store.call('create', { name: '', content: 'missing description' }));
  await assert.rejects(store.call('list', { offset: -1 }));
  await assert.rejects(store.call('replace', { id: note.note.id, content: 'missing revision' }));
  for (const [method, input] of [
    ['read', {}], ['read', { ids: [] }], ['read', { ids: [123] }],
    ['list', { limit: 0 }], ['list', { offset: 1.5 }],
    ['create', fixture({ id: 'not-a-uuid' })], ['create', fixture({ kind: 'invalid-kind' })],
    ['revision', { id: note.note.id, rev: 0 }], ['changes', { since: -1 }],
  ]) await fail(() => store.call(method, input), 400);
  assert.throws(() => store.execute('append', params({ id: note.note.id, body: 'forbidden' }), actor('reader', 'device', 'ro')), e => e.status === 403);
  const reopened = new SqliteStore(join(dir, 'notes.sqlite'), actor());
  t.after(() => reopened.close());
  assert.equal((await reopened.call('read', { ids: [note.note.id] })).notes[0].name, 'collision');
});
