#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { SqliteStore } from '../dist/sqlite.js';
import { HttpStore } from '../dist/client.js';
import { startServer } from '../dist/http.js';
import { sandbox, actor, cliJson, closeServer, serverUrl } from '../tests/helpers.mjs';

const dir = await sandbox(null, 'benchmark');
let store, server;
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, p50_ms: +percentile(0.50).toFixed(3), p95_ms: +percentile(0.95).toFixed(3), min_ms: +sorted[0].toFixed(3), max_ms: +sorted.at(-1).toFixed(3) };
}
async function measure(fn, iterations, warmup = 10) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return summary(samples);
}
try {
  const db = join(dir, 'benchmark.sqlite');
  store = new SqliteStore(db, actor('benchmark', 'local'));
  const ids = [];
  const content = ('bounded benchmark fixture needle alpha beta gamma\n'.repeat(24)).slice(0, 1024);
  for (let i = 0; i < 300; i++) {
    const result = await store.call('create', { name: `benchmark-${String(i).padStart(3, '0')}`, description: 'Temporary benchmark fixture', content });
    ids.push(result.note.id);
  }
  assert.equal((await store.call('list', { limit: 1 })).total, 300);
  const token = store.tokenCreate('benchmark-http', 'rw');
  server = await startServer(store, { host: '127.0.0.1', port: 0 });
  const remote = new HttpStore(serverUrl(server), token.token);
  const operations = {
    read: { ids: [ids[150]] },
    list: { offset: 0, limit: 20 },
    search: { query: 'needle', limit: 20 },
  };
  const measurements = {};
  for (const [method, params] of Object.entries(operations)) {
    measurements[`local_${method}`] = await measure(() => store.call(method, params), 100);
    measurements[`warm_http_${method}`] = await measure(() => remote.call(method, params), 100);
    measurements[`cold_cli_${method}`] = await measure(() => cliJson(['--db', db, method, '--params', JSON.stringify(params)], { env: { HIVENOTE_HOME: join(dir, 'config') } }), 10, 0);
  }
  measurements.local_append = await measure(() => store.call('append', { id: ids[0], body: 'bounded benchmark activity' }), 100);
  measurements.warm_http_append = await measure(() => remote.call('append', { id: ids[1], body: 'bounded benchmark activity' }), 100);
  const final = await store.call('list', { limit: 1 });
  assert.equal(final.total, 300);
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, fixture_notes: 300, fixture_content_bytes: Buffer.byteLength(content), clock: 'performance.now; wall-clock elapsed milliseconds', percentile: 'nearest-rank', warmup_calls: 10, cold_cli_warmup: 0, measurements }, null, 2));
} finally {
  if (server) await closeServer(server);
  store?.close();
  await rm(dir, { recursive: true, force: true });
}
