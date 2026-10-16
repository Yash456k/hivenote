import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDirectory } from './config.js';
import { clientParams, isMethod, HiveNoteError, VERSION, type Method, type Params, type Store } from './contract.js';

export interface HttpStoreOptions {
  timeoutMs?: number; retries?: number; agent?: string; session?: string;
  /** How requests are sent; the connection helper passes one that keeps its connection open. */
  fetch?: typeof fetch;
  /** Leave the version warning to whoever reads serverVersion. */
  quiet?: boolean;
}

/**
 * Warn when this machine and the hive differ in major or minor version; patches stay quiet.
 * An agent starts a new process for every command, so the warning is given once a day, not on each one.
 */
export function warnOnOtherVersion(server: string, hive: string): void {
  const release = (version: string): string => version.split('.').slice(0, 2).join('.');
  if (release(server) === release(VERSION)) return;
  const said = join(configDirectory(), 'version-notice'), what = `${VERSION} ${server} ${hive}`;
  try {
    if (readFileSync(said, 'utf8') === what && Date.now() - statSync(said).mtimeMs < 86_400_000) return;
  } catch { /* not said yet */ }
  process.stderr.write(`hivenote: this machine runs ${VERSION} but the hive at ${hive} runs ${server}. Update the older one with: npm install -g hivenote@latest\n`);
  try { mkdirSync(dirname(said), { recursive: true }); writeFileSync(said, what); } catch { /* said again next time */ }
}
export function validateServerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HiveNoteError('invalid_config', 'Server URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HiveNoteError('invalid_config', 'Server URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return url;
}
export class HttpStore implements Store {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly labels: { agent?: string; session?: string };
  private readonly send: typeof fetch;
  private readonly quiet: boolean;
  /** The version the hive last said it runs. */
  serverVersion: string | null = null;
  private versionChecked = false;
  constructor(url: string, private readonly token: string, options: HttpStoreOptions = {}) {
    this.endpoint = new URL('/v1/call', validateServerUrl(url)).href;
    if (!token || token.trim() !== token || /[\s\x00-\x1f\x7f]/u.test(token)) throw new HiveNoteError('invalid_config', 'A nonempty bearer token is required');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retries = options.retries ?? 2;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 5) throw new HiveNoteError('invalid_config', 'Invalid HTTP timeout or retry count');
    this.labels = {};
    this.send = options.fetch ?? fetch;
    this.quiet = options.quiet ?? false;
    this.setAttribution(options);
  }
  /** Labels are self-reported data; never authentication or authorization. */
  setAttribution(labels: { agent?: string; session?: string }): void {
    for (const key of ['agent', 'session'] as const) {
      const value = labels[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || !value.length || value.length > 256) throw new HiveNoteError('invalid_config', `Invalid ${key} label`);
        this.labels[key] = value;
      }
    }
  }
  async call(method: Method, params: Params = {}): Promise<unknown> {
    if (!isMethod(method)) throw new HiveNoteError('invalid_method', 'Unknown method');
    const body = JSON.stringify({ method, params: clientParams(method, params), ...this.labels });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new HiveNoteError('body_too_large', 'Request exceeds 1 MiB', 413);
    // A held question is answered late on purpose, and the wait behind it has a time limit of its own:
    // allow its hold and a little more, and do not ask again when the answer is lost.
    const held = method === 'changes' && typeof params.hold === 'number' ? params.hold : undefined;
    const timeoutMs = held === undefined ? this.timeoutMs : Math.min(this.timeoutMs, held + 2000);
    const retries = held === undefined ? this.retries : 0;
    // "Busy" means another writer holds the hive for a moment; keep trying for a few seconds.
    const busyUntil = Date.now() + 5000;
    // Whether any try may have reached her: a write that did may have been made even though no answer came back.
    let maybeSent = false;
    const unreachable = (message: string): HiveNoteError => new HiveNoteError('transport_error', message, 503, maybeSent ? undefined : { sent: false });
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.send(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (!neverConnected(error)) maybeSent = true;
        if (attempt < retries) { await pause(attempt); continue; }
        throw unreachable('Unable to reach HiveNote server');
      }
      maybeSent = true;
      this.serverVersion = response.headers.get('x-hivenote-version') ?? this.serverVersion;
      if (!this.quiet && !this.versionChecked && this.serverVersion) {
        this.versionChecked = true;
        warnOnOtherVersion(this.serverVersion, new URL(this.endpoint).origin);
      }
      if (response.status === 503 && (attempt < retries || Date.now() < busyUntil)) { await response.body?.cancel(); await pause(attempt); continue; }
      let payload: unknown;
      try { payload = await response.json(); } catch (error) {
        // A truncated connection after headers is still a transport failure.
        if (!(error instanceof SyntaxError)) {
          if (attempt < retries) { await pause(attempt); continue; }
          throw new HiveNoteError('transport_error', 'Server connection interrupted', 503);
        }
        // A tunnel or proxy in front of the queen answers with its own error page while she is down.
        if (response.status >= 500) {
          if (attempt < retries) { await pause(attempt); continue; }
          throw new HiveNoteError('transport_error', 'Unable to reach HiveNote server', 503);
        }
        throw new HiveNoteError('invalid_response', 'Server returned an invalid JSON response', 502);
      }
      if (!payload || typeof payload !== 'object') throw new HiveNoteError('invalid_response', 'Server returned an invalid response', 502);
      const object = payload as Record<string, unknown>;
      if (!response.ok) {
        const error = object.error as Record<string, unknown> | undefined;
        if (tooOld(method, params, error)) throw queenTooOld(this.serverVersion);
        throw new HiveNoteError(typeof error?.code === 'string' ? error.code : 'http_error', typeof error?.message === 'string' ? error.message : `Server returned HTTP ${response.status}`, response.status, error?.details);
      }
      if (!Object.hasOwn(object, 'result')) throw new HiveNoteError('invalid_response', 'Server response is missing result', 502);
      return object.result;
    }
  }
  close(): void {}
}
export function queenTooOld(version: string | null | undefined): HiveNoteError {
  return new HiveNoteError('queen_too_old', `The queen runs HiveNote ${version ?? 'older than 1.0'}, and this needs 1.0 or newer there. Nothing was changed. Update the queen with npm install -g hivenote@latest, then restart hivenote serve`, 501);
}
/** Parameters added in 1.0. A queen before it refuses them as unknown, and a new method as no method at all. */
const NEWER_PARAMS = ['after', 'not_after', 'ready', 'folder'];
function tooOld(method: Method, params: Params, error: Record<string, unknown> | undefined): boolean {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (method === 'take' && error?.code === 'invalid_request' && message.startsWith('Expected {method')) return true;
  return error?.code === 'validation_error' && message.startsWith('Unknown parameter') && NEWER_PARAMS.some(key => params[key] !== undefined);
}
/**
 * Whether a failed request certainly never reached the queen: the connection itself was refused or could not be
 * opened. A timeout or a dropped connection may have come after she read the request, so those count as sent.
 */
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);
function neverConnected(error: unknown): boolean {
  const codes = (value: unknown, depth = 0): string[] => {
    if (!value || typeof value !== 'object' || depth > 4) return [];
    const own = typeof (value as { code?: unknown }).code === 'string' ? [(value as { code: string }).code] : [];
    const inner = (value as { errors?: unknown }).errors;
    return [...own, ...codes((value as { cause?: unknown }).cause, depth + 1), ...(Array.isArray(inner) ? inner.flatMap(item => codes(item, depth + 1)) : [])];
  };
  const found = codes(error);
  return found.length > 0 && found.every(code => NOT_CONNECTED.has(code));
}
function pause(attempt: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000))); }
export { clientParams, HiveNoteError } from './contract.js';
export type { Store, Method, Params } from './contract.js';
