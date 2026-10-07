import { SqliteStore } from '../dist/sqlite.js';
import { actor, fixture } from './helpers.mjs';

const [path, worker, countText = '100', mode = 'write', id] = process.argv.slice(2);
// Ten processes writing flat out can keep one of them waiting longer than the 5 seconds a
// command waits for the write lock, most easily on a slow machine. "Busy" means nothing was
// written, so the writer tries again, as a client does. What the tests check is that no
// write is lost or applied twice, not that nobody ever has to wait.
async function patiently(work) {
  for (;;) {
    try { return await work(); } catch (error) { if (error.code !== 'busy') throw error; busy++; }
  }
}
let busy = 0;
const store = await patiently(() => new SqliteStore(path, actor(`worker-${worker}`, `process-${worker}`)));
const write = (method, params) => patiently(() => store.call(method, params));
try {
  if (process.send) {
    process.send({ ready: true });
    await new Promise(resolve => process.once('message', resolve));
  }
  if (mode === 'shared') {
    const count = Number(countText);
    for (let i = 0; i < count; i++) {
      await write('edit', { id, old_str: 'ANCHOR', new_str: `ANCHOR\n${worker}:${i}` });
    }
    console.log(JSON.stringify({ worker, writes: count }));
  } else {
    const count = Number(countText);
    let result = await write('create', fixture({ name: `worker-${worker}`, content: `${worker}:0` }));
    for (let i = 1; i < count; i++) {
      result = await write('replace', { id: result.note.id, content: `${worker}:${i}` });
    }
    console.log(JSON.stringify({ worker, writes: count, id: result.note.id, rev: result.note.rev, busy }));
  }
} finally {
  store.close();
}
