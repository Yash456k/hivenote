// Crash test: start a private queen, have C agents append continuously, and kill -9
// the queen at a random moment, R times. After each restart, every write the queen
// had acknowledged must be there exactly once; writes that were in flight are resent
// with the same op_id and must also end up exactly once. Agents retry until the queen
// is back, like the real client does.
// Usage: node crash.mjs [crashes=20] [agents=20]
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { randomUUID as uuid } from 'node:crypto';

const R = Number(process.argv[2] || 20), C = Number(process.argv[3] || 20);
const PORT = 7511;
const home = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'hncrash-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HIVENOTE_'))), HIVENOTE_HOME: home };
const TOKEN = JSON.parse(execFileSync('hivenote', ['token', 'add', 'crash', '--json'], { env }).toString()).token;
const agentPool = new http.Agent({ keepAlive: false });

function call(method, params) {
  const payload = JSON.stringify({ method, params, agent: 'crash' });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/call', method: 'POST', agent: agentPool, timeout: 5000,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(payload);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let queen;
async function startQueen() {
  queen = spawn('hivenote', ['serve', `127.0.0.1:${PORT}`], { env, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {} await sleep(25); }
  throw new Error('queen did not start');
}

try {
await startQueen();
const NOTE = 'crash-log';
await call('create', { id: uuid(), name: NOTE, description: 'crash test', content: 'x', op_id: uuid() });
const acked = new Set(); const intended = new Set();
let stop = false, retries = 0, busy = 0;
const writers = Array.from({ length: C }, async (_, a) => {
  for (let k = 0; !stop; k++) {
    const body = `a${a}-${k}`; const op_id = uuid(); intended.add(body);
    for (;;) {
      try {
        const r = await call('append', { note: NOTE, body, op_id });
        if (r.result) { acked.add(body); break; }
        if (r.error?.code === 'busy') { busy++; await sleep(20); continue; }
        throw new Error(JSON.stringify(r.error));
      } catch (e) { if (String(e.message).startsWith('{')) throw e; retries++; await sleep(50); }
    }
  }
});
for (let r = 0; r < R; r++) {
  await sleep(300 + Math.random() * 1200);
  queen.kill('SIGKILL');
  await new Promise(res => queen.once('exit', res));
  await sleep(100 + Math.random() * 400);
  await startQueen();
  process.stderr.write(`crash ${r + 1}/${R}, acked so far ${acked.size}\n`);
}
await sleep(1000); stop = true; await Promise.all(writers);
// Count what the hive holds.
const counts = new Map(); let cursor = 0;
for (;;) { const r = (await call('changes', { since: cursor, limit: 100 })).result;
  for (const e of r.events) if (e.kind === 'append') counts.set(e.body, (counts.get(e.body) || 0) + 1);
  cursor = r.cursor; if (!r.has_more) break; }
let lostAcked = 0, doubled = 0, lostIntended = 0;
for (const b of acked) if (!counts.has(b)) lostAcked++;
for (const b of intended) if (!counts.has(b)) lostIntended++;
for (const [, c] of counts) if (c > 1) doubled++;
const integrity = execFileSync('node', ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('PRAGMA integrity_check').get().integrity_check)`, join(home, 'data.db')]).toString().trim();
queen.kill('SIGKILL');
console.log(JSON.stringify({ bench: 'crash', kill9_crashes: R, agents: C, writes_acknowledged: acked.size, writes_attempted: intended.size,
  acknowledged_lost: lostAcked, attempted_lost: lostIntended, duplicated: doubled, client_retries: retries, busy_answers: busy, sqlite_integrity: integrity }));
} finally {
  queen?.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
}

