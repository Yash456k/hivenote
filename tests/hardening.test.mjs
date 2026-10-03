import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { SqliteStore } from '../dist/sqlite.js';
import { HttpStore } from '../dist/client.js';
import { startServer } from '../dist/http.js';
import { clientParams } from '../dist/contract.js';
import { actor, fixture, params, sandbox, serverUrl, closeServer, cli, cliJson, run } from './helpers.mjs';

async function setup(t) {
  const dir = await sandbox(t,'hardening');
  const path = join(dir,'data.db');
  const store = new SqliteStore(path,actor());
  t.after(() => store.close());
  return {dir,path,store};
}
test('a connected machine never falls back to a local hive: bad token file, broken settings, unreachable queen', async t => {
  const {dir}=await setup(t);
  const home=join(dir,'home');
  const env={HIVENOTE_HOME:home};
  const file=join(dir,'token.txt');
  await mkdir(home,{recursive:true});
  const settings=json=>writeFile(join(home,'config.json'),json);
  await writeFile(file,'x'.repeat(43),{mode:0o600});
  await settings(JSON.stringify({url:'http://127.0.0.1:1',tokenFile:file}));
  if(process.platform!=='win32') {
    await chmod(file,0o644);
    const exposed=await run(process.execPath,[cli,'list'],{env});
    assert.notEqual(exposed.code,0);
    assert.match(exposed.stderr,/private/u);
    await chmod(file,0o600);
  }
  const offline=await run(process.execPath,[cli,'list'],{env});
  assert.notEqual(offline.code,0);
  await settings('{broken');
  const malformed=await run(process.execPath,[cli,'list'],{env});
  assert.notEqual(malformed.code,0);
  assert.match(malformed.stderr,/config/iu);
  await assert.rejects(stat(join(home,'data.db')));
});

test('HIVENOTE_URL for another server never sends it the token saved for the queen', async t => {
  const {dir}=await setup(t);
  const home=join(dir,'home');
  await mkdir(home,{recursive:true});
  await writeFile(join(dir,'token.txt'),'saved-queen-token',{mode:0o600});
  await writeFile(join(home,'config.json'),JSON.stringify({url:'http://127.0.0.1:1',tokenFile:join(dir,'token.txt')}));
  const seen=[];
  const other=http.createServer((request,response) => { seen.push(request.headers.authorization); response.writeHead(401).end('{}'); });
  await new Promise(resolve => other.listen(0,'127.0.0.1',resolve));
  t.after(() => closeServer(other));
  await run(process.execPath,[cli,'list'],{env:{HIVENOTE_HOME:home,HIVENOTE_URL:serverUrl(other),HIVENOTE_TOKEN:'token-for-the-other'}});
  assert.deepEqual([...new Set(seen)],['Bearer token-for-the-other']);
});
