// Shared helpers for the HiveNote benchmarks: a tiny HTTP client for the queen's
// POST /v1/call API, timing, and percentile stats. No dependencies.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const URL_BASE = process.env.HN_URL || 'http://127.0.0.1:7499';
export const TOKEN = process.env.HN_TOKEN;
if (!TOKEN) throw new Error('Set HN_URL and HN_TOKEN (bench/compare/run.sh does this for you)');

export const now = () => Number(process.hrtime.bigint()) / 1e6; // ms

// Plain node:http with a keep-alive agent. (Node 26's built-in fetch added
// 0.4 to 2 s stalls after idle gaps in this setup while curl answered in ~4 ms,
// so fetch would have measured the client, not HiveNote.)
const target = new URL(URL_BASE);
const httpMod = target.protocol === 'https:' ? https : http;
const agentPool = new httpMod.Agent({ keepAlive: true, maxSockets: 512 });

export function call(method, params = {}, agent = 'bench', { signal } = {}) {
  const payload = JSON.stringify({ method, params, agent });
  return new Promise((resolve, reject) => {
    const req = httpMod.request({
      hostname: target.hostname, port: target.port, path: '/v1/call', method: 'POST', agent: agentPool,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      signal,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(data) }); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export function uuid() { return randomUUID(); }

export async function createTask(name, agent = 'planner') {
  const r = await call('create', { id: uuid(), name, description: 'bench task', content: 'x', kind: 'task', op_id: uuid() }, agent);
  if (r.error) throw new Error(`create ${name}: ${JSON.stringify(r.error)}`);
  return r;
}

export async function createNote(name, content, agent = 'bench') {
  const r = await call('create', { id: uuid(), name, description: `note ${name}`, content, op_id: uuid() }, agent);
  if (r.error) throw new Error(`create ${name}: ${JSON.stringify(r.error)}`);
  return r;
}

export function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r = v => Math.round(v * 100) / 100;
  return { n: s.length, mean: r(mean), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

// Run `fn(i)` for i in [0,total) with at most `conc` in flight.
export async function pool(total, conc, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(conc, total) }, async () => {
    while (next < total) { const i = next++; await fn(i); }
  });
  await Promise.all(workers);
}

export function report(name, obj) {
  const line = JSON.stringify({ bench: name, at: new Date().toISOString(), ...obj });
  console.log(line);
  return obj;
}
