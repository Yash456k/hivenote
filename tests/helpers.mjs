import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const cli = join(root, 'dist/cli.js');

// Never read or write the developer's real HiveNote config or database: every
// test process (and the CLI processes it spawns) gets its own private home.
// Tests that need a specific home still pass HIVENOTE_HOME explicitly.
// Tests often run inside an agent; its markers would label every write.
for (const marker of ['CLAUDECODE', 'CODEX_CI', 'CODEX_PERMISSION_PROFILE', 'CODEX_SANDBOX', 'HERMES_SESSION_ID', 'HERMES_AGENT']) delete process.env[marker];
if (!process.env.HIVENOTE_HOME) {
  process.env.HIVENOTE_HOME = await mkdtemp(join(tmpdir(), 'hivenote-test-home-'));
}
// Direct test actors model local filesystem callers, not authenticated tokens.
export const actor = (principal = 'test-user', device = 'test-device', scope = 'rw') => ({ principal, device, scope, verified: false });
export const params = (extra = {}) => ({ op_id: randomUUID(), ...extra });
export const fixture = (extra = {}) => ({ id: randomUUID(), name: `note-${randomUUID()}`, description: 'Regression fixture', content: 'alpha\nbeta\ngamma', ...extra });

export async function sandbox(t, label = 'test') {
  const base = process.env.TMPDIR || join(root, '.tmp');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `hivenote-${label}-`));
  t?.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function run(command, args, { cwd = root, env = {}, timeout = 120_000, input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Timed out: ${command} ${args.join(' ')}\n${stderr}`)); }, timeout);
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin?.end(input);
  });
}

export async function cliJson(args, options) {
  const result = await run(process.execPath, [cli, ...args], options);
  if (result.code !== 0) throw new Error(`CLI failed (${result.code}): ${result.stderr}\n${result.stdout}`);
  try { return JSON.parse(result.stdout); }
  catch (cause) { throw new Error(`CLI did not emit JSON: ${result.stdout}\n${result.stderr}`, { cause }); }
}

export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server');
  return `http://127.0.0.1:${address.port}`;
}
