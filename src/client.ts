import { clientParams, isMethod, StickyError, type Method, type Params, type Store } from './contract.js';

export interface HttpStoreOptions { timeoutMs?: number; retries?: number; agent?: string; session?: string; }
export function validateServerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new StickyError('invalid_config', 'Server URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new StickyError('invalid_config', 'Server URL must be an HTTP(S) origin without credentials, path, query, or fragment');
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
    if (!token || token.trim() !== token || /[\s\x00-\x1f\x7f]/u.test(token)) throw new StickyError('invalid_config', 'A nonempty bearer token is required');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.retries = options.retries ?? 2;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 5) throw new StickyError('invalid_config', 'Invalid HTTP timeout or retry count');
    this.labels = {};
    this.setAttribution(options);
  }
  /** Labels are self-reported data; never authentication or authorization. */
  setAttribution(labels: { agent?: string; session?: string }): void {
    for (const key of ['agent', 'session'] as const) {
      const value = labels[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || !value.length || value.length > 256) throw new StickyError('invalid_config', `Invalid ${key} label`);
        this.labels[key] = value;
      }
    }
  }
  async call(method: Method, params: Params = {}): Promise<unknown> {
    if (!isMethod(method)) throw new StickyError('invalid_method', 'Unknown method');
    const body = JSON.stringify({ method, params: clientParams(method, params), ...this.labels });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new StickyError('body_too_large', 'Request exceeds 1 MiB', 413);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        if (attempt < this.retries) { await pause(attempt); continue; }
        throw new StickyError('transport_error', 'Unable to reach Sticky Notes server', 503);
      }
      if (response.status === 503 && attempt < this.retries) { await response.body?.cancel(); await pause(attempt); continue; }
      let payload: unknown;
      try { payload = await response.json(); } catch (error) {
        // A truncated connection after headers is still a transport failure.
        if (!(error instanceof SyntaxError)) {
          if (attempt < this.retries) { await pause(attempt); continue; }
          throw new StickyError('transport_error', 'Server connection interrupted', 503);
        }
        throw new StickyError('invalid_response', 'Server returned an invalid JSON response', 502);
      }
      if (!payload || typeof payload !== 'object') throw new StickyError('invalid_response', 'Server returned an invalid response', 502);
      const object = payload as Record<string, unknown>;
      if (!response.ok) {
        const error = object.error as Record<string, unknown> | undefined;
        throw new StickyError(typeof error?.code === 'string' ? error.code : 'http_error', typeof error?.message === 'string' ? error.message : `Server returned HTTP ${response.status}`, response.status, error?.details);
      }
      if (!Object.hasOwn(object, 'result')) throw new StickyError('invalid_response', 'Server response is missing result', 502);
      return object.result;
    }
  }
  close(): void {}
}
function pause(attempt: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000))); }
export { clientParams, StickyError } from './contract.js';
export type { Store, Method, Params } from './contract.js';
