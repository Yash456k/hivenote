# Sticky Notes 0.1

A database of shared memory and task data for agents. The name is provisional.
Discover lightweight note names/descriptions, then batch-read relevant content.
CLI, stdio MCP and authenticated HTTP share one application contract and one
SQLite authority. Nothing executes note content or metadata.

This is **not** orchestration, a scheduler, command execution, an AI integration,
a workflow engine or a session controller. No UI, local-first synchronization,
caches, replicas, Redis, ORM, vector database or provider SDKs.

## Runtime and installation

Node **24.0.0 or newer** is the API baseline; use a maintained Node 24 patch release
in normal use. Linux tests ran on 24.0.0 and 26.5.1. Built-in `node:sqlite` is
Stability 1.1 / active development in [Node 24.0.0](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)
and emits an experimental warning to stderr. No SQLite flag or native npm addon
is required. Windows/macOS-compatible source has not been tested on those OSes.

The provisional package `@yash456k/sticky-notes@0.1.0` is **unpublished on npm**.
This GitHub repository is private. Installation from authorized GitHub source:

```sh
git clone git@github.com:Yash456k/sticky-notes.git
cd sticky-notes
npm ci
npm run typecheck
npm test
npm pack
npm install --prefix ./installation ./yash456k-sticky-notes-0.1.0.tgz
./installation/node_modules/.bin/sticky --help
```

Alternatively install an owner-provided tarball with the last two commands.
A global tarball install is optional (`npm install -g ./PACKAGE.tgz`); this project
has not been published or globally installed by the implementation agent.
In source development use `node dist/cli.js` in place of `sticky` below.
`npm pack` compiles first. The tarball includes compiled JS/types, docs and license,
not source fixtures, credentials, databases or node_modules. On npm versions
that require lifecycle approval, approve the trusted package's build scripts
using your own package-manager policy; no global policy changes are required.

## Local use: no daemon

```sh
sticky create build-context --description 'Current design decisions' --content-file design.txt
sticky list --limit 20
sticky read --names '["build-context","acceptance"]'
sticky search 'design AND decisions'
sticky edit NOTE_UUID --old-str 'old wording' --new-str 'new wording' --base-rev 1
sticky replace NOTE_UUID --base-rev 2 --content-file - < replacement.txt
sticky append NOTE_UUID --body-file progress.txt
sticky history NOTE_UUID --limit 20
sticky revision NOTE_UUID --rev 1
sticky delete NOTE_UUID --base-rev 3
sticky restore NOTE_UUID --rev 1 --base-rev 4
sticky changes --since 0 --limit 100
```

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

- Linux: `$XDG_DATA_HOME/sticky-notes/data.db` or `~/.local/share/sticky-notes/data.db`;
  config under `$XDG_CONFIG_HOME/sticky-notes` or `~/.config/sticky-notes`.
- macOS: `~/Library/Application Support/sticky-notes`.
- Windows: data under `%LOCALAPPDATA%\sticky-notes`, config under `%APPDATA%\sticky-notes`.
- `STICKY_HOME` overrides both directories; `--db PATH` selects an explicit database.

**Keep the database, WAL and SHM on local disk only. Never put them on Dropbox,
Syncthing, an SMB/NFS/network share or another synchronization service.** The
program does not reliably detect every filesystem or sync-folder type. Multiple
processes on the same machine may open the same local file. Other devices use
HTTP to that database's owner, not copies of its file.

## Inert tasks and concurrency

```sh
sticky create release-check --kind task --description 'Acceptance checklist' --content-file checklist.txt
sticky claim TASK_UUID --ttl-seconds 900
sticky update-task TASK_UUID --base-rev 2 --status doing --due-at 2030-01-02T03:04:05Z
sticky release TASK_UUID
```

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
sticky --db /path/on/local/disk/notes.db token create --device laptop --scope rw
sticky --db /path/on/local/disk/notes.db token create --device observer --scope ro
sticky --db /path/on/local/disk/notes.db token list
sticky --db /path/on/local/disk/notes.db serve --port 7391
```

Each create prints a new high-entropy token **once**, in a JSON `token` field.
Store it privately (mode 0600 on POSIX); the database keeps only its SHA-256 hash.
Avoid shared logs or shell-history secrets. A client may use `STICKY_TOKEN` or a
private file; a configured token file takes precedence over the environment.
Tokens/admin/backup/config are local-only, never RPC/MCP methods. Revoke locally
with `sticky --db PATH token revoke CLIENT_UUID`; revocation also denies receipt
replays. `ro` can read all notes/history, `rw` can mutate all notes; there are no
per-note ACLs or separate force-operation roles in v0.1.

On a client device:

```sh
sticky --url https://notes.example.com --token-file /private/token.txt list
sticky config set --url https://notes.example.com --token-file /private/token.txt
sticky read --names '["build-context"]'
sticky config show
sticky config reset
sticky config set --db /path/on/local/disk/notes.db
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

## MCP examples (do not edit global configs automatically)

Claude Desktop JSON example; replace the bin path with your installation:

```json
{
  "mcpServers": {
    "sticky": {
      "command": "/absolute/installation/node_modules/.bin/sticky",
      "args": ["--db", "/absolute/local/notes.db", "mcp"]
    }
  }
}
```

Codex TOML example:

```toml
[mcp_servers.sticky]
command = "/absolute/installation/node_modules/.bin/sticky"
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

Run your existing named tunnel normally and manage its DNS yourself. Sticky
Notes' Bearer token is still required. Cloudflare Access is not integrated; an
interactive Access login wall is incompatible with this headless client unless
you independently provide a compatible transport. No Cloudflare account or
authentication platform is provisioned here.

## Backups and limits

`sticky --db PATH backup /new/private/backup.db` makes a consistent `VACUUM INTO`
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
prefix and runs the actual installed CLI and MCP SDK exchange. CI is committed
but was not run remotely before parent review/push.
