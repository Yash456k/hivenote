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
  store.tokenRevoke(rw.device);
  await assert.rejects(client.call('list'), e => e.status === 401);
  // A committed receipt cannot bypass authentication after revocation.
  await assert.rejects(client.call('create', createParams), e => e.status === 401);
  assert.equal((await store.call('history', { id: created.note.id })).total, 1);
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

test('a client warns once when the hive runs a different release', async t => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json', 'x-hivenote-version': '0.1.0' });
    response.end(JSON.stringify({ result: { notes: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const warnings = [];
  const write = process.stderr.write;
  process.stderr.write = text => { warnings.push(String(text)); return true; };
  try {
    const client = new HttpStore(serverUrl(server), 'token');
    await client.call('list');
    await client.call('list');
  } finally {
    process.stderr.write = write;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /runs 0\.1\.0.*npm install -g hivenote@latest/u);
});
