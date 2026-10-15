import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { actor, cli, closeServer, params, root, run, sandbox } from './helpers.mjs';

/** A command that keeps running (standby, serve standby), and its first line of output. */
function start(args, env) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('close', code => resolve({ code, stderr })));
  const line = new Promise((resolve, reject) => {
    const look = setInterval(() => { if (stdout.includes('\n')) { clearInterval(look); resolve(JSON.parse(stdout.split('\n')[0])); } }, 20);
    void exited.then(({ code }) => { clearInterval(look); reject(new Error(`exited ${code}: ${stderr}`)); });
  });
  return { child, line, exited, stderr: () => stderr };
}

async function until(check, what) {
  for (const end = Date.now() + 20_000; Date.now() < end;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test('a standby copy serves as a temporary queen, and merge gives the main queen its writes once', { timeout: 120_000 }, async t => {
  const dir = await sandbox(t, 'standby');
  const main = new SqliteStore(join(dir, 'main.db'), actor());
  t.after(() => main.close());
  const laptopToken = main.tokenCreate('laptop').token;
  const msiToken = main.tokenCreate('msi', 'rw', true).token;
  let server = await startServer(main, { port: 0 });
  const port = server.address().port;
  const mainUrl = `http://127.0.0.1:${port}`;
  t.after(() => closeServer(server));
  await main.call('create', params({ name: 'build-api', description: 'Build the API', content: '', kind: 'task' }));
  await main.call('create', params({ name: 'deploy', description: 'Ship it', content: '', kind: 'task' }));
  await main.call('create', params({ name: 'contract', description: 'What the API promises', content: 'POST /bookings' }));

  // msi keeps a standby copy, and follows changes made after it started.
  const msi = { HIVENOTE_HOME: join(dir, 'msi'), HIVENOTE_URL: mainUrl, HIVENOTE_TOKEN: msiToken };
  const standby = start(['standby'], msi);
  t.after(() => standby.child.kill());
  assert.equal((await standby.line).seq, 3);
  const laptop = (url, ...words) => run(process.execPath, [cli, '--agent', 'builder', ...words], { env: { HIVENOTE_URL: url, HIVENOTE_TOKEN: laptopToken, HIVENOTE_HOME: join(dir, 'laptop') } });
  assert.equal((await laptop(mainUrl, 'append', 'build-api', 'Schema is in')).code, 0);
  const copyPath = join(dir, 'msi', 'standby.db');
  const copyHas = () => { const db = new DatabaseSync(copyPath, { readOnly: true }); try { return db.prepare('SELECT max(seq) AS n FROM events').get().n; } finally { db.close(); } };
  await until(() => copyHas() === 4, 'the copy to follow');

  // An ordinary token may not read the token hashes.
  const refused = await fetch(`${mainUrl}/v1/standby`, { method: 'POST', headers: { authorization: `Bearer ${laptopToken}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 403);

  // The main queen goes down; msi serves its copy, and the laptop writes to it with the token it already has.
  await closeServer(server);
  const temporary = start(['serve', 'standby', ':0'], msi);
  t.after(() => temporary.child.kill());
  const served = await temporary.line;
  assert.equal(served.standby_for, mainUrl);
  const tempUrl = served.serving;
  // The standby notices, and stops following.
  assert.match((await standby.exited).stderr, /served as a temporary queen/u);
  for (const words of [['mark', 'build-api', 'done', 'Endpoints done'], ['edit', 'contract', 'POST /bookings', 'POST /bookings, GET /bookings'], ['take'], ['add', 'outage', 'What happened', 'The queen was down']]) {
    const answer = await laptop(tempUrl, ...words);
    assert.equal(answer.code, 0, answer.stderr);
  }
  const status = JSON.parse((await run(process.execPath, [cli, 'status'], { env: msi })).stdout);
  assert.deepEqual([status.hive, status.queen, status.changes], ['temporary queen', mainUrl, 5]);

  // The main queen is back, and someone used her meanwhile: deploy was taken there, and outage was added there.
  server = await startServer(main, { port });
  await main.call('update_task', params({ note: 'deploy', status: 'doing', claim: true }));
  await main.call('create', params({ name: 'outage', description: 'Down at noon', content: 'Written on the main queen' }));
  const before = main.changeCount().latest;

  // Its own address is refused: merging into the temporary queen would leave the main queen without the writes.
  const self = await run(process.execPath, [cli, 'merge', tempUrl], { env: msi });
  assert.equal(JSON.parse(self.stderr.trim().split('\n').at(-1)).error.code, 'temporary_queen');

  const merge = async () => {
    const answer = await run(process.execPath, [cli, 'merge', mainUrl], { env: msi });
    assert.equal(answer.code, 0, answer.stderr);
    return JSON.parse(answer.stdout);
  };
  const first = await merge();
  assert.deepEqual([first.applied, first.already], [3, 0]);
  assert.deepEqual(first.not_merged.map(item => [item.change, item.by]), [['take deploy', 'builder@laptop'], ['add outage', 'builder@laptop']]);
  assert.match(first.not_merged[0].why, /changed it on the queen meanwhile/u);
  assert.match(first.not_merged[1].why, /'outage' already exists/u);
  assert.match(first.next, new RegExp(`hivenote connect ${mainUrl}`, 'u'));

  const read = async () => (await main.call('read', { names: ['build-api', 'contract', 'deploy', 'outage'] })).notes;
  const [buildApi, contract, deploy, outage] = await read();
  assert.equal(buildApi.status, 'done');
  assert.equal(contract.content, 'POST /bookings, GET /bookings');
  assert.equal(deploy.last_attribution.principal, 'test-user');
  // Passed on through msi's token, but made by the laptop: kept as the laptop's, unverified, never as msi's own.
  assert.deepEqual([buildApi.last_attribution.agent, buildApi.last_attribution.verified], ['builder@laptop', false]);
  assert.equal(outage.content, 'Written on the main queen');
  const progress = (await main.call('history', { note: 'build-api' })).events.filter(event => event.kind === 'append').map(event => event.body);
  assert.deepEqual(progress, ['Schema is in', 'Endpoints done']);
  assert.equal(main.changeCount().latest, before + 3);

  // Again: nothing is applied twice, and the main queen is left as she was.
  const second = await merge();
  assert.deepEqual([second.applied, second.already, second.not_merged.length], [0, 3, 2]);
  assert.equal(main.changeCount().latest, before + 3);
  assert.deepEqual(await read(), [buildApi, contract, deploy, outage]);

  // Merged, so msi is a worker of the main queen again.
  temporary.child.kill();
  assert.equal(JSON.parse((await run(process.execPath, [cli, 'status'], { env: msi })).stdout).hive, 'queen');
});

test('a hive made by 0.5.0 opens, keeps its notes and tokens, and is copied first', async t => {
  const dir = await sandbox(t, 'v05');
  const path = join(dir, 'data.db');
  copyFileSync(join(root, 'tests/fixtures/hive-0.5.0.db'), path);
  // A file left at the copy's name (an earlier copy cut short) is neither trusted nor replaced.
  writeFileSync(`${path}.before-v2`, 'cut short');
  const store = new SqliteStore(path, actor());
  t.after(() => store.close());
  assert.deepEqual((await store.call('list', {})).notes.map(note => note.name).sort(), ['build-api', 'deploy/notes']);
  assert.deepEqual(store.tokenList().map(row => [row.device, row.scope, row.standby]), [['laptop', 'rw', 0], ['dashboard', 'ro', 0]]);
  assert.equal((await store.call('history', { note: 'plan' })).total, 2);
  assert.equal(store.tokenCreate('msi', 'rw', true).standby, true);
  assert.equal(readFileSync(`${path}.before-v2`, 'utf8'), 'cut short');
  const copyPath = readdirSync(dir).find(file => file.startsWith('data.db.before-v2-'));
  const copy = new DatabaseSync(join(dir, copyPath), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(copy.prepare('SELECT count(*) AS n FROM events').get().n, 6);
  copy.close();
});

test('standby against a 0.5 queen fails with queen_too_old and keeps no copy', async t => {
  const dir = await sandbox(t, 'standby-old');
  const old = createServer((request, response) => {
    const answer = request.url === '/v1/call' ? [200, { result: { events: [], cursor: 0, has_more: false } }] : [404, { error: { code: 'not_found', message: 'Not found' } }];
    request.resume();
    response.writeHead(answer[0], { 'content-type': 'application/json', 'x-hivenote-version': '0.5.0' });
    response.end(JSON.stringify(answer[1]));
  });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(old));
  const home = join(dir, 'msi');
  const answer = await run(process.execPath, [cli, 'standby'], { env: { HIVENOTE_HOME: home, HIVENOTE_URL: `http://127.0.0.1:${old.address().port}`, HIVENOTE_TOKEN: 'x'.repeat(43) } });
  assert.notEqual(answer.code, 0);
  assert.equal(JSON.parse(answer.stderr.trim().split('\n').at(-1)).error.code, 'queen_too_old');
  assert.equal(existsSync(join(home, 'standby.json')), false);
});
