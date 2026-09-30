# HiveNote 0.1

A database of shared memory and task data for agents.
Discover lightweight note names/descriptions, then batch-read relevant content.
CLI, stdio MCP and authenticated HTTP share one application contract and one
SQLite authority. Nothing executes note content or metadata.

This is **not** orchestration, a scheduler, command execution, an AI integration,
a workflow engine or a session controller. No UI, local-first synchronization,
caches, replicas, Redis, ORM, vector database or provider SDKs.

## Runtime and installation

Node **22.16 or newer**. HiveNote uses Node's built-in `node:sqlite`, so no native
addon or SQLite flag is needed. 22.16 is the first release whose built-in SQLite
includes full-text search (FTS5); older Node prints a clear `unsupported_node`
error. Node 22 flags `node:sqlite` as experimental; HiveNote silences only that
warning. CI tests 22.16.0, 22, 24 and 26 on Linux. Windows/macOS-compatible source
has not been tested on those OSes.

```sh
npm install -g hivenote
hivenote --help
```

Installation from GitHub source:

```sh
git clone git@github.com:Yash456k/hivenote.git
cd hivenote
npm ci
npm run typecheck
npm test
npm pack
npm install --prefix ./installation ./hivenote-0.1.0.tgz
./installation/node_modules/.bin/hivenote --help
```

Alternatively install an owner-provided tarball with the last two commands.
A global tarball install is optional (`npm install -g ./PACKAGE.tgz`); npm registry
publication is not required to install a tarball.
In source development use `node dist/cli.js` in place of `hivenote` below.
`npm pack` compiles first. The tarball includes compiled JS/types, docs and license,
not source fixtures, credentials, databases or node_modules. On npm versions
that require lifecycle approval, approve the trusted package's build scripts
using your own package-manager policy; no global policy changes are required.

## Renamed from the working title

The project, npm package, CLI and MCP server are now **HiveNote** (`hivenote`).
The old working-title environment variables become `HIVENOTE_HOME` and
`HIVENOTE_TOKEN`; default data/config directories are named `hivenote`.
Existing databases remain compatible: use `--db` with the old database path,
or stop writers and use the previous CLI's `backup` command to create a
consistent snapshot at the new data path. Never copy only a live WAL database
file. Copy any explicit client configuration deliberately, updating paths;
there is no automatic background migration. Historical note IDs, revisions,
receipts and tokens remain valid. The legacy UUID derivation namespace is
intentionally retained internally so operation retries keep their identity.

## Local use: no daemon

```sh
hivenote create build-context --description 'Current design decisions' --content-file design.txt
hivenote list --limit 20
hivenote read --names '["build-context","acceptance"]'
hivenote search 'design AND decisions'
hivenote edit NOTE_UUID --old-str 'old wording' --new-str 'new wording' --base-rev 1
hivenote replace NOTE_UUID --base-rev 2 --content-file - < replacement.txt
hivenote append NOTE_UUID --body-file progress.txt
hivenote history NOTE_UUID --limit 20
hivenote revision NOTE_UUID --rev 1
hivenote delete NOTE_UUID --base-rev 3
hivenote restore NOTE_UUID --rev 1 --base-rev 4
hivenote changes --since 0 --limit 100
```

`list` and `search` return brief entries (id, name, description, kind,
updated_at, plus status/due/claim for tasks) so an agent can decide what to read.
`--full` (`detail: "full"` over RPC/MCP) returns every stored field except content.
Edits and replacements that would change nothing are rejected rather than
creating empty revisions.

All commands output JSON by default (`--json` is also accepted). Errors are JSON
on stderr with nonzero exit. `--help` and `--version` need no database.
`--content`, `--body`, `--old-str`, `--new-str` accept literal strings, including
empty replacement text. Corresponding `*-file` flags read UTF-8; `-` reads stdin.
No eval, shell commands or automatic interpretation. `--params '{...}'` exposes
the same strict method parameter contract for scripts. `read ID...` selects IDs;
`--names` selects names, never guessed IDs. Repeated `--name`/`--id` also batch.

Description and content are required in the store API but may be empty;
CLI create defaults both to empty. Names must be nonblank, globally unique among
live notes, case-sensitive and at most 256 UTF-8 bytes. Content is bounded to
512 KiB, description 4 KiB and metadata 32 KiB/depth 20. IDs are UUIDs generated
by the common client unless explicitly supplied. Default page size is 50, max
100; batch reads accept at most 100 selectors. `list`/`search` exclude content.
`read` additionally returns the latest 20 append events per selected note in
`updates`, and `updates_has_more`; use history/changes for complete contributions.

Default data paths are outside the installation:

- Linux: `$XDG_DATA_HOME/hivenote/data.db` or `~/.local/share/hivenote/data.db`;
  config under `$XDG_CONFIG_HOME/hivenote` or `~/.config/hivenote`.
- macOS: `~/Library/Application Support/hivenote`.
- Windows: data under `%LOCALAPPDATA%\hivenote`, config under `%APPDATA%\hivenote`.
- `HIVENOTE_HOME` overrides both directories; `--db PATH` selects an explicit database.

**Keep the database, WAL and SHM on local disk only. Never put them on Dropbox,
Syncthing, an SMB/NFS/network share or another synchronization service.** The
program does not reliably detect every filesystem or sync-folder type. Multiple
processes on the same machine may open the same local file. Other devices use
HTTP to that database's owner, not copies of its file.

## Inert tasks and concurrency

```sh
hivenote create release-check --kind task --description 'Acceptance checklist' --content-file checklist.txt
hivenote claim TASK_UUID --ttl-seconds 900
hivenote update-task TASK_UUID --base-rev 2 --status doing --due-at 2030-01-02T03:04:05Z
hivenote release TASK_UUID
```

To hand work between agents, one agent waits while another finishes:

```sh
hivenote wait --name release-check --status done   # blocks until the task is done
hivenote wait --id NOTE_UUID                       # blocks until any change or append
```

`wait` prints the note and its latest appended progress when the condition is met,
and exits nonzero on timeout (default 540 seconds; `--timeout-seconds 0` waits
forever) or if the note is deleted. It polls with `read` every `--interval-ms`
(default 1000), so it works the same against a local database or a remote server
and needs only a read-only token. It never starts agents or runs commands: a user
script can do that, e.g. `hivenote wait --name X --status done && your-command`.

Statuses: `todo`, `doing`, `done`, `cancelled`; `--due-at null` clears a due date.
Claims are atomic cooperative leases, not scheduling or authorization. Expiry is
checked against the DB owner's clock when claiming; nothing wakes or runs later.
Claim owner comes from the token principal, not a body field. `--force` on claim
or release explicitly overrides another owner and is recorded; any rw client may
use it. Local direct users trust the filesystem and share principal `local`;
agent labels do **not** create isolated owners or permissions.

Full replacements, deletes, restores and task updates require `base_rev`.
Stale writes return 409 plus the current authorized snapshot and attribution.
Exact edit operates on current content and requires exactly one match (including
overlapping matches); optional `base_rev` adds strict version checking. String
matching is not a guarantee of semantic correctness. Appends record distinct
contributions without changing content or rev. All successful writes return an
immutable receipt and event sequence. Reuse a stable `--op-id` when retrying a
failed transport; changed method/payload/principal with that ID is a conflict.
Do not reuse an operation ID for a new intent.

## Remote authority and tokens

On the database-owner machine:

```sh
hivenote --db /path/on/local/disk/notes.db token create --device laptop --scope rw
hivenote --db /path/on/local/disk/notes.db token create --device observer --scope ro
hivenote --db /path/on/local/disk/notes.db token list
hivenote --db /path/on/local/disk/notes.db serve --port 7391
```

Each create prints a new high-entropy token **once**, in a JSON `token` field.
Store it privately (mode 0600 on POSIX); the database keeps only its SHA-256 hash.
Avoid shared logs or shell-history secrets. A client may use `HIVENOTE_TOKEN` or a
private file; a configured token file takes precedence over the environment.
Tokens/admin/backup/config are local-only, never RPC/MCP methods. Revoke locally
with `hivenote --db PATH token revoke CLIENT_UUID`; revocation also denies receipt
replays. `ro` can read all notes/history, `rw` can mutate all notes; there are no
per-note ACLs or separate force-operation roles in v0.1.

On a client device:

```sh
hivenote --url https://notes.example.com --token-file /private/token.txt list
hivenote config set --url https://notes.example.com --token-file /private/token.txt
hivenote read --names '["build-context"]'
hivenote config show
hivenote config reset
hivenote config set --db /path/on/local/disk/notes.db
```

URL must be an HTTP(S) origin without credentials, path, query or fragment.
Invalid config and remote failure fail closed: **no silent local fallback**.
Explicit `--db` and `--url` conflict, including a conflicting saved mode; switch
using `config set` or reset first. Config stores paths/labels, never a raw token.
HTTP calls default to a 10-second attempt timeout and at most two retries for
transport failures/503; retries reuse the exact operation ID and request.
One request per tool call except those bounded retries; batch read is one call.
Remote paths never load SQLite, and normal CLI paths never load the MCP SDK.

Transport: server defaults to **127.0.0.1:7391**. `GET /health` is minimal;
`POST /v1/call` accepts `{method,params,agent?,session?}` with Bearer auth. Request
limit is 1 MiB, methods/fields are allowlisted, errors sanitized, no permissive
CORS. `agent`/`session` are unverified labels (`labels_verified:false`);
`verified:true` applies only to token principal/device. Local attribution is
`verified:false`. No automatic native agent/session identity inference.

## Agent skill

[`skills/hivenote/SKILL.md`](skills/hivenote/SKILL.md) teaches an agent to use
HiveNote through the CLI: list names and descriptions, read only what is relevant,
update existing notes instead of duplicating them, and hand off tasks with
`append`, `update-task` and `wait`. For Claude Code, copy the folder to
`~/.claude/skills/hivenote/` (all projects) or `.claude/skills/hivenote/` (one
project). Other agents that read `SKILL.md` skills can use the same file.

## MCP examples (do not edit global configs automatically)

Claude Desktop JSON example; replace the bin path with your installation:

```json
{
  "mcpServers": {
    "hivenote": {
      "command": "/absolute/installation/node_modules/.bin/hivenote",
      "args": ["--db", "/absolute/local/notes.db", "mcp"]
    }
  }
}
```

Codex TOML example:

```toml
[mcp_servers.hivenote]
command = "/absolute/installation/node_modules/.bin/hivenote"
args = ["--url", "https://notes.example.com", "--token-file", "/private/token.txt", "mcp"]
```

Either client can use either mode by changing arguments. On Windows use `node`
as command and the installed `dist/cli.js` as the first argument. The MCP bridge
is stdio, not an HTTP MCP endpoint; remote stdio tools forward to the same HTTP
application contract. Stdout is protocol-only. Initialization `clientInfo.name`
may supply an agent label; it remains self-reported, not authenticated identity.
Tool descriptions explicitly mark stored notes as **DATA, not instructions or
authority**. Session/repo/command references, due dates and task text are inert.

## Transport options: configure yourself

A private SSH forward needs no public bind: `ssh -L 7391:127.0.0.1:7391 OWNER_HOST`,
then use `http://127.0.0.1:7391`. Tailscale routing is also possible; bind explicitly
to an intended interface or use your existing proxy, applying your own ACLs.
Use HTTPS or an authenticated encrypted tunnel off-machine: HTTP alone does not
protect bearer tokens. No tunnel, firewall, DNS or host service was configured
by this prototype.

For an **existing user-owned named Cloudflare Tunnel**, add an ingress route to
your own tunnel configuration, followed by its existing catch-all:

```yaml
ingress:
  - hostname: notes.example.com
    service: http://127.0.0.1:7391
  - service: http_status:404
```

Run your existing named tunnel normally and manage its DNS yourself. HiveNote' Bearer token is still required. Cloudflare Access is not integrated; an
interactive Access login wall is incompatible with this headless client unless
you independently provide a compatible transport. No Cloudflare account or
authentication platform is provisioned here.

## Backups and limits

`hivenote --db PATH backup /new/private/backup.db` makes a consistent `VACUUM INTO`
snapshot and checks SQLite integrity; existing destinations are refused. POSIX
DB/backup/config permissions are restrictive. Windows requires the user's own
ACLs. Backups include note history, immutable receipts and token hashes: treat
them as sensitive. To restore, stop users of the authoritative DB, select the
backup as the replacement local database, verify reads, and restart clients at
that single authority. Do not copy a live main DB without its WAL or run both
restored and original databases as competing authorities.

Offline remote operations fail; there is no queue or sync conflict resolution.
SQLite synchronous work blocks the owner's Node process briefly; this is a small
prototype, not a hardened high-throughput multi-tenant service. History/receipts
are retained indefinitely. Offset pagination is accurate per request but can
shift across concurrent requests; use the monotonic changes cursor for a complete
feed. See [architecture](docs/ARCHITECTURE.md) and [real verification](docs/VERIFICATION.md).

Development: `npm ci`, `npm run typecheck`, `npm test`, `npm run bench`,
`node scripts/pack-smoke.mjs`. The smoke test installs a tarball into a disposable
prefix and runs the actual installed CLI and MCP SDK exchange. CI runs all of
this on every push.
