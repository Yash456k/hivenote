import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HiveNoteError } from './contract.js';
import { validateServerUrl } from './client.js';

export interface Config { db?: string; url?: string; tokenFile?: string; agent?: string; session?: string; }
export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HIVENOTE_HOME) return resolve(env.HIVENOTE_HOME);
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'hivenote');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'hivenote');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hivenote');
}
export function configPath(): string { return join(configDirectory(), 'config.json'); }
export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HIVENOTE_HOME) return resolve(env.HIVENOTE_HOME);
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hivenote');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'hivenote');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'hivenote');
}
export function defaultDbPath(): string { return join(dataDirectory(), 'data.db'); }
function validate(input: unknown): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HiveNoteError('invalid_config', 'Config must be a JSON object');
  const value = input as Record<string, unknown>;
  const allowed = ['db', 'url', 'tokenFile', 'agent', 'session'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HiveNoteError('invalid_config', 'Config contains unsupported fields');
  for (const key of allowed) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) throw new HiveNoteError('invalid_config', `Config field ${key} must be a nonempty string`);
  if (value.db && value.url) throw new HiveNoteError('invalid_config', '--db and --url are mutually exclusive, including persistent configuration');
  if (typeof value.url === 'string') validateServerUrl(value.url);
  for (const label of ['agent', 'session']) if (typeof value[label] === 'string' && value[label].length > 256) throw new HiveNoteError('invalid_config', `${label} label must be at most 256 characters`);
  if (value.tokenFile && !value.url) throw new HiveNoteError('invalid_config', 'tokenFile requires a remote URL');
  return { ...value } as Config;
}
export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return {};
  try { return validate(JSON.parse(readFileSync(path, 'utf8')) as unknown); }
  catch (error) { if (error instanceof HiveNoteError) throw error; throw new HiveNoteError('invalid_config', 'Cannot read config JSON'); }
}
export function saveConfig(config: Config, path = configPath()): Config {
  const result = validate(config);
  for (const key of ['db', 'tokenFile'] as const) if (result[key] && !isAbsolute(result[key])) result[key] = resolve(result[key]);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return result;
}
export function resolveConfig(overrides: Config = {}, saved: Config = loadConfig()): Config {
  return validate({ ...saved, ...overrides });
}
export function readToken(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  // An explicitly configured file takes precedence over environment credentials.
  let token: string;
  if (config.tokenFile) {
    try {
      const info = statSync(config.tokenFile);
      if (!info.isFile() || info.size > 4096) throw new HiveNoteError('invalid_config', 'Token file must be a small regular file');
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new HiveNoteError('invalid_config', 'Token file must be private (chmod 600)');
      token = readFileSync(config.tokenFile, 'utf8').trim();
    } catch (error) { if (error instanceof HiveNoteError) throw error; throw new HiveNoteError('invalid_config', 'Cannot read token file'); }
  } else token = env.HIVENOTE_TOKEN ?? '';
  if (!token || token.trim() !== token || /[\s\x00-\x1f\x7f]/u.test(token)) throw new HiveNoteError('invalid_config', 'Remote mode requires --token-file or HIVENOTE_TOKEN');
  return token;
}
