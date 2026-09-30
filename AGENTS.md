# HiveNote

Shared notes and task data for AI agents: TypeScript on Node 22.16+, built-in `node:sqlite`, used through a CLI, stdio MCP and an HTTP server.

```sh
npm ci
npm run typecheck
npm test                      # builds first
node scripts/pack-smoke.mjs   # installs the real tarball and checks the CLI and MCP
```

## Tests

- Test the main behavior users rely on, not every small detail. A new feature gets one or two tests of its main path, and a fixed bug gets one test that reproduces it.
- Don't add tests for unlikely edge cases, small input-validation variations, or code paths no user will hit.
- Prefer one realistic end-to-end test over many narrow ones.
- Before adding a test, ask: would a user notice if this broke? If not, skip it.
- When a refactor breaks one of the older narrow tests, delete it rather than rewrite it, unless it guards something a user would notice.
