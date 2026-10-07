import { clientParams, isMethod, HiveNoteError, VERSION, type Method, type Params, type Store } from './contract.js';

export interface HttpStoreOptions { timeoutMs?: number; retries?: number; agent?: string; session?: string; }
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
  constructor(url: string, private readonly token: string, options: HttpStoreOptions = {}) {
    this.endpoint = new URL('/v1/call', validateServerUrl(url)).href;
    if (!token || token.trim() !== token || /[\s\x00-\x1f\x7f]/u.test(token)) throw new HiveNoteError('invalid_config', 'A nonempty bearer token is required');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retries = options.retries ?? 2;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 5) throw new HiveNoteError('invalid_config', 'Invalid HTTP timeout or retry count');
    this.labels = {};
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
    // "Busy" means another writer holds the hive for a moment; keep trying for a few seconds.
    const busyUntil = Date.now() + 5000;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        if (attempt < this.retries) { await pause(attempt); continue; }
        throw new HiveNoteError('transport_error', 'Unable to reach HiveNote server', 503);
      }
      this.checkVersion(response.headers.get('x-hivenote-version'));
      if (response.status === 503 && (attempt < this.retries || Date.now() < busyUntil)) { await response.body?.cancel(); await pause(attempt); continue; }
      let payload: unknown;
      try { payload = await response.json(); } catch (error) {
        // A truncated connection after headers is still a transport failure.
        if (!(error instanceof SyntaxError)) {
          if (attempt < this.retries) { await pause(attempt); continue; }
          throw new HiveNoteError('transport_error', 'Server connection interrupted', 503);
        }
        // A tunnel or proxy in front of the queen answers with its own error page while she is down.
        if (response.status >= 500) {
          if (attempt < this.retries) { await pause(attempt); continue; }
          throw new HiveNoteError('transport_error', 'Unable to reach HiveNote server', 503);
        }
        throw new HiveNoteError('invalid_response', 'Server returned an invalid JSON response', 502);
      }
      if (!payload || typeof payload !== 'object') throw new HiveNoteError('invalid_response', 'Server returned an invalid response', 502);
      const object = payload as Record<string, unknown>;
      if (!response.ok) {
        const error = object.error as Record<string, unknown> | undefined;
        throw new HiveNoteError(typeof error?.code === 'string' ? error.code : 'http_error', typeof error?.message === 'string' ? error.message : `Server returned HTTP ${response.status}`, response.status, error?.details);
      }
      if (!Object.hasOwn(object, 'result')) throw new HiveNoteError('invalid_response', 'Server response is missing result', 502);
      return object.result;
    }
  }
  private versionChecked = false;
  /** Warn once when this machine and the hive differ in major or minor version; patches stay quiet. */
  private checkVersion(server: string | null): void {
    if (this.versionChecked || !server) return;
    this.versionChecked = true;
    const release = (version: string): string => version.split('.').slice(0, 2).join('.');
    if (release(server) === release(VERSION)) return;
    const hive = new URL(this.endpoint).origin;
    process.stderr.write(`hivenote: this machine runs ${VERSION} but the hive at ${hive} runs ${server}. Update the older one with: npm install -g hivenote@latest\n`);
  }
  close(): void {}
}
function pause(attempt: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000))); }
export { clientParams, HiveNoteError } from './contract.js';
export type { Store, Method, Params } from './contract.js';
