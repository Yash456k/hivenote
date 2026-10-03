import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HiveNoteError } from './contract.js';
import { HttpStore, validateServerUrl } from './client.js';
import { configDirectory, saveConfig } from './config.js';

/**
 * `hivenote connect`: point this machine at a hive on another machine.
 * Asks for the URL and the token (typed hidden), checks they work, then saves
 * both. The token never appears in shell history or the process list, and the
 * user never has to manage a token file: HiveNote keeps it privately.
 */

/** Prompts go to stderr so stdout stays JSON. */
function ask(question: string, hidden: boolean): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    // Piped: `echo $TOKEN | hivenote connect URL`.
    return new Promise((resolve, reject) => {
      let text = '';
      input.setEncoding('utf8');
      input.on('data', chunk => { text += chunk; });
      input.once('end', () => resolve(text.split(/\r?\n/u)[0]!.trim()));
      input.once('error', reject);
    });
  }
  process.stderr.write(question);
  return new Promise(resolve => {
    let text = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false); input.pause(); input.off('data', onData);
          process.stderr.write('\n');
          resolve(text.trim());
          return;
        }
        if (char === '\u0003') { input.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (char === '\u007f' || char === '\b') {
          if (text.length) { text = text.slice(0, -1); if (!hidden) process.stderr.write('\b \b'); }
          continue;
        }
        text += char;
        process.stderr.write(hidden ? '•' : char);
      }
    };
    input.on('data', onData);
  });
}

export async function connect(givenUrl: string | undefined): Promise<{ connected: string; entries: number }> {
  if (givenUrl === undefined && !process.stdin.isTTY) throw new HiveNoteError('invalid_args', 'Pass the URL when piping the token: echo $TOKEN | hivenote connect URL');
  const url = (givenUrl ?? await ask('Hive URL: ', false)).replace(/\/+$/u, '');
  const parsed = validateServerUrl(url);
  // The token travels with every request. Plain http is readable by anyone on the same network,
  // except on this machine or over Tailscale, which encrypts the traffic itself.
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(host) || host.endsWith('.ts.net');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(host) && !tailscale) {
    process.stderr.write('hivenote: warning: this address uses plain http, so the token can be read by anyone on the same network. Use https (for example a Cloudflare tunnel) or Tailscale.\n');
  }
  const token = await ask('Token: ', true);
  if (!token) throw new HiveNoteError('invalid_args', 'A token is required. Create one on the queen: hivenote token add LABEL');

  // Check before saving, so a typo fails here rather than in the next agent command.
  const probe = new HttpStore(url, token, { retries: 0 });
  const { total } = await probe.call('list', { limit: 1 }) as { total: number };

  const directory = configDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tokenFile = join(directory, 'token');
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tokenFile, 0o600);
  saveConfig({ url, tokenFile });
  return { connected: url, entries: total };
}

/** `hivenote disconnect`: go back to the local database and forget the stored token. */
export function disconnect(): { disconnected: true } {
  saveConfig({});
  rmSync(join(configDirectory(), 'token'), { force: true });
  return { disconnected: true };
}
