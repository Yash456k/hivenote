# Architecture and v0.1 contract

## One authority, thin adapters

`contract.ts` defines the method allowlist, types, errors and common client
operation-ID/UUID generation. `SqliteStore.call` and `HttpStore.call` implement
the same asynchronous `Store` interface. CLI and MCP use it. The HTTP server
calls the same store's synchronous `execute` dispatcher after authentication.
No executor, scheduler, AI, dependency graph or executable metadata exists.

`SqliteStore` uses only built-in `node:sqlite`, parameterized SQL and versioned
`PRAGMA user_version` migrations. Version 1 has `notes`, `events`, `receipts`,
`clients` and a transactional FTS5 index. WAL, foreign keys and 5000 ms busy
 timeout are enabled. Initial migration is serialized by `BEGIN IMMEDIATE`;
processes racing a fresh DB re-check its version under the lock. Write functions
have no await/network/filesystem calls inside their transaction. Read transactions
keep each page's count and rows consistent. Locks are bounded; busy errors map
to retryable 503. The synchronous adapter is intended for modest workloads.

Notes store UUID, globally scoped live name, required description/content, JSON
metadata, kind, task status/due/claim fields, revision, creation/update/activity
timestamps, tombstone and snapshot/activity attribution. Live-name uniqueness
is a partial index. Deleted names can be reused, but IDs are never reused.
FTS5 indexes only live snapshots, not append bodies, and changes with the note.

## Methods

Common pagination: `offset=0`, `limit=50` (1–100). All selectors/IDs are explicit;
UUID case/spelling is preserved. Read selectors are deduplicated preserving order.
No method guesses whether a string is an ID or a name.

| Method | Parameters (optional marked ?) | Result |
|---|---|---|
| list | offset?, limit?, kind?, status? | notes without content, total, offset, has_more |
| read | exactly one: ids[] or names[] (1–100) | notes, missing, updates, updates_has_more |
| search | query, offset?, limit? | notes without content + snippet, total, offset, has_more |
| create | id, name, description, content, kind?, metadata?, status?, due_at?, op_id | receipt |
| edit | id, old_str, new_str, base_rev?, op_id | receipt |
| replace | id, base_rev, content?, name?, description?, metadata?, op_id | receipt |
| append | id, body, op_id | receipt |
| delete | id, base_rev, op_id | receipt |
| history | id, offset?, limit? | events, total, offset, has_more |
| revision | id, rev | note |
| restore | id, rev, base_rev, op_id | receipt |
| changes | since=0?, limit? | events, cursor, has_more |
| claim | id, ttl_seconds=900?, force=false?, base_rev?, op_id | receipt |
| release | id, force=false?, base_rev?, op_id | receipt |
| update_task | id, base_rev, status?, due_at?, metadata?, op_id | receipt |

The SDK/CLI/MCP common client supplies mutation `op_id` and create `id` when
omitted. Raw RPC/`execute` callers must supply them. The generated ID is a UUIDv8
derived from SHA-256(namespace + op_id), so explicit CLI op-id create replays
preserve the same request. Normally op_id itself is a random UUID; caller IDs
can instead be explicit UUIDs. An op-id is a bounded nonblank string (128 bytes).

Receipt: `{note,event_seq,op_id}`. Every revision-changing event saves the full
post-operation snapshot; append saves a literal `body` and null revision/snapshot.
Events have globally monotonic `seq`, note_id, kind, revision, snapshot, body,
op_id, attribution and DB-owner timestamp. Claim/release force event kinds are
`claim_force`/`release_force`. No events are removed by deletion/restoration.

`read.updates` exposes the newest 20 append events per found note, oldest-first
within that bounded window and globally sorted by seq. `updates_has_more` means
at least one selected note has older contributions; history gives them all.
Append changes activity timestamp/attribution but not content, updated_at or rev.
History/revision resolve tombstoned IDs. Restore creates current rev + 1,
revives the historical content/metadata/task status, preserves original creation
time and clears historical deletion/claim leases. A name collision rolls it back.

Changes are ordered ascending seq and resume with the returned cursor; append
and deletion are present even when snapshots are unchanged or no longer live.
Offset pages across separate calls can shift under concurrent writes; changes
are the durable incremental feed. No long-lived read snapshot spans requests.

## Safety, identity and idempotency

Unknown methods/fields and malformed data are rejected. Name/description/content
limits are 256/4096/524288 UTF-8 bytes; metadata max 32768 bytes and depth 20.
Descriptions/content may be empty; names must be nonblank. Due dates are UTC ISO
strings with calendar validation, or null. TTL is 1–86400 seconds. Status is one
of todo/doing/done/cancelled. FTS5 syntax errors become helpful 400 validation
errors, never raw SQL traces. All stored references remain inert.

Every successful mutation atomically writes note/activity, FTS where needed,
event and a serialized immutable receipt. The global op_id key is bound to
principal and canonical JSON of the exact method/params (not semantically
normalized defaults). Replay returns the stored receipt even after later edits,
not a new read. Different principal or intent returns 409 without exposing the
old receipt. Failed writes roll back everything and reserve no op_id. Tokens
are authenticated and scope checked before receipt lookup; body uploads trigger
a second authentication immediately before dispatch to honor intervening revoke.

Full replace, deletion, restore, metadata/status edits require base_rev.
A revision conflict is 409 with `{current: Note}` including latest attribution.
Exact edit searches the current snapshot under the write lock, counting
potentially overlapping occurrences; zero/multiple matches conflict. It does not
interpret meaning. Claims atomically check unclaimed/expired state using the
owner's clock, and derive claimed_by from principal. Another owner's release or
steal needs explicit force. Every rw token may force; claims are cooperative.

Local DB access already trusts OS filesystem access. CLI/MCP local principal is
`local`, device `local`, verified false; all local processes therefore share an
owner. Library users may supply local self-reported identity but it is not token
authentication. Remote clients have stable token-assigned UUID principal and a
device label, with verified true. Agent/session are optional, always explicitly
`labels_verified:false`; MCP clientInfo is not authenticated agent identity.
There is no generated/native agent session ID.

## HTTP and packaging

`node:http`, loopback default port 7391, minimal health, Bearer-only POST /v1/call.
Token creation uses 32 random bytes; only SHA-256 hashes enter the clients table.
No raw token enters events, receipts, list output or logs. Token/backup/config
administration is not in the RPC/MCP allowlist. Tokens are database-wide ro/rw,
not per-note ACLs. 1 MiB requests, bounded body/header/socket timeouts, no CORS,
no arbitrary exceptions or SQL traces. HTTP itself does not encrypt tokens.
Use an independently configured HTTPS endpoint, SSH or trusted private tunnel.

HttpStore sends one call request, with at most two default retries (configurable
0–5) on transport failure or 503 and 10-second default attempt timeout. Redirects
are rejected to avoid credential forwarding. No local fallback, cache or outbox.
SQLite is loaded dynamically only for local CLI/MCP; MCP SDK is loaded only for
MCP. Library root/client are SQLite-free; `./sqlite` explicitly opts into it.
Runtime direct dependencies are the official MCP SDK and zod; SDK transitive
HTTP/schema dependencies are not copied into the tarball.

SQLite files are local disk only; cross-device access goes through HTTP. Modes
0600 for DB and backups on POSIX, 0700 for new data/config directories. Private
POSIX token files are enforced; Windows ACLs need owner management. Filesystem
sync/network path detection is not comprehensive; the deployment constraint is
explicit. Backup reserves a new mode-0600 file, uses VACUUM INTO and opens the
snapshot read-only for integrity check. Restoration requires choosing a single
authority. Backup includes token hashes/receipts and is sensitive.

Non-goals/limitations: no paging snapshot across calls, compaction/retention,
per-note authorization, key rotation transport UI, automatic token refresh,
network-FS support, or throughput guarantees. Node 24's SQLite API is active
 development and emits experimental warnings. OS verification was Linux only.
