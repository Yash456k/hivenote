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

test('receipts are immutable, actor- and intent-bound; failures leave no event', async t => {
  const { store } = await storeFor(t);
  const a = actor('alice', 'laptop');
  const b = actor('bob', 'phone');
  const request = params(fixture({ name: 'receipt' }));
  const first = store.execute('create', request, a);
  const edited = store.execute('replace', params({ id: first.note.id, content: 'later', base_rev: 1 }), a);
  assert.equal(edited.note.rev, 2);
  assert.deepEqual(store.execute('create', request, a), first);
  assert.throws(() => store.execute('create', { ...request, content: 'different intent' }, a), e => e.status === 409);
  assert.throws(() => store.execute('create', request, b), e => e.status === 409);
  assert.throws(() => store.execute('append', { id: first.note.id, body: 'different method', op_id: request.op_id }, a), e => e.status === 409);
  assert.equal((await store.call('history', { id: first.note.id })).total, 2);
  const events = (await store.call('changes', { since: 0 })).events;
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.attribution.principal), ['alice', 'alice']);
});

test('append is activity-only, revisions stay immutable and changes resume without gaps', async t => {
  const { store } = await storeFor(t);
  const { note } = await store.call('create', fixture());
  const appended = await store.call('append', { id: note.id, body: 'activity payload' });
  assert.equal(appended.note.rev, 1);
  assert.equal(appended.note.content, note.content);
  assert.deepEqual((await store.call('revision', { id: note.id, rev: 1 })).note, note);
  await store.call('replace', { id: note.id, content: 'second', base_rev: 1 });
  const all = [];
  let since = 0;
  for (let i = 0; i < 10; i++) {
    const page = await store.call('changes', { since, limit: 1 });
    all.push(...page.events);
    assert.ok(page.cursor >= since);
    since = page.cursor;
    if (!page.has_more) break;
  }
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map(e => e.seq)).size, 3);
  assert.equal(all[1].body, 'activity payload');
  assert.equal(all[1].revision, null);
  assert.equal(all[0].snapshot.content, note.content);
  const empty = await store.call('changes', { since });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.has_more, false);
  const history = await store.call('history', { id: note.id, limit: 1 });
  assert.equal(history.total, 3);
  assert.equal(history.has_more, true);
});

test('tombstones reserve IDs, permit name reuse and preserve delete/restore snapshots', async t => {
  const { store } = await storeFor(t);
  const first = await store.call('create', fixture({ name: 'reusable', content: 'v1' }));
  const v2 = await store.call('replace', { id: first.note.id, content: 'v2', base_rev: 1 });
  const deleted = await store.call('delete', { id: first.note.id, base_rev: v2.note.rev });
  assert.ok(deleted.note.deleted_at);
  assert.equal(deleted.note.rev, 3);
  assert.deepEqual((await store.call('read', { ids: [first.note.id] })).missing, [first.note.id]);
  assert.equal((await store.call('list')).total, 0);
  assert.equal((await store.call('search', { query: 'v2' })).total, 0);
  assert.ok((await store.call('revision', { id: first.note.id, rev: 3 })).note.deleted_at);
  const reused = await store.call('create', fixture({ name: 'reusable', content: 'other' }));
  assert.notEqual(reused.note.id, first.note.id);
  await fail(() => store.call('create', fixture({ id: first.note.id, name: 'new name' })), 409);
  await fail(() => store.call('restore', { id: first.note.id, rev: 1, base_rev: 3 }), 409);
  await store.call('replace', { id: reused.note.id, name: 'renamed replacement', base_rev: 1 });
  const restored = await store.call('restore', { id: first.note.id, rev: 1, base_rev: 3 });
  assert.equal(restored.note.rev, 4);
  assert.equal(restored.note.deleted_at, null);
  assert.equal(restored.note.content, 'v1');
  assert.ok((await store.call('revision', { id: first.note.id, rev: 3 })).note.deleted_at);
  assert.equal((await store.call('history', { id: first.note.id })).total, 4);
});

test('task owner, force takeover, expiry, task updates and 20 contenders', async t => {
  const { store } = await storeFor(t);
  const created = await store.call('create', fixture({ kind: 'task', status: 'todo', metadata: { reference: 'https://example.invalid/inert' } }));
  const id = created.note.id;
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
    try { return { ok: true, result: store.execute('claim', params({ id, ttl_seconds: 1 }), actor(`contender-${i}`)) }; }
    catch (error) { return { ok: false, error }; }
  })));
  assert.equal(outcomes.filter(o => o.ok).length, 1);
  assert.equal(outcomes.filter(o => !o.ok && o.error.status === 409).length, 19);
  const winner = outcomes.find(o => o.ok).result.note.claimed_by;
  assert.ok(winner);
  assert.throws(() => store.execute('release', params({ id }), actor('intruder')), e => e.status === 409 || e.status === 403);
  await new Promise(resolve => setTimeout(resolve, 1150));
  const expired = store.execute('claim', params({ id, ttl_seconds: 60 }), actor('after-expiry'));
  assert.equal(expired.note.claimed_by, 'after-expiry');
  const forced = store.execute('claim', params({ id, force: true }), actor('override'));
  assert.equal(forced.note.claimed_by, 'override');
  const released = store.execute('release', params({ id }), actor('override'));
  assert.equal(released.note.claimed_by, null);
  assert.equal(released.note.claim_expires_at, null);
  const updated = await store.call('update_task', { id, base_rev: released.note.rev, status: 'done', due_at: '2030-01-02T03:04:05.000Z', metadata: { command: 'do-not-execute', nested: { inert: true } } });
  assert.equal(updated.note.status, 'done');
  assert.equal(updated.note.due_at, '2030-01-02T03:04:05.000Z');
  assert.deepEqual(updated.note.metadata, { command: 'do-not-execute', nested: { inert: true } });
  store.execute('claim', params({ id }), actor('lease-owner'));
  const forcedRelease = store.execute('release', params({ id, force: true }), actor('override-release'));
  assert.equal(forcedRelease.note.claimed_by, null);
  const audit = (await store.call('history', { id, limit: 100 })).events;
  assert.ok(audit.some(event => event.kind === 'claim_force' && event.attribution.principal === 'override'));
  assert.equal(audit.at(-1).kind, 'release_force');
  assert.equal(audit.at(-1).attribution.principal, 'override-release');
  const plain = await store.call('create', fixture());
  await assert.rejects(store.call('claim', { id: plain.note.id }));
  await assert.rejects(store.call('update_task', { id: plain.note.id, base_rev: 1, status: 'done' }));
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
