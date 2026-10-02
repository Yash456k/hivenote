import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './helpers.mjs';

export const methodNames = ['list', 'read', 'search', 'create', 'edit', 'replace', 'append', 'delete', 'history', 'revision', 'restore', 'changes', 'claim', 'release', 'update_task'];

export async function connectMcp(command, args, env = {}) {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: 'pipe' });
  let stderr = '';
  const client = new Client({ name: 'hivenote-regression-sdk', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  return { client, transport, stderr: () => stderr };
}

export function decodeTool(result) {
  const text = result.content?.find(item => item.type === 'text');
  assert.ok(text, 'MCP result contains text');
  const payload = JSON.parse(text.text);
  if (result.structuredContent) assert.deepEqual(result.structuredContent, payload);
  return payload;
}

export async function mcpSmoke(client, name = 'MCP note 日本語') {
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name).sort(), [...methodNames].sort());
  for (const tool of list.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return decodeTool(result);
  };
  const { id: _created, ...note } = fixture({ name, content: 'MCP unique body' });
  const created = await invoke('create', note);
  assert.equal(created.note.rev, 1);
  assert.ok(created.op_id);
  assert.equal((await invoke('read', { names: [name] })).notes[0].content, 'MCP unique body');
  assert.equal((await invoke('search', { query: 'unique' })).total, 1);
  const edited = await invoke('edit', { note: name, old_str: 'unique', new_str: 'updated', base_rev: 1 });
  assert.equal(edited.note.rev, 2);
  const appended = await invoke('append', { note: name, body: 'inert append' });
  assert.equal(appended.note.rev, 2);
  assert.equal((await invoke('revision', { note: name, rev: 1 })).note.content, 'MCP unique body');
  const replaced = await invoke('replace', { note: name, base_rev: 2, content: 'replacement' });
  assert.equal(replaced.note.rev, 3);
  const deleted = await invoke('delete', { note: name, base_rev: 3 });
  assert.equal(deleted.note.rev, 4);
  const restored = await invoke('restore', { note: name, rev: 1, base_rev: 4 });
  assert.equal(restored.note.rev, 5);
  assert.equal(restored.note.content, 'MCP unique body');
  assert.equal((await invoke('history', { note: name })).total, 6);
  const { id: _task, ...taskNote } = fixture({ name: `${name} task`, kind: 'task', status: 'todo' });
  await invoke('create', taskNote);
  const claimed = await invoke('claim', { note: taskNote.name, ttl_seconds: 60 });
  assert.ok(claimed.note.claimed_by);
  const released = await invoke('release', { note: taskNote.name });
  assert.equal(released.note.claimed_by, null);
  const updated = await invoke('update_task', { note: taskNote.name, status: 'done' });
  assert.equal(updated.note.status, 'done');
  assert.equal((await invoke('list')).total, 2);
  assert.equal((await invoke('changes', { since: 0, limit: 100 })).events.length, 10);
  const conflict = await client.callTool({ name: 'replace', arguments: { note: name, base_rev: 1, content: 'stale' } });
  assert.equal(conflict.isError, true);
  assert.equal(decodeTool(conflict).error.status, 409);
  const invalid = await client.callTool({ name: 'create', arguments: { name: 'missing fields' } });
  assert.equal(invalid.isError, true);
  return created;
}
