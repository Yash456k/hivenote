// Bad-network test: W writes, each to its own counter note via append. A fraction
// of requests are aborted mid-flight (client never sees the answer) and resent with
// the SAME op_id, as a real client does after a dropped connection. Afterwards every
// note must hold exactly the progress lines that were intended: 0 lost, 0 doubled.
// Usage: node retry.mjs [writes=5000] [drop=0.3] [concurrency=50]
import { call, createNote, uuid, now, report, pool } from './lib.mjs';

const W = Number(process.argv[2] || 5000);
const DROP = Number(process.argv[3] || 0.3);
const C = Number(process.argv[4] || 50);
const NAIVE = process.argv[5] === 'naive'; // control: resend with a fresh op_id, like a client without idempotency keys
const tag = Date.now().toString(36);
const NOTES = 50;
for (let i = 0; i < NOTES; i++) await createNote(`rt-${tag}-${i}`, 'counter');

let dropped = 0, resent = 0;
const startSeq = (await call('changes', { tail: 1 })).result.cursor;
const t0 = now();
await pool(W, C, async i => {
  const note = `rt-${tag}-${i % NOTES}`;
  const op_id = uuid();
  const params = { note, body: `w${i}`, op_id };
  for (let attempt = 0; ; attempt++) {
    if (attempt === 0 && Math.random() < DROP) {
      // Drop the connection after the request is sent (abort at a random point).
      const ac = new AbortController();
      setTimeout(() => ac.abort(), Math.random() * 15);
      try { await call('append', params, 'flaky', { signal: ac.signal }); } catch { dropped++; resent++; if (NAIVE) params.op_id = uuid(); continue; }
      return; // finished before the abort fired
    }
    const r = await call('append', params, 'flaky');
    if (r.error) throw new Error(JSON.stringify(r.error));
    return;
  }
});
// Verify from the global event feed: every w<i> append must appear exactly once.
const seen = new Map();
let cursor = startSeq;
for (;;) {
  const r = await call('changes', { since: cursor, limit: 100 });
  for (const e of r.result.events) {
    if (e.kind !== 'append') continue;
    const body = e.body ?? e.text ?? (JSON.stringify(e).match(/"(w\d+)"/) || [])[1];
    if (body) seen.set(body, (seen.get(body) || 0) + 1);
  }
  cursor = r.result.cursor;
  if (!r.result.has_more) break;
}
let lost = 0, doubled = 0;
for (let i = 0; i < W; i++) { const c = seen.get(`w${i}`) || 0; if (c === 0) lost++; if (c > 1) doubled++; }
report('retry', { client: NAIVE ? 'naive (new id on resend)' : 'hivenote (same op_id)', writes: W, drop_rate: DROP, connections_dropped: dropped, resends: resent,
  lost, doubled, wall_s: Math.round((now() - t0) / 100) / 10 });
