import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from '../dist/sqlite.js';
import { startServer } from '../dist/http.js';
import { sandbox, actor, cli, closeServer, serverUrl } from './helpers.mjs';
import { connectMcp, mcpSmoke, decodeTool } from './mcp-helpers.mjs';

 test('real MCP SDK exchanges over local stdio: all fifteen tools and protocol-clean stdout', { timeout: 60_000 }, async t => {
  const dir = await sandbox(t, 'mcp-local');
  const connection = await connectMcp(process.execPath, [cli, '--db', join(dir, 'MCP notes 日本語.sqlite'), 'mcp'], { HIVENOTE_HOME: join(dir, 'config') });
  t.after(() => connection.client.close());
  const created = await mcpSmoke(connection.client);
  assert.equal(created.note.last_attribution.verified, false);
  assert.equal(created.note.last_attribution.agent, 'hivenote-regression-sdk');
});

test('real MCP SDK over remote stdio uses HTTP authority; read-only and revoked tokens', { timeout: 60_000 }, async t => {
  const dir = await sandbox(t, 'mcp-remote');
  const store = new SqliteStore(join(dir, 'server.sqlite'), actor());
  const token = store.tokenCreate('mcp-remote', 'rw');
  const ro = store.tokenCreate('mcp-reader', 'ro');
  const server = await startServer(store, { port: 0, host: '127.0.0.1' });
  t.after(async () => { await closeServer(server); store.close(); });
  const url = serverUrl(server);
  const connection = await connectMcp(process.execPath, [cli, '--url', url, 'mcp'], { HIVENOTE_HOME: join(dir, 'config'), HIVENOTE_TOKEN: token.token });
  t.after(() => connection.client.close());
  const created = await mcpSmoke(connection.client, 'Remote MCP note 日本語');
  assert.equal(created.note.last_attribution.verified, true);
  assert.equal(created.note.last_attribution.principal, token.principal);
  assert.equal(created.note.last_attribution.device, token.device);
  const reader = await connectMcp(process.execPath, [cli, '--url', url, 'mcp'], { HIVENOTE_HOME: join(dir, 'config'), HIVENOTE_TOKEN: ro.token });
  t.after(() => reader.client.close());
  const readable = await reader.client.callTool({ name: 'read', arguments: { ids: [created.note.id] } });
  assert.ok(!readable.isError);
  const forbidden = await reader.client.callTool({ name: 'append', arguments: { id: created.note.id, body: 'forbidden' } });
  assert.equal(forbidden.isError, true);
  assert.equal(decodeTool(forbidden).error.status, 403);
  store.tokenRevoke(token.id);
  const revoked = await connection.client.callTool({ name: 'list', arguments: {} });
  assert.equal(revoked.isError, true);
  assert.equal(decodeTool(revoked).error.status, 401);
});
