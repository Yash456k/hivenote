# Real regression/integration checks

```sh
npm test
npm run bench
node scripts/pack-smoke.mjs
```

Build first when invoking individual `.test.mjs` files directly. These tests use
Node's test runner, native SQLite, actual HTTP sockets on ephemeral ports, real
CLI subprocesses, and the MCP SDK's `Client` + `StdioClientTransport`. They do not
replace the store with a mock or claim a protocol exchange from tool discovery
alone.

Coverage:

- Core lifecycle, exact/ambiguous edits, revision conflicts, immutable snapshots,
  activity-only append, paginated list/search/history/change feeds, tombstones,
  ID reservation/name reuse, restoration, attribution and idempotent receipts.
- Task ownership/expiry/force, 20 claim contenders and inert metadata.
- Online backup reopened as a store: notes/history/tombstones/receipts/tokens.
- Missing/invalid/revoked bearer auth, read-only authorization, malformed and
  oversize HTTP bodies (including chunked bodies), prototype-name methods,
  attribution spoofing, dropped post-commit response retries, SQLite-free remote
  client imports, and 20 simultaneous HTTP claim requests.
- Every command via real local/remote CLI processes, Unicode/space paths,
  UTF-8 file/stdin inputs, safe error exits, sandboxed persisted config,
  token-file precedence, token administration and local-only backup.
- Every MCP tool over local and HTTP-backed stdio, SDK validation/errors,
  authenticated attribution, read-only and revocation checks.
- Ten independently initialized processes making 100 successful writes each
  against one fresh database; exact global event/revision counts and historical
  snapshots. Another ten-process/100-edit run targets one shared note and
  reconciles all 1000 contributions with rev=1001. A separate 20-process
  optimistic race has exactly one winner.
- Packaging smoke: dry-run inventory, real tarball installation into a temporary
  prefix, installed executable help/version/create/read, Unicode/space paths,
  and a real installed MCP exchange covering every tool.

All fixture directories are created under `$TMPDIR` when set, otherwise repo
`.tmp/`, and cleaned up even on failure. CLI config and npm install/cache state
are sandboxed; no user database or global config is changed. Tests never require
a fixed TCP port. The packaging smoke retains the verified tarball in ignored
`.tmp/artifacts/`; its disposable installation and database are removed.

The benchmark creates exactly 300 bounded 1024-byte fixture notes and records
nearest-rank p50/p95 wall-clock milliseconds for local and warm HTTP read/list/
search and append, plus fresh CLI read/list/search processes. It reports actual
Node/platform metadata; these are measurements from the execution host, not
claims about an unmeasured personal computer. Fixture creation is not timed;
there are no machine-dependent pass/fail latency thresholds.
