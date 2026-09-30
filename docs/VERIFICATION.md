# Verification: executed results

Checks below used disposable fixture databases on Linux x64, never a real
user database. The npm package is unpublished. PC integration and actual
cross-device transport are not covered by these Linux verification results.

## Runtime matrix actually executed

| Runtime | Package manager | Build/typecheck | node:test | Installed artifact |
|---|---|---|---|---|
| Node 26.5.1 | npm 12.0.2 | pass | 62 pass, 0 fail/skip | actual bin + MCP pass |
| Node 24.0.0 | npm 11.3.0 | pass | 62 pass, 0 fail/skip | actual bin + MCP pass |

Node 24 was installed only into ignored task-local `.tmp/` for verification.
The baseline run performed a fresh `npm ci`, typecheck, build/full tests and
pack/install smoke under the Node 24/npm 11 PATH, including installed-bin shebang
execution. Node 24 emitted its real `ExperimentalWarning: SQLite is an
experimental feature and might change at any time` on stderr. Built-in FTS5,
DatabaseSync and VACUUM INTO worked without extra flags. Upstream classifies the
[24.0.0 SQLite module as Stability 1.1](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)
(active development), not a permanently stable API. Use maintained patches.
Windows/macOS were not tested; CI intentionally verifies Linux only.

Commands from a normal checkout:

```sh
npm ci
npm run typecheck
npm test
npm run bench
node scripts/pack-smoke.mjs
npm audit --json
```

## Behavioral and transport proof

- Actual CLI subprocesses, UTF-8 stdin/files, empty strings, spaces/non-ASCII
  paths, defaults/config, op-id replay and nonzero stderr errors.
- CRUD/discovery/batch reads, snippets/FTS validation, pagination counts,
  historical immutable revisions, delete/name reuse/ID reservation/restore,
  bounded append bodies visible on read and complete history/change cursors.
- Same fresh DB initialized by 10 independent processes; 100 writes each:
  exactly 1000 events and ten rev-100 notes with checked historical snapshots.
- A separate shared note edited by 10 independent processes, 100 exact edits
  each: 1000 successful contributions, every unique worker marker present,
  final rev 1001, history total 1001. No lost accepted write.
- 20 independent processes racing one base revision: exactly one winner and
  nineteen 409s. 20 simultaneous HTTP claim requests: exactly one owner and
  nineteen 409s. Claim expiry, owner release and explicit force audited.
- A server intentionally committed and dropped its response. HttpStore retried
  the same op_id, produced one event and returned the original immutable
  receipt; later edits did not change that receipt. Changed payload/method or
  another principal using that ID conflicted. Failed writes reserved nothing.
- Real ro/rw/revoked/missing auth checks, including revocation during body upload
  and replay after revoke. Spoofed attribution, unknown/prototype/admin methods,
  malformed JSON/data and oversize content-length/chunked bodies rejected.
- Local-only backup, existing destination refusal, integrity check and a reopened
  backup with content/history/tombstones/receipts/token authentication preserved.
  Read-only scope cannot mutate, administer tokens or create backups. POSIX
  database/backup/config/token-file permission checks exercised.
- Actual official SDK Client + StdioClientTransport exchanges in local AND
  remote configurations, all fifteen tools, optimistic errors, remote ro/revoke.
  Stdout parsed as MCP protocol, not simulated handler calls.
- Local CLI executed under a module-resolution hook that denied MCP imports;
  remote CLI succeeded with SQLite disabled (`--no-experimental-sqlite`).
  Remote client static dependency graph was also checked for SQLite imports.
  Invalid config and offline endpoint tests found no fallback database.

Initial integration runs caught a JSON prototype mismatch and an installed-bin
symlink entrypoint bug; both were fixed and covered before the passing runs.
The packaging helper handles npm 11 array and npm 12 name-keyed JSON inventory.

Independent reviews found and reproduced an authorization race during SQLite
write-lock acquisition, malformed Unicode diverging between stored content and
receipts, and CLI/MCP contract edge cases. Regression tests failed before the
fixes and passed afterward. The full 62-test suite and actual packed CLI/MCP
installation were rerun on both runtimes after those corrections:

- Authorization is revalidated within the acquired transaction, before writes
  or receipt replay. A separate process commits revocation while an HTTP write
  waits; the write is rejected with no note/event. Cached authenticated actors
  cannot bypass later revocation.
- Ill-formed Unicode is rejected rather than silently changed by UTF-8 binding;
  valid emoji and non-ASCII text round-trip through notes and revisions.
- Repeated non-batch selectors, unsupported command options and conflicting
  raw/native fields fail without silently discarding inputs. Explicit false
  help/version flags and whitespace-prefixed selector JSON behave correctly.
- MCP annotations conservatively identify non-additive mutations.

## Packed artifact

`pack-smoke.mjs` runs real `npm pack --dry-run --json`, creates the tarball,
installs it into a disposable prefix, invokes the installed `hivenote` executable
(help/version/create/read), then runs an actual installed MCP stdio exchange
covering all fifteen tools. Unicode/space paths are exercised. It checks the
allowlisted inventory excludes source tests, temp files, databases, env and logs.
It retains the tested tarball at ignored
`.tmp/artifacts/hivenote-0.1.0.tgz` and removes the disposable install.

The final tarball inventory/size are printed by the final smoke run rather than
hardcoded here (this document itself is part of the tarball). Package-lock is
committed; runtime direct dependencies are MCP SDK and zod. `npm audit --json`
reported **0 vulnerabilities** in all severities on the implementation host.
Audit results are time-dependent, not a guarantee of future advisory status.

## Repeatable benchmark: loopback only

Latest recorded Node 26.5.1 Linux x64 run: 300 notes, 1024-byte content each.
10 warmup calls, 100 timed local/warm-HTTP samples per method, 10 fresh CLI
process samples without CLI warmup. Nearest-rank percentiles, elapsed wall-clock
milliseconds via performance.now. Fixture creation is excluded; no latency
threshold is used as a test. Read is one note, list is a bounded page.

| Operation | p50 ms | p95 ms |
|---|---:|---:|
| Local read | 0.073 | 0.119 |
| Warm HTTP read | 1.106 | 1.476 |
| Cold CLI read | 50.035 | 55.641 |
| Local list | 0.385 | 1.707 |
| Warm HTTP list | 1.358 | 1.696 |
| Cold CLI list | 57.547 | 69.692 |
| Local search | 2.201 | 2.751 |
| Warm HTTP search | 3.040 | 3.688 |
| Cold CLI search | 56.486 | 63.192 |
| Local append | 1.069 | 1.284 |
| Warm HTTP append | 1.928 | 2.726 |

These are **this Linux host's loopback measurements**, not PC, India-to-server,
Cloudflare, Tailscale or Internet measurements. Cold CLI includes Node startup,
SQLite opening/schema-version check and JSON output. Expected run-to-run jitter
is visible; this is not a production capacity claim.

## Remaining limits

- GitHub workflow uses pinned actions and a Linux Node 24.0.0/24/26 matrix;
  check the repository's Actions page for the result at a particular commit.
- No Windows/macOS, cross-device tunnel, high-latency network or production-load
  claim; synchronous SQLite can block the server during busy waits/large queries.
- FS/network-sync folder detection is not comprehensive: local-disk deployment
  is a hard documented requirement. Windows ACL enforcement is owner-managed.
- Tokens authorize the entire database; no per-note ACLs. Any rw principal may
  explicitly force claims. Local filesystem principals share `local` by default.
- History/receipts grow indefinitely; no offline queue/sync or retention policy.
  Offset pages can shift across requests. Monotonic changes must be paged to
  exhaust has_more. Leases/due dates/references never execute or schedule work.
