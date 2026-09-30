import { SqliteStore } from '../dist/sqlite.js';
import { actor, fixture } from './helpers.mjs';

const [path, worker, countText = '100', mode = 'write', id] = process.argv.slice(2);
const store = new SqliteStore(path, actor(`worker-${worker}`, `process-${worker}`));
try {
  if (process.send) {
    process.send({ ready: true });
    await new Promise(resolve => process.once('message', resolve));
  }
  if (mode === 'race') {
    try {
      const result = await store.call('replace', { id, base_rev: 1, content: `winner-${worker}` });
      console.log(JSON.stringify({ winner: true, rev: result.note.rev }));
    } catch (error) {
      if (error.status !== 409) throw error;
      console.log(JSON.stringify({ winner: false, status: error.status }));
    }
  } else if (mode === 'shared') {
    const count = Number(countText);
    for (let i = 0; i < count; i++) {
      await store.call('edit', { id, old_str: 'ANCHOR', new_str: `ANCHOR\n${worker}:${i}` });
    }
    console.log(JSON.stringify({ worker, writes: count }));
  } else {
    const count = Number(countText);
    let result = await store.call('create', fixture({ name: `worker-${worker}`, content: `${worker}:0` }));
    for (let i = 1; i < count; i++) {
      result = await store.call('replace', { id: result.note.id, base_rev: result.note.rev, content: `${worker}:${i}` });
    }
    console.log(JSON.stringify({ worker, writes: count, id: result.note.id, rev: result.note.rev }));
  }
} finally {
  store.close();
}
