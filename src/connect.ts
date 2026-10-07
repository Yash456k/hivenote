import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HiveNoteError } from './contract.js';
import { HttpStore, validateServerUrl } from './client.js';
import { configDirectory, loadConfig, readToken, saveConfig } from './config.js';

/**
 * `hivenote connect`: point this machine at a hive on another machine.
 * Asks for the URL and the token (typed hidden), checks they work, then saves
 * both. The token never appears in shell history or the process list, and the
 * user never has to manage a token file: HiveNote keeps it privately.
 *
 * A hive keeps its tokens when its address changes (a tunnel that started again, a queen
 * moved to another machine), so a machine that is already connected is offered the token
 * it has, and only types one if the queen at the new address turns that down.
 */

/** How connect talks to the person; tests answer for them. */
export interface Prompt { tty: boolean; ask(question: string, hidden: boolean): Promise<string> }

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

/** The token this machine already holds, and the address it was saved for. */
function savedToken(): { url: string; token: string } | undefined {
  try {
    const config = loadConfig();
    return config.url && config.tokenFile ? { url: config.url, token: readToken(config) } : undefined;
  } catch { return undefined; }
}

export async function connect(givenUrl: string | undefined, io: Prompt = { tty: process.stdin.isTTY === true, ask }): Promise<{ connected: string; entries: number }> {
  if (givenUrl === undefined && !io.tty) throw new HiveNoteError('invalid_args', 'Pass the URL when piping the token: echo $TOKEN | hivenote connect URL');
  const url = (givenUrl ?? await io.ask('Hive URL: ', false)).replace(/\/+$/u, '');
  const parsed = validateServerUrl(url);
  // The token travels with every request. Plain http is readable by anyone on the same network,
  // except on this machine or over Tailscale, which encrypts the traffic itself.
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(host) || host.endsWith('.ts.net');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(host) && !tailscale) {
    process.stderr.write('hivenote: warning: this address uses plain http, so the token can be read by anyone on the same network. Use https (for example a Cloudflare tunnel) or Tailscale.\n');
  }
  // Check before saving, so a typo fails here rather than in the next agent command.
  const check = async (candidate: string): Promise<number> => {
    try {
      return (await new HttpStore(url, candidate, { retries: 0 }).call('list', { limit: 1 }) as { total: number }).total;
    } catch (error) {
      // The address `hivenote serve public` prints is new to the whole internet.
      if (error instanceof HiveNoteError && error.code === 'transport_error' && host.endsWith('.trycloudflare.com')) {
        throw new HiveNoteError('transport_error', `Can't reach the hive at ${url}. A tunnel's address can take up to a minute to work everywhere, and it stops working when hivenote serve public stops on the queen. Check that it is still running there, then try again.`, 503);
      }
      throw error;
    }
  };

  let token: string | undefined;
  let total = 0;
  // Only a person at a terminal is offered the saved token, and only after saying yes:
  // it is about to be sent to the address they just gave. A piped token is used as given.
  const saved = io.tty ? savedToken() : undefined;
  if (saved && /^(y|yes)?$/iu.test(await io.ask(`Use the token saved for ${saved.url}? [Y/n] `, false))) {
    try {
      total = await check(saved.token);
      token = saved.token;
    } catch (error) {
      if (!(error instanceof HiveNoteError && error.status === 401)) throw error;
      process.stderr.write(`hivenote: the queen at ${url} did not accept the saved token.\n`);
    }
  }
  if (token === undefined) {
    token = await io.ask('Token: ', true);
    if (!token) throw new HiveNoteError('invalid_args', 'A token is required. Create one on the queen: hivenote token add LABEL');
    total = await check(token);
  }

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
