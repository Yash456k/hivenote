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
test('bounded data/search validation, literal whitespace edit, and failed op_id can be retried', async t => {
  const {store} = await setup(t);
  const {note} = await store.call('create',fixture({content:'a b'}));
  const edited = await store.call('edit',{id:note.id,old_str:' ',new_str:''});
  assert.equal(edited.note.content,'ab');
  for(const query of ['"unbalanced','OR','foo AND (']) {
    await assert.rejects(store.call('search',{query}),e => e.status === 400 && !/SQLITE|syntax error/iu.test(e.message));
  }
  for(const changes of [{name:'x'.repeat(257)},{description:'x'.repeat(4097)},{content:'x'.repeat(524289)},{metadata:{x:'x'.repeat(32769)}},{metadata:{bad:undefined}},{kind:'task',due_at:'2030-02-30T00:00:00Z'}]) {
    await assert.rejects(store.call('create',fixture(changes)),e => e.status === 400);
  }
  const op = params({id:note.id,base_rev:1,content:'retry'});
  await assert.rejects(store.call('replace',op),e => e.status===409);
  const fixed = await store.call('replace',{...op,base_rev:2});
  assert.equal(fixed.note.rev,3);
  assert.equal((await store.call('history',{id:note.id})).total,3);
});
test('read exposes bounded append bodies despite unchanged revision; empty CLI content and stable create replay', async t => {
  const {store,dir,path} = await setup(t);
  const {note} = await store.call('create',fixture());
  for(let i=0;i<25;i++) await store.call('append',{id:note.id,body:`update-${i}`});
  const read = await store.call('read',{ids:[note.id]});
  assert.equal(read.notes[0].rev,1);
  assert.equal(read.updates.length,20);
  assert.equal(read.updates[0].body,'update-5');
  assert.equal(read.updates.at(-1).body,'update-24');
  assert.equal(read.updates_has_more,true);
  const args=['--db',path,'create','repeat','--description','','--content','','--op-id','repeatable-create'];
  const env={STICKY_HOME:join(dir,'config')};
  const first=await cliJson(args,{env});
  assert.equal(first.note.content,'');
  assert.deepEqual(await cliJson(args,{env}),first);
  assert.equal((await store.call('history',{id:first.note.id})).total,1);
  const prepared=clientParams('create',{op_id:'known',name:'n',description:'',content:''});
  assert.deepEqual(clientParams('create',{op_id:'known',name:'n',description:'',content:''}),prepared);
  assert.ok(prepared.id);
});
test('backup collision/permissions and read-only administration fail safely', async t => {
  const {store,dir,path}=await setup(t);
  const {note}=await store.call('create',fixture());
  const file=join(dir,'backup.sqlite');
  store.backup(file);
  assert.throws(()=>store.backup(file),e=>e.status===409);
  assert.throws(()=>store.backup(path),e=>e.status===409);
  if(process.platform!=='win32') {
    for(const candidate of [path,file,`${path}-wal`,`${path}-shm`]) assert.equal((await stat(candidate)).mode&0o777,0o600);
  }
  const ro=new SqliteStore(path,actor('reader','read-only','ro'));
  try {
    assert.throws(()=>ro.backup(join(dir,'forbidden.db')),e=>e.status===403);
    assert.throws(()=>ro.tokenCreate('forbidden','rw'),e=>e.status===403);
    assert.throws(()=>ro.tokenList(),e=>e.status===403);
    assert.equal((await ro.call('read',{ids:[note.id]})).notes.length,1);
  } finally {ro.close();}
});
test('revoked upload cannot dispatch, even if valid token was authenticated before body finished', async t => {
  const {store}=await setup(t);
  const token=store.tokenCreate('upload','rw');
  const server=await startServer(store,{port:0});
  t.after(()=>closeServer(server));
  const url=serverUrl(server);
  let authenticated;
  const ready=new Promise(resolve=>{authenticated=resolve;});
  const original=store.authenticate.bind(store);
  store.authenticate=raw=>{const result=original(raw);authenticated();return result;};
  const result=new Promise((resolve,reject)=>{
    const req=http.request(`${url}/v1/call`,{method:'POST',headers:{authorization:`Bearer ${token.token}`,'content-type':'application/json'}},res=>{
      let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });
    req.on('error',reject);
    req.write('{"method":"create","params":');
    ready.then(()=>{store.tokenRevoke(token.id);req.end(JSON.stringify(params(fixture()))+'}');});
  });
  assert.equal((await result).status,401);
  assert.equal((await store.call('list')).total,0);
});
test('admin methods denied over RPC; CLI local does not load MCP and remote does not load SQLite', async t => {
  const {store,dir,path}=await setup(t);
  const token=store.tokenCreate('remote','rw');
  const server=await startServer(store,{port:0});
  t.after(()=>closeServer(server));
  const url=serverUrl(server);
  for(const method of ['tokenCreate','tokenList','tokenRevoke','backup','config','serve','mcp']) {
    const res=await fetch(`${url}/v1/call`,{method:'POST',headers:{authorization:`Bearer ${token.token}`,'content-type':'application/json'},body:JSON.stringify({method,params:{}})});
    assert.equal(res.status,400);
  }
  const denyMcp=join(dir,'deny-mcp.mjs');
  await writeFile(denyMcp,"import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,next){if(s.includes('@modelcontextprotocol/'))throw Error('MCP eager import');return next(s,c);}});");
  const env={STICKY_HOME:join(dir,'isolated')};
  const local=await run(process.execPath,['--import',denyMcp,cli,'--db',path,'list'],{env});
  assert.equal(local.code,0,local.stderr);
  const remote=await run(process.execPath,['--no-experimental-sqlite',cli,'--url',url,'list'],{env:{...env,STICKY_TOKEN:token.token}});
  assert.equal(remote.code,0,remote.stderr);
});
test('token file must be private; invalid config and offline endpoint never fall back to local', async t => {
  const {dir}=await setup(t);
  const home=join(dir,'home');
  const env={STICKY_HOME:home};
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
