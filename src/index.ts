// Lightweight imports: SQLite and the MCP SDK are loaded only when requested.
export * from './contract.js';
export { HttpStore, validateServerUrl, type HttpStoreOptions } from './client.js';
export { startServer, type ServerOptions, type ServerStore } from './http.js';
export { configDirectory, configPath, defaultDbPath, loadConfig, saveConfig, resolveConfig, readToken, type Config } from './config.js';
import type { Actor, Store } from './contract.js';
export async function openLocalStore(dbPath: string, actor?: Actor): Promise<Store> {
  const modulePath = './sqlite.js';
  const { SqliteStore } = await import(modulePath) as { SqliteStore: new (path: string, actor?: Actor) => Store };
  return new SqliteStore(dbPath, actor);
}
export async function startMcp(store: Store, options: { agent?: string; session?: string } = {}) {
  return (await import('./mcp.js')).startMcp(store, options);
}
