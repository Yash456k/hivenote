// Throughput: C concurrent agents each issue appends (writes) or reads against the
// queen for D seconds. Reports ops/s and latency percentiles.
// Usage: node throughput.mjs [mode=write|read|mixed] [concurrency=50] [seconds=20]
import { call, createNote, uuid, now, stats, report } from './lib.mjs';

const MODE = process.argv[2] || 'write';
const C = Number(process.argv[3] || 50);
const SECS = Number(process.argv[4] || 20);
const tag = Date.now().toString(36);
const NOTES = 20;
for (let i = 0; i < NOTES; i++) await createNote(`tp-${tag}-${i}`, 'seed text '.repeat(50));

const lat = [];
let ok = 0, err = 0;
const end = now() + SECS * 1000;
await Promise.all(Array.from({ length: C }, async (_, a) => {
  let k = 0;
  while (now() < end) {
    const note = `tp-${tag}-${(a + k++) % NOTES}`;
    const write = MODE === 'write' || (MODE === 'mixed' && k % 5 === 0);
    const s = now();
    const r = write
      ? await call('append', { note, body: `agent ${a} step ${k}`, op_id: uuid() }, `agent-${a}`)
      : await call('read', { names: [note] }, `agent-${a}`);
    lat.push(now() - s);
    if (r.error) err++; else ok++;
  }
}));
report('throughput', { mode: MODE, concurrency: C, seconds: SECS, ok, errors: err,
  ops_per_s: Math.round(ok / SECS), latency_ms: stats(lat) });
