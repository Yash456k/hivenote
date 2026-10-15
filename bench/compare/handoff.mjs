// Handoff latency: a waiter holds `changes {since, hold}` open (what `hivenote wait`
// does); a builder marks the task done. Measures time from the builder's request
// being sent to the waiter receiving the event. Compared with the 0.4 behaviour
// (poll every 5 s) analytically: expected delay = interval/2.
// Usage: node handoff.mjs [trials=200]
import { call, createTask, uuid, now, stats, report } from './lib.mjs';

const TRIALS = Number(process.argv[2] || 200);
const tag = Date.now().toString(36);
const lat = [], doneReq = [];
let missed = 0;

for (let t = 0; t < TRIALS; t++) {
  const name = `handoff-${tag}-${t}`;
  await createTask(name);
  await call('update_task', { note: name, status: 'doing', claim: true, op_id: uuid() }, 'builder');
  const tail = await call('changes', { tail: 1 });
  const since = tail.result.cursor;
  let sentAt = 0;
  const waiter = (async () => {
    let cursor = since;
    for (;;) {
      const r = await call('changes', { since: cursor, hold: 8000 }, 'reviewer');
      const got = now();
      for (const e of r.result.events) {
        if (e.note?.name === name || e.name === name || JSON.stringify(e).includes(name)) {
          if (JSON.stringify(e).includes('"done"')) return got;
        }
      }
      cursor = r.result.cursor;
      if (!r.result.events.length) return null;
    }
  })();
  await new Promise(r => setTimeout(r, 500 + Math.random() * 1500)); // waiter is parked
  sentAt = now();
  await call('update_task', { note: name, status: 'done', op_id: uuid() }, 'builder');
  doneReq.push(now() - sentAt);
  const gotAt = await waiter;
  if (gotAt == null) missed++; else lat.push(gotAt - sentAt);
}
report('handoff', {
  trials: TRIALS, missed, wake_latency_ms: stats(lat), done_request_ms: stats(doneReq),
  polling_5s_expected_mean_ms: 2500,
});
