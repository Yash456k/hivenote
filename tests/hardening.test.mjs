import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { chmod, stat, writeFile } from 'node:fs/promises';
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
test('token file must be private; invalid config and offline endpoint never fall back to local', async t => {
  const {dir}=await setup(t);
  const home=join(dir,'home');
  const env={HIVENOTE_HOME:home};
  const file=join(dir,'token.txt');
  await writeFile(file,'x'.repeat(43),{mode:0o644});
  if(process.platform!=='win32') {
    await chmod(file,0o644);
    const result=await run(process.execPath,[cli,'--url','http://127.0.0.1:1','--token-file',file,'list'],{env});
    assert.notEqual(result.code,0);
    assert.match(result.stderr,/private/u);
  }
  const bad=await run(process.execPath,[cli,'--db',join(dir,'never.db'),'--url','http://127.0.0.1:1','list'],{env});
  assert.notEqual(bad.code,0);
  await cliJson(['config','set','--db',join(dir,'never.db')],{env});
  await writeFile(join(home,'config.json'),'{broken');
  const malformed=await run(process.execPath,[cli,'list'],{env});
  assert.notEqual(malformed.code,0);
  assert.match(malformed.stderr,/config/iu);
  await cliJson(['config','reset'],{env});
  const offline=new HttpStore('http://127.0.0.1:1','x'.repeat(43),{timeoutMs:100,retries:1});
  await assert.rejects(offline.call('list'),e=>e.status===503);
  await assert.rejects(stat(join(home,'data.db')));
});
