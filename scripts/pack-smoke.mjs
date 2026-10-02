#!/usr/bin/env node
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFile, rm, access, mkdir, copyFile } from 'node:fs/promises';
import { sandbox, run, root, fixture } from '../tests/helpers.mjs';
import { connectMcp, mcpSmoke } from '../tests/mcp-helpers.mjs';

const dir = await sandbox(null, 'pack-smoke');
const env = { HIVENOTE_HOME: join(dir, 'isolated config'), npm_config_cache: join(dir, 'npm-cache') };
let mcp;
// Windows starts npm and installed commands through .cmd launchers, which Node can only run
// via a shell that would mangle these paths. There, run npm's script and the installed
// package's cli.js with node directly; elsewhere use the real commands.
const windows = process.platform === 'win32';
const npm = windows ? [process.execPath, [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]] : ['npm', []];
async function checked(command, args, options = {}) {
  const [file, before] = command === 'npm' ? npm : Array.isArray(command) ? command : [command, []];
  const result = await run(file, [...before, ...args], { env, timeout: 180_000, ...options });
  assert.equal(result.code, 0, `${file} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result;
}
function npmJson(stdout) {
  // npm 12 returns a name-keyed object; older npm returns an array and may
  // print lifecycle messages before JSON. Only consider column-zero roots.
  for (const match of stdout.matchAll(/^(?:\{|\[)/gm)) {
    try {
      const value = JSON.parse(stdout.slice(match.index));
      return Array.isArray(value) ? value : Object.values(value);
    } catch { /* Try the next root following lifecycle output. */ }
  }
  throw new Error('npm pack did not return JSON inventory');
}
try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const dry = npmJson((await checked('npm', ['pack', '--dry-run', '--json'])).stdout)[0];
  const shipped = new Set(dry.files.map(file => file.path));
  for (const path of ['package.json', 'dist/cli.js', 'dist/client.js', 'dist/sqlite.js', 'dist/http.js', 'dist/mcp.js', 'dist/wait.js', 'dist/runtime.js', 'skills/hivenote/SKILL.md', 'ui/index.html', 'ui/app.js', 'README.md']) assert.ok(shipped.has(path), `Missing package file: ${path}`);
  assert.ok(!dry.files.some(file => /^(?:tests|\.tmp|src|node_modules)\//u.test(file.path)), 'Package must not ship fixtures, source or dependencies');
  assert.ok(!dry.files.some(file => /(?:\.db(?:-|$)|\.sqlite(?:-|$)|\.env|credentials|\.log$)/iu.test(file.path)), 'Package must not ship databases, tokens, env or logs');
  const packed = npmJson((await checked('npm', ['pack', '--json', '--pack-destination', dir])).stdout)[0];
  const tarball = join(dir, packed.filename);
  await access(tarball);
  const prefix = join(dir, 'installed prefix 日本語');
  await checked('npm', ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', tarball]);
  const bin = windows
    ? [process.execPath, [join(prefix, 'node_modules', 'hivenote', 'dist', 'cli.js')]]
    : [join(prefix, 'node_modules', '.bin', 'hivenote'), []];
  const help = await checked(bin, ['--help'], { cwd: prefix });
  assert.match(help.stdout, /hivenote|usage/iu);
  const version = await checked(bin, ['--version'], { cwd: prefix });
  assert.ok(version.stdout.includes(pkg.version));
  const db = join(prefix, 'installed notes with spaces 日本語.sqlite');
  const created = JSON.parse((await checked(bin, ['--db', db, 'create', '--params', JSON.stringify(fixture({ name: 'Installed Résumé 日本語', content: 'tarball real content' }))], { cwd: prefix })).stdout);
  const read = JSON.parse((await checked(bin, ['--db', db, 'read', created.note.name], { cwd: prefix })).stdout);
  assert.equal(read.notes[0].content, 'tarball real content');
  await access(db);
  // The installed CLI resolves its own shipped modules and dependencies.
  mcp = await connectMcp(bin[0], [...bin[1], '--db', join(prefix, 'installed MCP 日本語.sqlite'), 'mcp'], env);
  await mcpSmoke(mcp.client, 'Installed MCP 日本語');
  await mcp.client.close();
  mcp = null;
  const artifactDirectory = join(root, '.tmp', 'artifacts');
  await mkdir(artifactDirectory, {recursive:true});
  await copyFile(tarball, join(artifactDirectory, packed.filename));
  console.log(JSON.stringify({ package: pkg.name, version: pkg.version, dry_run_files: dry.files.length, tarball_bytes: packed.size, artifact: `.tmp/artifacts/${packed.filename}`, installed_bin: 'help/version/create/read verified', paths: 'spaces and non-ASCII verified', mcp: 'actual SDK stdio handshake and all fifteen tools verified' }, null, 2));
} finally {
  await mcp?.client.close();
  await rm(dir, { recursive: true, force: true });
}
