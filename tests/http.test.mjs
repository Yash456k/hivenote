import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { HttpStore } from '../dist/client.js';
import { startServer } from '../dist/http.js';
import { actor, fixture, params, sandbox, serverUrl, closeServer, root } from './helpers.mjs';

async function setup(t, options = {}) {
  const dir = await sandbox(t, 'http');
  const store = new SqliteStore(join(dir, 'server.sqlite'), actor());
  const rw = store.tokenCreate('rw-device', 'rw');
  const ro = store.tokenCreate('ro-device', 'ro');
  const server = await startServer(store, { host: '127.0.0.1', port: 0, ...options });
  t.after(async () => { await closeServer(server); store.close(); });
  const url = serverUrl(server);
  return { store, rw, ro, url, client: new HttpStore(url, rw.token) };
}

async function raw(url, token, body, extra = {}) {
  const response = await fetch(`${url}/v1/call`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function chunkedOversize(url, token) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${url}/v1/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.write('{"method":"create","params":{"content":"');
    for (let i = 0; i < 18; i++) request.write('x'.repeat(65536));
    request.end('"}}');
  });
}

test('HTTP requires valid bearer auth, enforces ro/rw and immediately honors revocation', async t => {
  const { store, rw, ro, url, client } = await setup(t);
  const createParams = params(fixture({ name: 'auth fixture' }));
  assert.equal((await raw(url, null, { method: 'list' })).status, 401);
  assert.equal((await raw(url, 'incorrect-token', { method: 'list' })).status, 401);
  assert.equal((await raw(url, null, '{not-json')).status, 401);
  const created = await client.call('create', createParams);
  const reader = new HttpStore(url, ro.token);
  assert.equal((await reader.call('read', { ids: [created.note.id] })).notes[0].id, created.note.id);
  await assert.rejects(reader.call('create', createParams), e => e.status === 403);
  await assert.rejects(reader.call('append', { id: created.note.id, body: 'not allowed' }), e => e.status === 403);
  for (const method of ['edit', 'replace', 'delete', 'restore', 'claim', 'release', 'update_task']) {
    await assert.rejects(reader.call(method, { id: created.note.id }), e => e.status === 403, `ro ${method}`);
  }
  const listed = store.tokenList();
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes(rw.token));
  assert.ok(!serialized.includes(ro.token));
  assert.ok(!/"(?:hash|token_hash|secret|token)"\s*:/u.test(serialized));
  store.tokenRevoke(rw.id);
  await assert.rejects(client.call('list'), e => e.status === 401);
  // A committed receipt cannot bypass authentication after revocation.
  await assert.rejects(client.call('create', createParams), e => e.status === 401);
  assert.equal((await store.call('history', { id: created.note.id })).total, 1);
});

test('HTTP rejects malformed, oversize, prototype methods and spoofed attribution without writes', async t => {
  const { store, rw, url } = await setup(t);
  const cases = [
    ['{', 400], [null, 400], [[], 400], [{ method: 'create', params: [] }, 400],
    [{ method: '__proto__', params: {} }, 400], [{ method: 'constructor', params: {} }, 400], [{ method: 'toString', params: {} }, 400],
    [{ method: 'not-a-method' }, 400], [{ method: 'list', unexpected: true }, 400],
    [{ method: 'list', principal: 'root' }, 400],
    [{ method: 'create', params: params(fixture({ principal: 'root' })) }, 400],
    [{ method: 'create', params: params(fixture({ device: 'forged', verified: true })) }, 400],
    [{ method: 'create', params: params(fixture({ actor: { principal: 'root' } })) }, 400],
    ['{"method":"list","params":{"__proto__":{"principal":"root"}}}', 400],
    [{ method: 'create', params: params(fixture()), agent: {} }, 400],
    [{ method: 'create', params: params(fixture()), session: 'x'.repeat(257) }, 400],
  ];
  for (const [body, status] of cases) {
    const result = await raw(url, rw.token, body);
    assert.equal(result.status, status, JSON.stringify(body));
    assert.equal(typeof result.body.error.code, 'string');
  }
  const tooLarge = await raw(url, rw.token, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(tooLarge.status, 413);
  assert.equal((await chunkedOversize(url, rw.token)).status, 413);
  assert.equal((await raw(url, rw.token, '{}', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(`${url}/unknown`)).status, 404);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await store.call('list')).total, 0);
  assert.deepEqual((await store.call('changes')).events, []);
  assert.equal({}.principal, undefined);
});

test('response lost after commit: retry returns original receipt, one event, actor/intent conflicts', async t => {
  const { store, rw, url } = await setup(t, { dropResponseOnce: true });
  const client = new HttpStore(url, rw.token, { retries: 2, timeoutMs: 3000, agent: 'sdk-regression', session: 'session-1' });
  const request = params(fixture({ name: 'lost response', content: 'original receipt' }));
  const created = await client.call('create', request);
  assert.equal(created.note.rev, 1);
  assert.equal(created.note.last_attribution.principal, rw.principal);
  assert.equal(created.note.last_attribution.device, rw.device);
  assert.equal(created.note.last_attribution.verified, true);
  assert.equal(created.note.last_attribution.agent, 'sdk-regression');
  assert.equal(created.note.last_attribution.session, 'session-1');
  assert.equal((await store.call('history', { id: created.note.id })).total, 1);
  await client.call('replace', { id: created.note.id, content: 'later revision', base_rev: 1 });
  assert.deepEqual(await client.call('create', request), created);
  await assert.rejects(client.call('create', { ...request, content: 'different' }), e => e.status === 409);
  const other = store.tokenCreate('other-device', 'rw');
  await assert.rejects(new HttpStore(url, other.token).call('create', request), e => e.status === 409);
  assert.equal((await store.call('history', { id: created.note.id })).total, 2);
});

test('20 simultaneous HTTP claim requests have one owner and nineteen conflicts', async t => {
  const { store, client, url } = await setup(t);
  const { note } = await client.call('create', fixture({ kind: 'task' }));
  const contenders = Array.from({ length: 20 }, (_, i) => store.tokenCreate(`claim-${i}`, 'rw'));
  const results = await Promise.allSettled(contenders.map(token => new HttpStore(url, token.token).call('claim', { id: note.id, ttl_seconds: 60 })));
  const won = results.filter(r => r.status === 'fulfilled');
  const lost = results.filter(r => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 19);
  assert.ok(lost.every(r => r.reason.status === 409));
  const current = (await client.call('read', { ids: [note.id] })).notes[0];
  assert.equal(current.claimed_by, won[0].value.note.claimed_by);
  assert.equal((await client.call('history', { id: note.id })).total, 2);
});

test('remote client dependency graph is SQLite-free and rejects invalid origins', async () => {
  // Follow emitted static relative imports, not merely the top-level source file.
  const visited = new Set();
  async function inspect(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const code = await readFile(path, 'utf8');
    assert.ok(!/node:sqlite|(?:from|import\s*\()\s*['"][^'"]*sqlite/iu.test(code), path);
    for (const match of code.matchAll(/(?:from\s*|import\s*)['"](\.\/[^'"]+)['"]/gu)) {
      await inspect(join(root, 'dist', match[1]));
    }
  }
  await inspect(join(root, 'dist/client.js'));
  for (const url of ['file:///tmp/a', 'http://user:pass@example.invalid', 'http://example.invalid/path', 'http://example.invalid?x=1', 'not-url']) {
    assert.throws(() => new HttpStore(url, 'token'));
  }
});
