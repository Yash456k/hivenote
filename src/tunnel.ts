import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { dataDirectory } from './config.js';
import { HiveNoteError } from './contract.js';

/**
 * `hivenote serve public`: put the queen on the internet through a Cloudflare quick tunnel.
 *
 * cloudflared, Cloudflare's own program, connects out from this machine, so no port is
 * opened on it or on the router, and Cloudflare serves https for the address. A quick
 * tunnel needs no account. Its address is random and lasts until cloudflared stops; a
 * new start gets a new address, and workers have to connect again.
 */

export interface Tunnel { stop(): void }
export interface TunnelOptions {
  /** Told the first address, and every new one after cloudflared had to be started again. */
  address: (url: string, previous: string | undefined) => void;
  /** Progress for the person watching: downloading, starting, restarting. */
  say: (message: string) => void;
}

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const INSTALL_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
const INSTALL = `Install cloudflared yourself (${INSTALL_URL}) and run this again.`;

/** The file Cloudflare publishes for this kind of machine. */
function asset(): string | undefined {
  const arch = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' } as Record<string, string>)[process.arch];
  if (!arch) return undefined;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  if (process.platform === 'darwin' && (arch === 'amd64' || arch === 'arm64')) return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === 'win32' && (arch === 'amd64' || arch === '386')) return `cloudflared-windows-${arch}.exe`;
  return undefined;
}

/**
 * HIVENOTE_CLOUDFLARED, then a cloudflared already installed, then the copy HiveNote keeps
 * beside the hive, downloading that copy from Cloudflare's releases the first time.
 */
async function cloudflared(say: TunnelOptions['say']): Promise<string> {
  const chosen = process.env.HIVENOTE_CLOUDFLARED;
  if (chosen) {
    if (!existsSync(chosen)) throw new HiveNoteError('tunnel_unavailable', `HIVENOTE_CLOUDFLARED points at ${chosen}, which does not exist`);
    return chosen;
  }
  if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status === 0) return 'cloudflared';
  const directory = dataDirectory();
  const kept = join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(kept)) return kept;

  const name = asset();
  if (!name) throw new HiveNoteError('tunnel_unavailable', `Cloudflare publishes no cloudflared for this machine (${process.platform} ${process.arch}). ${INSTALL}`);
  say(`cloudflared is not installed; downloading it once from ${RELEASES}${name} (about 40 MB)`);
  const temporary = `${kept}.${process.pid}.tmp`;
  try {
    const response = await fetch(RELEASES + name, { signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
    if (name.endsWith('.tgz')) {
      // macOS ships it as an archive holding the one program; tar is part of the system.
      const unpacked = spawnSync('tar', ['-xzf', temporary, '-C', directory, 'cloudflared'], { stdio: 'ignore' });
      if (unpacked.status !== 0) throw new Error('could not unpack the download');
      rmSync(temporary, { force: true });
    } else renameSync(temporary, kept);
    if (process.platform !== 'win32') chmodSync(kept, 0o755);
  } catch (error) {
    rmSync(temporary, { force: true });
    const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : '';
    throw new HiveNoteError('tunnel_unavailable', `Could not download cloudflared${cause ? ` (${cause.slice(0, 200)})` : ''}. Run this again, or install cloudflared yourself: ${INSTALL_URL}`, 503);
  }
  say(`saved to ${kept}`);
  return kept;
}

export async function openTunnel(port: number, options: TunnelOptions): Promise<Tunnel> {
  const program = await cloudflared(options.say);
  let child: ChildProcess | undefined;
  let stopped = false;
  let current: string | undefined;
  let failures = 0;

  /** One run of cloudflared: settles with its address once Cloudflare has the connection. */
  const start = (): Promise<string> => new Promise((resolve, reject) => {
    let url: string | undefined;
    let registered = false;
    let settled = false;
    let lastError = '';
    let pending = '';
    const read = (line: string): void => {
      // api.trycloudflare.com is where cloudflared asks for the tunnel; it shows up in its errors.
      url ??= /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/u.exec(line)?.[0];
      if (line.includes('Registered tunnel connection')) registered = true;
      // Its reason for giving up is an ERR line, or a last line with no level at all.
      if (/ ERR /u.test(line) || (line.trim() && !/ (INF|WRN|DBG) /u.test(line))) lastError = line.replace(/^\S+ ERR\s*/u, '').trim().slice(0, 300);
    };
    const running = spawn(program, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    child = running;
    const timer = setTimeout(() => { if (!settled) running.kill(); }, 60000);
    running.stderr!.setEncoding('utf8');
    running.stderr!.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop()!;
      for (const line of lines) read(line);
      if (url && registered && !settled) { settled = true; clearTimeout(timer); resolve(url); }
    });
    running.once('error', () => { clearTimeout(timer); if (!settled) { settled = true; reject(new HiveNoteError('tunnel_unavailable', `Could not run ${program}. ${INSTALL}`)); } });
    running.once('exit', () => {
      clearTimeout(timer);
      read(pending);
      if (!settled) { settled = true; reject(new HiveNoteError('tunnel_failed', `cloudflared could not open a tunnel${lastError ? `: ${lastError}` : ''}`, 503)); return; }
      // It was up and then stopped: a crash, or someone ended it. Start another, with a new address.
      if (!stopped) void again();
    });
  });

  const again = async (): Promise<void> => {
    while (!stopped) {
      await sleep(Math.min(1000 * 2 ** failures, 30000));
      if (stopped) return;
      options.say('the tunnel stopped; starting it again');
      try {
        const url = await start();
        failures = 0;
        const previous = current;
        current = url;
        options.address(url, previous);
        return;
      } catch { failures++; }
    }
  };

  const stop = (): void => { stopped = true; child?.kill(); };
  process.once('exit', stop);
  options.say('opening a Cloudflare tunnel');
  // Cloudflare's service for quick tunnels is sometimes slow to answer; give it three tries.
  for (let attempt = 1; current === undefined; attempt++) {
    try { current = await start(); } catch (error) {
      if (attempt === 3 || !(error instanceof HiveNoteError && error.code === 'tunnel_failed')) { stop(); throw error; }
      options.say(`${error.message}; trying again`);
      await sleep(2000);
    }
  }
  options.address(current, undefined);
  return { stop };
}
