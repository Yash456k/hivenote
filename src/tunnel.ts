import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

export interface Tunnel {
  /** Stops cloudflared, also while the tunnel is still opening. */
  stop(): void;
  /** The first address, once Cloudflare has the connection. Rejects when no tunnel could be opened. */
  opened: Promise<string>;
}
export interface TunnelOptions {
  /** Told the first address, and every new one after cloudflared had to be started again. */
  address: (url: string, previous: string | undefined) => void;
  /** Progress for the person watching: downloading, starting, restarting. */
  say: (message: string) => void;
}

/**
 * The cloudflared release HiveNote downloads, and the SHA-256 of the program for each kind
 * of machine, copied from that release's notes on github.com/cloudflare/cloudflared.
 * A download is only ever run if it is exactly this file. To move to a newer release,
 * change the version and all eight checksums together (AGENTS.md says how).
 */
export const CLOUDFLARED = {
  version: '2026.10.0',
  releases: 'https://github.com/cloudflare/cloudflared/releases/download/',
  sha256: {
    'linux-amd64': 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db',
    'linux-arm64': 'e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08',
    'linux-arm': '1dbe8e4ec17e74bb7f49cf91db6a4903bd0f9fe41984556c7503e40b765fd099',
    'linux-386': 'f6fbd789e6ce9c824d4d560cbbfad2753d55ce398ece16b4c9fbf17271dceab3',
    'darwin-amd64': '0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da',
    'darwin-arm64': '72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830',
    'windows-amd64': '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c',
    'windows-386': '0630a8779e9823a1a3b091698b8e71874e0f7b205559219f52fdd301466b5546',
  } as Record<string, string>,
};
const INSTALL_URL = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
const INSTALL = `Install cloudflared yourself (${INSTALL_URL}) and run this again.`;

/** This kind of machine as Cloudflare names it, such as linux-amd64. */
function machine(): string {
  const system = ({ linux: 'linux', darwin: 'darwin', win32: 'windows' } as Record<string, string>)[process.platform];
  const arch = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' } as Record<string, string>)[process.arch];
  return `${system}-${arch}`;
}

const checksum = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Download HiveNote's own copy of cloudflared into a folder, and keep it only if it is the
 * exact file expected. Anything else is deleted without being run.
 */
export async function download(directory: string, say: TunnelOptions['say'], releases = CLOUDFLARED.releases): Promise<string> {
  const kind = machine();
  const expected = CLOUDFLARED.sha256[kind];
  if (!expected) throw new HiveNoteError('tunnel_unavailable', `Cloudflare publishes no cloudflared for this machine (${process.platform} ${process.arch}). ${INSTALL}`);
  const kept = join(directory, `cloudflared-${CLOUDFLARED.version}${process.platform === 'win32' ? '.exe' : ''}`);
  // The copy from an earlier run is checked again each time: it is about to be run.
  if (existsSync(kept) && checksum(kept) === expected) return kept;

  // macOS gets an archive holding the one program; the others get the program itself.
  const archive = process.platform === 'darwin';
  const url = `${releases}${CLOUDFLARED.version}/cloudflared-${kind}${archive ? '.tgz' : process.platform === 'win32' ? '.exe' : ''}`;
  say(`cloudflared is not installed; downloading version ${CLOUDFLARED.version} once from ${url} (about 40 MB)`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(directory, 'cloudflared-download-'));
  try {
    let program = join(work, 'cloudflared');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(archive ? `${program}.tgz` : program, Buffer.from(await response.arrayBuffer()));
      // tar is part of macOS.
      if (archive && spawnSync('tar', ['-xzf', `${program}.tgz`, '-C', work, 'cloudflared'], { stdio: 'ignore' }).status !== 0) throw new Error('could not unpack the download');
    } catch (error) {
      const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : '';
      throw new HiveNoteError('tunnel_unavailable', `Could not download cloudflared${cause ? ` (${cause.slice(0, 200)})` : ''}. Run this again, or install cloudflared yourself: ${INSTALL_URL}`, 503);
    }
    if (checksum(program) !== expected) {
      throw new HiveNoteError('tunnel_unavailable', `The file downloaded from ${url} is not the cloudflared ${CLOUDFLARED.version} that HiveNote expects (its checksum differs), so it was deleted without being run. ${INSTALL}`, 502);
    }
    if (process.platform !== 'win32') chmodSync(program, 0o755);
    rmSync(kept, { force: true });
    renameSync(program, kept);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  say(`checked and saved to ${kept}`);
  return kept;
}

/**
 * HIVENOTE_CLOUDFLARED, then a cloudflared already installed, then the copy HiveNote keeps
 * beside the hive. The first two are yours and are run as they are; HiveNote's own copy is
 * a pinned release, checked against its checksum.
 */
async function cloudflared(say: TunnelOptions['say']): Promise<string> {
  const chosen = process.env.HIVENOTE_CLOUDFLARED;
  if (chosen) {
    if (!existsSync(chosen)) throw new HiveNoteError('tunnel_unavailable', `HIVENOTE_CLOUDFLARED points at ${chosen}, which does not exist`);
    return chosen;
  }
  if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status === 0) return 'cloudflared';
  return download(dataDirectory(), say);
}

export function openTunnel(port: number, options: TunnelOptions): Tunnel {
  let program = '';
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
  // Ctrl+C while the tunnel is still opening must end it there, not start another try.
  const halted = (): HiveNoteError => new HiveNoteError('cancelled', 'Stopped before the tunnel opened');
  const open = async (): Promise<string> => {
    program = await cloudflared(options.say);
    options.say('opening a Cloudflare tunnel');
    // Cloudflare's service for quick tunnels is sometimes slow to answer; give it three tries.
    for (let attempt = 1; current === undefined; attempt++) {
      if (stopped) throw halted();
      try { current = await start(); } catch (error) {
        if (stopped) throw halted();
        if (attempt === 3 || !(error instanceof HiveNoteError && error.code === 'tunnel_failed')) { stop(); throw error; }
        options.say(`${error.message}; trying again`);
        await sleep(2000);
      }
    }
    if (stopped) throw halted();
    options.address(current, undefined);
    return current;
  };
  return { stop, opened: open() };
}
