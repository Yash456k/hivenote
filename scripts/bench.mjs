#!/usr/bin/env node
// How fast HiveNote's own parts are on this machine: the store, the queen, a fresh command,
// many writers at once, and the queen's memory. Run it on the machine you care about
// (npm run bench); shared CI machines are too uneven for timings. --json prints JSON.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { execFileSync, fork, spawn } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { SqliteStore } from '../dist/sqlite.js';
import { HttpStore } from '../dist/client.js';
import { startServer } from '../dist/http.js';
import { sandbox, actor, cli, closeServer, root, serverUrl } from '../tests/helpers.mjs';

const NOTES = 300;
const dir = await sandbox(null, 'benchmark');
let store, server, queen;

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, p50_ms: +percentile(0.50).toFixed(2), p95_ms: +percentile(0.95).toFixed(2) };
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
/** One command started from nothing, the way an agent runs it. */
function command(args, env) {
  return () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`)));
  });
}

try {
  const db = join(dir, 'benchmark.sqlite');
  store = new SqliteStore(db, actor('benchmark', 'local'));
  const content = ('bounded benchmark fixture needle alpha beta gamma\n'.repeat(24)).slice(0, 1024);
  for (let i = 0; i < NOTES; i++) await store.call('create', { name: `benchmark-${String(i).padStart(3, '0')}`, description: 'Temporary benchmark fixture', content });
  const token = store.tokenCreate('benchmark-http', 'rw').token;
  server = await startServer(store, { host: '127.0.0.1', port: 0 });
  const url = serverUrl(server);
  const remote = new HttpStore(url, token);
  const reads = { read: { names: ['benchmark-150'] }, list: { offset: 0, limit: 100 }, search: { query: 'needle', limit: 20 } };

  const result = {
    machine: { cpu: cpus()[0]?.model.trim(), cores: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: process.platform, arch: process.arch },
    hive: { notes: NOTES, note_bytes: Buffer.byteLength(content) },
    store: {}, through_queen: {}, queen_load: {}, fresh_command: {}, many_writers: {}, queen_memory_mb: null,
  };

  // 1. The store by itself, and 2. the same calls through the queen on a connection that is already open.
  for (const [method, params] of Object.entries(reads)) {
    result.store[method] = await measure(() => store.call(method, params), 200);
    result.through_queen[method] = await measure(() => remote.call(method, params), 200);
  }
  result.store.append = await measure(() => store.call('append', { note: 'benchmark-000', body: 'progress line' }), 200);
  result.through_queen.append = await measure(() => remote.call('append', { note: 'benchmark-001', body: 'progress line' }), 200);

  // 3. Twenty workers asking the queen at once.
  const together = async (clients, each, work) => {
    const started = performance.now();
    await Promise.all(Array.from({ length: clients }, async () => { for (let i = 0; i < each; i++) await work(); }));
    return Math.round(clients * each / ((performance.now() - started) / 1000));
  };
  result.queen_load.reads_per_second = await together(20, 100, () => remote.call('read', reads.read));
  result.queen_load.appends_per_second = await together(20, 25, () => remote.call('append', { note: 'benchmark-002', body: 'progress line' }));

  // 4. One command from a cold start: Node by itself, then HiveNote on a local hive and through a queen.
  const base = { ...process.env, HIVENOTE_HOME: join(dir, 'config') };
  const local = { ...base, HIVENOTE_DB: db };
  const worker = { ...base, HIVENOTE_URL: url, HIVENOTE_TOKEN: token };
  result.fresh_command.node_doing_nothing = await measure(command(['-e', '0'], base), 30, 3);
  result.fresh_command.version = await measure(command([cli, '--version'], base), 30, 3);
  result.fresh_command.list_local = await measure(command([cli, 'list'], local), 30, 3);
  result.fresh_command.read_local = await measure(command([cli, 'read', 'benchmark-150'], local), 30, 3);
  result.fresh_command.read_through_queen = await measure(command([cli, 'read', 'benchmark-150'], worker), 30, 3);

  // 5. Ten processes each writing 100 times to one new file, all at once.
  const fresh = join(dir, 'writers.sqlite');
  const started = performance.now();
  const writers = await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve, reject) => {
    const child = fork(join(root, 'tests/writer.mjs'), [fresh, String(i), '100'], { cwd: root, silent: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.once('message', () => child.send({ go: true }));
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer ${i} exited ${code}`)));
  })));
  const seconds = (performance.now() - started) / 1000;
  const check = new SqliteStore(fresh, actor());
  const landed = (await check.call('changes', { tail: 1 })).cursor;
  check.close();
  assert.equal(landed, 1000, 'every write landed exactly once');
  result.many_writers = { processes: 10, writes: 1000, landed, seconds: +seconds.toFixed(2), writes_per_second: Math.round(1000 / seconds), told_to_wait: writers.reduce((sum, w) => sum + w.busy, 0) };

  // 6. What a queen holds in memory while nobody is asking.
  if (process.platform !== 'win32') {
    queen = spawn(process.execPath, [cli, 'serve', ':0'], { env: local, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => queen.stdout.once('data', resolve));
    await new Promise(resolve => setTimeout(resolve, 1500));
    result.queen_memory_mb = Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(queen.pid)], { encoding: 'utf8' }).trim()) / 1024);
  }

  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else {
    const row = (name, m) => `  ${name.padEnd(24)} ${String(m.p50_ms).padStart(7)} ms typical ${String(m.p95_ms).padStart(8)} ms slow (1 in 20)`;
    const m = result.machine;
    console.log([
      `HiveNote on ${m.cpu} (${m.cores} threads, ${m.memory_gb} GB), Node ${m.node}, ${m.platform} ${m.arch}`,
      `A hive of ${NOTES} notes, ${result.hive.note_bytes} bytes each.`,
      '', 'The store itself', ...Object.entries(result.store).map(([k, v]) => row(k, v)),
      '', 'Through the queen, connection already open, same machine', ...Object.entries(result.through_queen).map(([k, v]) => row(k, v)),
      '', 'The queen with 20 workers at once',
      `  ${result.queen_load.reads_per_second} reads a second, ${result.queen_load.appends_per_second} appends a second`,
      '', 'One command from a cold start', ...Object.entries(result.fresh_command).map(([k, v]) => row(k.replaceAll('_', ' '), v)),
      '', 'Ten processes writing 100 times each to one new file, all at once',
      `  ${result.many_writers.landed} of 1000 writes landed, in ${result.many_writers.seconds} s (${result.many_writers.writes_per_second} a second); a writer was told to wait and try again ${result.many_writers.told_to_wait} times`,
      ...(result.queen_memory_mb === null ? [] : ['', `A queen sitting idle holds ${result.queen_memory_mb} MB`]),
    ].join('\n'));
  }
} finally {
  queen?.kill();
  if (server) await closeServer(server);
  store?.close();
  await rm(dir, { recursive: true, force: true });
}
