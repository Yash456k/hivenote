import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMethod, MUTATIONS, HiveNoteError, type Actor, type Method, type Params } from './contract.js';

export interface ServerStore { authenticate(token: string): Actor; execute(method: Method, params: Params, actor: Actor): unknown; }
export interface ServerOptions {
  host?: string; port?: number; dropResponseOnce?: boolean;
  /** `hivenote ui`: let this machine's browser read without a token. Writes still need one. */
  localViewer?: boolean;
}
const LIMIT = 1024 * 1024;

/**
 * The live dashboard is a static page served from the package's ui/ folder. It reads
 * data through POST /v1/call with the viewer's own token, like any other client.
 * The policy lets it load only its own files and talk only to this server.
 */
const UI_FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/nunito.woff2': ['nunito.woff2', 'font/woff2'],
};
const UI_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function loadUi(): Map<string, { body: Buffer; type: string }> {
  const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, [file, type]] of Object.entries(UI_FILES)) {
    try { files.set(path, { body: readFileSync(join(folder, file)), type }); } catch { /* the API still works without the page */ }
  }
  return files;
}
const reserved = new Set(['principal', 'device', 'scope', 'verified', 'actor', 'attribution', 'agent', 'session', '__proto__', 'constructor', 'prototype']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/**
 * A request from this machine, addressed to localhost, and not relayed by a proxy or
 * tunnel. A proxy on the same machine (cloudflared, Caddy) connects from loopback too,
 * so its Host header or forwarding headers must rule it out.
 */
function fromThisMachine(request: http.IncomingMessage): boolean {
  if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')) return false;
  if (request.headers['x-forwarded-for'] || request.headers.forwarded || request.headers['cf-connecting-ip']) return false;
  const host = (request.headers.host ?? '').replace(/:\d+$/u, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
const LOCAL_VIEWER: Actor = { principal: 'local-viewer', device: 'local', scope: 'ro', verified: false };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function reply(response: http.ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
function failure(response: http.ServerResponse, error: unknown): void {
  const e = error instanceof HiveNoteError ? error : new HiveNoteError('internal_error', 'Internal server error', 500);
  reply(response, e.status, { error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } });
}
function body(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > LIMIT) {
        settled = true;
        chunks.length = 0;
        // Drain rather than destroy: the caller must receive the JSON 413.
        reject(new HiveNoteError('body_too_large', 'Request exceeds 1 MiB', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch { reject(new HiveNoteError('invalid_json', 'Invalid JSON request')); }
    });
    request.once('error', () => { if (!settled) { settled = true; reject(new HiveNoteError('invalid_request', 'Request interrupted')); } });
    request.once('aborted', () => { if (!settled) { settled = true; reject(new HiveNoteError('invalid_request', 'Request interrupted')); } });
  });
}
export async function startServer(store: ServerStore, options: ServerOptions = {}): Promise<http.Server> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7391;
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) throw new HiveNoteError('invalid_config', 'Invalid server host or port');
  let drop = options.dropResponseOnce ?? false;
  const ui = loadUi();
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, (request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') { reply(response, 200, { ok: true }); return; }
      const page = request.method === 'GET' || request.method === 'HEAD' ? ui.get((request.url ?? '').split('?')[0]!) : undefined;
      if (page) {
        response.writeHead(200, { 'content-type': page.type, 'cache-control': 'no-cache', 'content-security-policy': UI_POLICY, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
        response.end(request.method === 'HEAD' ? undefined : page.body);
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/call') throw new HiveNoteError('not_found', 'Not found', 404);
      // Authentication precedes parsing, authorization, and idempotency lookup.
      const authorization = request.headers.authorization;
      const viewer = !authorization && options.localViewer === true && fromThisMachine(request);
      if (!viewer && (!authorization || !/^Bearer [^\s]+$/u.test(authorization))) throw new HiveNoteError('unauthorized', 'Bearer authentication required', 401);
      const actor = viewer ? { ...LOCAL_VIEWER } : { ...store.authenticate(authorization!.slice(7)) };
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HiveNoteError('unsupported_media_type', 'Content-Type must be application/json', 415);
      const length = Number(request.headers['content-length'] ?? 0);
      if (length > LIMIT) throw new HiveNoteError('body_too_large', 'Request exceeds 1 MiB', 413);
      const input = await body(request);
      if (!record(input) || Object.keys(input).some(key => !['method', 'params', 'agent', 'session'].includes(key)) || !isMethod(input.method)) throw new HiveNoteError('invalid_request', 'Expected {method, params, agent?, session?}');
      const params = input.params === undefined ? {} : input.params;
      // Body parsing yields to other clients; a revocation during upload must still deny dispatch.
      if (!viewer) Object.assign(actor, store.authenticate(authorization!.slice(7)));
      if (!record(params) || Object.keys(params).some(key => reserved.has(key))) throw new HiveNoteError('invalid_params', 'Params must be an object without attribution fields');
      for (const label of ['agent', 'session'] as const) {
        if (input[label] !== undefined) {
          if (typeof input[label] !== 'string' || !input[label].length || input[label].length > 256) throw new HiveNoteError('invalid_request', `Invalid ${label} label`);
          actor[label] = input[label];
        }
      }
      if (actor.scope !== 'rw' && MUTATIONS.has(input.method)) throw new HiveNoteError('forbidden', 'Token is read-only', 403);
      const result = store.execute(input.method, params, actor);
      if (drop && MUTATIONS.has(input.method)) { drop = false; response.destroy(); return; }
      reply(response, 200, { result });
    })().catch(error => failure(response, error));
  });
  server.setTimeout(15000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error); };
    server.once('error', onError);
    server.listen(port, host, () => { server.off('error', onError); resolve(); });
  });
  return server;
}
