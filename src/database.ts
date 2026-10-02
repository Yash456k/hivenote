import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { HiveNoteError } from './contract.js';
import { invalid } from './validate.js';

/** Opening the SQLite file, running transactions, and the schema. */

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('note','task')),
    rev INTEGER NOT NULL CHECK(rev>0),
    status TEXT,
    due_at TEXT,
    claimed_by TEXT,
    claim_expires_at TEXT,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    activity_at TEXT NOT NULL,
    deleted_at TEXT,
    last_attribution TEXT NOT NULL,
    last_activity_attribution TEXT NOT NULL
  );
  -- Names are unique among live notes; a deleted note's name can be reused.
  CREATE UNIQUE INDEX live_name ON notes(name) WHERE deleted_at IS NULL;
  CREATE INDEX live_discovery ON notes(deleted_at,kind,status,name,id);
  CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED,name,description,content,tokenize='unicode61');

  -- Every change, in order. Revision-changing events keep a full snapshot of the note.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL REFERENCES notes(id),
    kind TEXT NOT NULL,
    revision INTEGER,
    snapshot TEXT,
    body TEXT,
    op_id TEXT NOT NULL UNIQUE,
    attribution TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX event_history ON events(note_id,seq);
  CREATE UNIQUE INDEX event_revisions ON events(note_id,revision) WHERE revision IS NOT NULL;

  -- The stored answer to each operation, so a retried request gets the same result.
  CREATE TABLE receipts (op_id TEXT PRIMARY KEY, principal TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);

  -- Tokens for other machines. Only SHA-256 hashes are stored.
  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    principal TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK(scope IN ('ro','rw')),
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  PRAGMA user_version=${SCHEMA_VERSION};
`;

/** Turn SQLite errors into safe HiveNote errors; never leak SQL text. */
export function storageError(error: unknown): never {
  if (error instanceof HiveNoteError) throw error;
  const message = error instanceof Error ? error.message : '';
  if (/UNIQUE constraint failed/iu.test(message)) throw new HiveNoteError('conflict', 'ID or live name already exists', 409);
  if (/locked|busy/iu.test(message)) throw new HiveNoteError('busy', 'Database busy; retry with the same op_id', 503);
  throw new HiveNoteError('storage_error', 'Database operation failed', 500);
}

/**
 * How long to wait for another process's write. A command can wait 5 seconds; a server
 * waits 0.2 seconds and answers "busy" instead, because while it waits it can't answer
 * anyone else. Clients retry busy answers on their own.
 */
export const lockWait = { ms: 5000 };

/** Retry briefly while another process holds the lock. */
export function retryWhileBusy<T>(fn: () => T): T {
  const deadline = Date.now() + lockWait.ms;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      const busy = error instanceof Error && /locked|busy/iu.test(error.message);
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Run fn in a transaction. Writes take the write lock up front (BEGIN IMMEDIATE). */
export function transaction<T>(db: DatabaseSync, fn: () => T, write = true): T {
  let open = false;
  try {
    retryWhileBusy(() => db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'));
    open = true;
    const result = fn();
    db.exec('COMMIT');
    open = false;
    return result;
  } catch (error) {
    if (open) db.exec('ROLLBACK');
    return storageError(error);
  }
}

/** Open (and if needed create) the database with private permissions and the current schema. */
export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Create the file with a private mode before SQLite opens it; other processes may race us.
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!statSync(path).isFile()) invalid('Database path must be a regular local file');
  if (process.platform !== 'win32') chmodSync(path, 0o600);

  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=${lockWait.ms}; PRAGMA foreign_keys=ON;`);
    // A file from a newer HiveNote is left exactly as it is: check before changing anything.
    if (Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) > SCHEMA_VERSION) {
      throw new HiveNoteError('schema_version', 'This hive was made by a newer HiveNote; update HiveNote on this machine to open it', 500);
    }
    retryWhileBusy(() => db.exec('PRAGMA journal_mode=WAL;'));
    // Serialized by the write lock, so two processes opening a new file migrate it once.
    transaction(db, () => {
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > SCHEMA_VERSION) throw new HiveNoteError('schema_version', 'This hive was made by a newer HiveNote; update HiveNote on this machine to open it', 500);
      if (version === 0) db.exec(SCHEMA);
    });
  } catch (error) {
    db.close();
    storageError(error);
  }
  return db;
}
