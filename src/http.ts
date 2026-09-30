import * as http from 'node:http';
import { isMethod, MUTATIONS, HiveNoteError, type Actor, type Method, type Params } from './contract.js';

export interface ServerStore { authenticate(token: string): Actor; execute(method: Method, params: Params, actor: Actor): unknown; }
export interface ServerOptions { host?: string; port?: number; dropResponseOnce?: boolean; }
const LIMIT = 1024 * 1024;
const reserved = new Set(['principal', 'device', 'scope', 'verified', 'actor', 'attribution', 'agent', 'session', '__proto__', 'constructor', 'prototype']);
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
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, (request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') { reply(response, 200, { ok: true }); return; }
      if (request.method !== 'POST' || request.url !== '/v1/call') throw new HiveNoteError('not_found', 'Not found', 404);
      // Authentication precedes parsing, authorization, and idempotency lookup.
      const authorization = request.headers.authorization;
      if (!authorization || !/^Bearer [^\s]+$/u.test(authorization)) throw new HiveNoteError('unauthorized', 'Bearer authentication required', 401);
      const actor = { ...store.authenticate(authorization.slice(7)) };
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HiveNoteError('unsupported_media_type', 'Content-Type must be application/json', 415);
      const length = Number(request.headers['content-length'] ?? 0);
      if (length > LIMIT) throw new HiveNoteError('body_too_large', 'Request exceeds 1 MiB', 413);
      const input = await body(request);
      if (!record(input) || Object.keys(input).some(key => !['method', 'params', 'agent', 'session'].includes(key)) || !isMethod(input.method)) throw new HiveNoteError('invalid_request', 'Expected {method, params, agent?, session?}');
      const params = input.params === undefined ? {} : input.params;
      // Body parsing yields to other clients; a revocation during upload must still deny dispatch.
      Object.assign(actor, store.authenticate(authorization.slice(7)));
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
