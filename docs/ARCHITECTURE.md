# How HiveNote is built

For people changing the code. What it does for users is in the [reference](REFERENCE.md).

## One store, three ways in

```
CLI (cli.ts) ─┐
MCP (mcp.ts) ─┼─ Store ─┬─ SqliteStore (sqlite.ts)  the hive on this machine
              │         └─ HttpStore (client.ts) ── HTTP (http.ts) ── SqliteStore on the queen
dashboard ────┘ (ui/, reads through HTTP)
```

`contract.ts` lists the methods, their types and errors. `SqliteStore` and `HttpStore` both implement the same `Store` interface, so the CLI and MCP don't care whether the hive is on this machine or the queen. The HTTP server authenticates a request, then calls the same `SqliteStore` a local command would. Nothing in HiveNote runs note text, schedules work or calls an AI.

| File | What it holds |
|---|---|
| `cli.ts` | The commands: reading the words, picking the hive, one table entry per command |
| `pretty.ts` | The readable view a person sees in a terminal |
| `sqlite.ts` | Every read and write against the database |
| `database.ts` | The schema, opening the file, transactions and waiting for the write lock |
| `views.ts` | Turning rows into notes, events and the brief listing |
| `validate.ts` | Limits and checks on everything that enters the store |
| `http.ts`, `client.ts` | The queen's server and the worker's client |
| `tunnel.ts` | `serve public`: finding or downloading `cloudflared`, running it, and starting it again if it stops |
| `helper.ts` | The connection helper on a worker: a background process that keeps one connection to the queen open, and the commands' side of talking to it |
| `connect.ts`, `config.ts` | Saving which queen to use, and the token file |
| `wait.ts` | Waiting for a note to change or a task to reach a status |
| `mcp.ts` | The MCP tools |
| `runtime.ts` | The Node version check and agent detection |

## Storage

One SQLite file, opened with Node's built-in `node:sqlite` (Node 22.16 is the first with full-text search). Tables: `notes` (the current version of each note), `events` (every change, with a full copy of the note for each version), `receipts` (the answer to every write, by `op_id`, so a resent write isn't applied twice), `clients` (token hashes) and `notes_fts` (the search index, updated in the same transaction as the note).

Writes take the write lock up front, check and change everything inside one transaction, and never wait on the network or other files while holding it. `PRAGMA user_version` records the schema version; see AGENTS.md for how a change to it must keep users' data.

## Rules that keep it simple

- Notes are named by their name everywhere a person or agent types. IDs exist so renames and reused names keep separate histories.
- There is no version checking or locking. The latest write wins, history keeps everything, and `restore` is the undo.
- A task's status plus who changed it last and when is the whole coordination model.
- Workers never load SQLite, and normal commands never load the MCP SDK.
- The connection helper is the only thing that runs between commands, and only on a worker. Nothing depends on it: every command works the same without it, just slower.
