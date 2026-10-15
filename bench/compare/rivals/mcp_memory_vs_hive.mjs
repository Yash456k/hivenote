// Official MCP memory server (@modelcontextprotocol/server-memory 1.0.0) vs HiveNote.
// Each "agent" is its own stdio MCP server process pointed at ONE shared memory file,
// which is how several Claude Code / Cursor sessions share it. Each agent adds K
// observations to a shared entity; we then check every observation landed exactly once,
// and measure per-write latency as the store grows (pre-seeded with S entities).
// HiveNote arm: the same agents append the same lines to one note via the queen.
// Usage: node mcp_memory_vs_hive.mjs [agents=10] [writes=20] [seed=0]
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { call, createNote, uuid, now, stats, report } from '../lib.mjs';

const N = Number(process.argv[2] || 10), K = Number(process.argv[3] || 20), SEED = Number(process.argv[4] || 0);
// npm install --prefix "$MCP_MEMORY_DIR" @modelcontextprotocol/server-memory@1.0.0  (run.sh does this)
const DEPS = process.env.MCP_MEMORY_DIR;
if (!DEPS) throw new Error('Set MCP_MEMORY_DIR to a folder with @modelcontextprotocol/server-memory installed');
const NM = join(DEPS, 'node_modules');
const { Client } = await import(join(NM, '@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const { StdioClientTransport } = await import(join(NM, '@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));
const SERVER = join(NM, '@modelcontextprotocol/server-memory/dist/index.js');
const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'mcpmem-'));
const file = join(dir, 'memory.jsonl');
const filler = 'Observed detail about the service configuration and the decision behind it.';
const seedLines = [JSON.stringify({ type: 'entity', name: 'shared', entityType: 'project', observations: [] })];
for (let i = 0; i < SEED; i++) seedLines.push(JSON.stringify({ type: 'entity', name: `e${i}`, entityType: 'note', observations: [filler, filler + ' ' + i] }));
writeFileSync(file, seedLines.join('\n') + '\n');

const clients = await Promise.all(Array.from({ length: N }, async (_, i) => {
  const c = new Client({ name: `agent${i}`, version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, MEMORY_FILE_PATH: file }, stderr: 'ignore' }));
  return c;
}));
const mlat = []; let merr = 0;
let t0 = now();
await Promise.all(clients.map(async (c, i) => {
  for (let k = 0; k < K; k++) {
    const s = now();
    const r = await c.callTool({ name: 'add_observations', arguments: { observations: [{ entityName: 'shared', contents: [`agent${i} update${k}`] }] } });
    mlat.push(now() - s); if (r.isError) merr++;
  }
}));
const mwall = now() - t0;
await Promise.all(clients.map(c => c.close()));
const shared = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.name === 'shared');
const got = shared.observations.filter(o => o.startsWith('agent'));
const want = new Set(Array.from({ length: N * K }, (_, j) => `agent${Math.floor(j / K)} update${j % K}`));
report('mcp_memory_vs_hive', { arm: 'mcp-memory 1.0.0 (one process per agent, shared file)', agents: N, writes_each: K, store_entities: SEED,
  wall_s: Math.round(mwall) / 1000, write_latency_ms: stats(mlat), errors: merr,
  missing: [...want].filter(w => !got.includes(w)).length, duplicated: got.length - new Set(got).size });
rmSync(dir, { recursive: true, force: true });

// HiveNote arm: same store size, same workload.
const tag = Date.now().toString(36);
for (let i = 0; i < SEED; i += 50) await Promise.all(Array.from({ length: Math.min(50, SEED - i) }, (_, j) => createNote(`mvh-${tag}-${i + j}`, filler)));
const name = `mvh-${tag}-shared`; await createNote(name, 'shared');
const head = (await call('changes', { tail: 1 })).result.cursor;
const hlat = []; let herr = 0;
t0 = now();
await Promise.all(Array.from({ length: N }, async (_, i) => {
  for (let k = 0; k < K; k++) {
    const s = now();
    const r = await call('append', { note: name, body: `agent${i} update${k}`, op_id: uuid() }, `agent${i}`);
    hlat.push(now() - s); if (r.error) herr++;
  }
}));
const hwall = now() - t0;
const lines = []; let cur = head;
for (;;) { const r = (await call('changes', { since: cur, limit: 100 })).result; lines.push(...r.events.filter(e => e.kind === 'append').map(e => e.body)); cur = r.cursor; if (!r.has_more) break; }
report('mcp_memory_vs_hive', { arm: 'hivenote 0.5.0', agents: N, writes_each: K, store_entities: SEED,
  wall_s: Math.round(hwall) / 1000, write_latency_ms: stats(hlat), errors: herr,
  missing: [...want].filter(w => !lines.includes(w)).length, duplicated: lines.length - new Set(lines).size });
