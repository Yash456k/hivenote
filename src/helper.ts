import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientParams, HiveNoteError, VERSION, type Method, type Params, type Store } from './contract.js';
import { HttpStore, warnOnOtherVersion } from './client.js';
import { configDirectory } from './config.js';

/**
 * The connection helper: a small background process on a worker that keeps one
 * connection to the queen open.
 *
 * Every command is its own process, and opening a connection to a queen far away costs
 * more than the request itself (about 300 ms of a 570 ms command, India to Germany).
 * The first command on a worker starts the helper and goes to the queen directly; the
 * ones after it hand their request to the helper over a local socket. The helper leaves
 * after ten idle minutes. If it is missing, slow or refuses, the command goes to the
 * queen directly, exactly as it did before there was a helper.
 *
 * One helper serves one queen with one token on one version of HiveNote: all three are
 * in its socket's name, so connecting elsewhere or updating simply starts another.
 */

/**
 * Whether this machine uses a helper, and how long one stays idle. People set it with a
 * "helper" line in config.json, or with HIVENOTE_HELPER for one command; the variable wins.
 * "off" (or 0) never uses a helper, a number is the idle seconds, anything else is the default.
 */
export function helperPlan(configured?: string): { enabled: boolean; idleMs: number } {
  const setting = (process.env.HIVENOTE_HELPER?.trim() || configured || 'on').toLowerCase();
  return { enabled: setting !== 'off' && setting !== '0', idleMs: (/^\d+$/u.test(setting) ? Number(setting) : 600) * 1000 };
}

const LIMIT = 6 * 1024 * 1024;   // one answer is at most 5 MB
type Labels = { agent?: string; session?: string };
interface Ask { key: string; method: Method; params: Params; agent?: string; session?: string }
interface Reply { result?: unknown; error?: { code: string; message: string; status: number; details?: unknown }; version?: string | null }

/** Where the helper for this queen and token listens: a socket file, or a named pipe on Windows. */
function address(url: string, token: string): string {
  const id = createHash('sha256').update(`${VERSION}\n${url}\n${token}`).digest('hex').slice(0, 16);
  if (process.platform === 'win32') return `\\\\.\\pipe\\hivenote-${id}`;
  const path = join(configDirectory(), `helper-${id}.sock`);
  // A socket path has a short length limit (about 100 bytes); a deep settings folder goes over it.
  return Buffer.byteLength(path) <= 100 ? path : join(tmpdir(), `hivenote-${userInfo().uid}-${id}.sock`);
}

/** What a command shows the helper to prove it holds the same token. The token itself never crosses. */
function key(token: string): string {
  return createHash('sha256').update(`hivenote helper\n${token}`).digest('hex');
}

/**
 * fetch over a connection that stays open between requests. Node's own fetch drops an
 * idle connection after four seconds, which is shorter than the gap between an agent's
 * commands, so the helper and the MCP server use this instead.
 */
export function keepAliveFetch(): typeof fetch {
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
  return (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input));
    const secure = url.protocol === 'https:';
    const request = (secure ? https : http).request(url, {
      method: init.method ?? 'GET', agent: agents[secure ? 'https:' : 'http:'],
      headers: init.headers as Record<string, string> | undefined ?? {},
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const status = response.statusCode ?? 502;
        try { resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })); }
        catch (error) { reject(error as Error); }
      });
    });
    request.once('error', reject);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) request.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => { request.destroy(new Error('aborted')); }, { once: true });
    }
    request.end(typeof init.body === 'string' ? init.body : undefined);
  });
}

// ---------- The command's side ----------

/** One request handed to the helper. Rejects with a plain Error when there is no helper to use. */
function ask(path: string, message: Ask): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    let text = '';
    // The helper retries a busy or unreachable queen itself; past this it is stuck.
    const timer = setTimeout(() => { socket.destroy(new Error('helper timed out')); }, 45000);
    socket.setEncoding('utf8');
    socket.once('connect', () => { socket.write(JSON.stringify(message) + '\n'); });
    socket.on('data', (chunk: string) => { text += chunk; if (text.length > LIMIT) socket.destroy(new Error('helper answer too large')); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(text) as Reply); } catch { reject(new Error('helper gave no answer')); }
    });
  });
}

let started = false;
/** Start a helper in the background, once per command. It outlives the command that started it. */
function start(): void {
  if (started) return;
  started = true;
  try {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    spawn(process.execPath, [cli, '__helper'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* no helper; every command still works without one */ }
}

/** The queen's hive on a worker: through the helper when one is running, directly otherwise. */
export class HelperStore implements Store {
  private readonly direct: HttpStore;
  private readonly path: string;
  private readonly key: string;
  private versionChecked = false;
  constructor(private readonly url: string, token: string, private readonly labels: Labels = {}) {
    this.direct = new HttpStore(url, token, labels);
    this.path = address(url, token);
    this.key = key(token);
  }
  async call(method: Method, params: Params = {}): Promise<unknown> {
    // A write gets its id here, so going to the queen directly after a helper that
    // stopped half way can never apply it twice.
    const prepared = clientParams(method, params);
    let reply: Reply;
    try {
      reply = await ask(this.path, { key: this.key, method, params: prepared, ...this.labels });
      if (reply.error?.code === 'helper_refused') throw new Error('helper refused');
    } catch {
      start();
      return this.direct.call(method, prepared);
    }
    if (reply.version && !this.versionChecked) {
      this.versionChecked = true;
      warnOnOtherVersion(reply.version, new URL(this.url).origin);
    }
    if (reply.error) throw new HiveNoteError(reply.error.code, reply.error.message, reply.error.status, reply.error.details);
    return reply.result;
  }
  close(): void {}
}

/** Whether a helper for this queen and token is answering right now. */
export function helperRunning(url: string, token: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(address(url, token));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { resolve(false); });
  });
}

// ---------- The helper's side ----------

export async function runHelper(url: string, token: string, idleMs: number): Promise<void> {
  const path = address(url, token);
  // Another helper may already be listening; one that crashed leaves its socket file behind.
  if (await helperRunning(url, token)) return;
  if (process.platform !== 'win32') {
    // A machine that uses HIVENOTE_URL without ever running connect has no settings folder yet.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
  }

  const kept = keepAliveFetch();
  const expected = Buffer.from(key(token));
  let leave: NodeJS.Timeout;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('error', () => { /* the command went away */ });
    socket.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > 2 * 1024 * 1024) { socket.destroy(); return; }
      if (!text.includes('\n')) return;
      socket.pause();
      leave.refresh();
      void answer(text.slice(0, text.indexOf('\n'))).then(reply => { socket.end(JSON.stringify(reply)); });
    });
  });

  const answer = async (line: string): Promise<Reply> => {
    let request: Ask;
    try { request = JSON.parse(line) as Ask; } catch { return { error: { code: 'helper_refused', message: 'Not a request', status: 400 } }; }
    const given = Buffer.from(String(request.key));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: { code: 'helper_refused', message: 'Wrong key', status: 401 } };
    const labels: Labels = {};
    if (typeof request.agent === 'string') labels.agent = request.agent;
    if (typeof request.session === 'string') labels.session = request.session;
    let store: HttpStore | undefined;
    try {
      store = new HttpStore(url, token, { ...labels, fetch: kept, quiet: true });
      return { result: await store.call(request.method, request.params), version: store.serverVersion };
    } catch (error) {
      const e = error instanceof HiveNoteError ? error : new HiveNoteError('internal_error', 'Operation failed', 500);
      return { error: { code: e.code, message: e.message, status: e.status, ...(e.details === undefined ? {} : { details: e.details }) }, version: store?.serverVersion ?? null };
    }
  };

  const stop = (): void => {
    server.close();
    if (process.platform !== 'win32') rmSync(path, { force: true });
    process.exit(0);
  };
  leave = setTimeout(stop, idleMs);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // A second helper started in the same moment loses the address and leaves.
  server.once('error', () => { process.exit(0); });
  server.listen(path, () => {
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    // Open the connection now, and touch it now and then so nothing in between closes it as idle.
    const touch = (): void => { void kept(new URL('/health', url)).then(response => response.arrayBuffer()).catch(() => { /* the queen is away; requests will say so */ }); };
    touch();
    setInterval(touch, 30000).unref();
  });
}
