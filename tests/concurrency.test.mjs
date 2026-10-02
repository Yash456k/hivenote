import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { sandbox, root, actor, fixture } from './helpers.mjs';

async function processes(t, args, count) {
  const entries = Array.from({ length: count }, (_, i) => {
    const child = fork(join(root, 'tests/writer.mjs'), args(i), { cwd: root, silent: true });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.once('message', message => message.ready ? resolve() : reject(new Error('Invalid worker readiness')));
      child.once('error', reject);
      child.once('exit', code => { if (code !== 0) reject(new Error(`Worker ${i} exited before barrier: ${stderr}`)); });
    });
    const result = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code !== 0) return reject(new Error(`Worker ${i} failed (${code}/${signal}): ${stderr}\n${stdout}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    });
    // Attach a handler immediately: workers may fail before the barrier resolves.
    result.catch(() => {});
    return { child, ready, result };
  });
  await Promise.all(entries.map(e => e.ready));
  for (const { child } of entries) child.send({ go: true });
  return Promise.all(entries.map(e => e.result));
}

test('10 real processes × 100 writes survive simultaneous fresh-database initialization', { timeout: 180_000 }, async t => {
  const dir = await sandbox(t, 'multiprocess');
  const path = join(dir, 'fresh.sqlite'); // No parent Store: all ten processes race initial schema setup.
  const results = await processes(t, i => [path, String(i), '100'], 10);
  assert.equal(results.length, 10);
  assert.equal(results.reduce((sum, r) => sum + r.writes, 0), 1000);
  assert.ok(results.every(r => r.rev === 100));
  const store = new SqliteStore(path, actor());
  t.after(() => store.close());
  assert.equal((await store.call('list', { limit: 100 })).total, 10);
  const seqs = new Set();
  let cursor = 0, count = 0;
  for (;;) {
    const page = await store.call('changes', { since: cursor, limit: 100 });
    for (const event of page.events) { seqs.add(event.seq); count++; }
    cursor = page.cursor;
    if (!page.has_more) break;
  }
  assert.equal(count, 1000);
  assert.equal(seqs.size, 1000);
  assert.equal(cursor, 1000);
  for (const result of results) {
    const note = (await store.call('read', { ids: [result.id] })).notes[0];
    assert.equal(note.rev, 100);
    assert.equal(note.content, `${result.worker}:99`);
    assert.equal((await store.call('history', { id: result.id })).total, 100);
    assert.equal((await store.call('revision', { id: result.id, rev: 1 })).note.content, `${result.worker}:0`);
    assert.equal((await store.call('revision', { id: result.id, rev: 50 })).note.content, `${result.worker}:49`);
  }
});

