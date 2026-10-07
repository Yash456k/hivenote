# HiveNote

Shared notes and task data for AI agents: TypeScript on Node 22.16+, built-in `node:sqlite`, used through a CLI, stdio MCP and an HTTP server.

```sh
npm ci
npm run typecheck
npm test                      # builds first
node scripts/pack-smoke.mjs   # installs the real tarball and checks the CLI and MCP
npm run bench                 # timings on this machine; not part of CI, whose machines are too uneven for them
```

## Releasing

Only when Yash says to release a version.

1. `package.json` (and `package-lock.json`) carry the version, and `CHANGELOG.md` has a `## X.Y.Z` section for it.
2. The work is merged into `main` and CI is green there.
3. `git tag vX.Y.Z` on that commit of `main`, then `git push origin vX.Y.Z`.

The tag starts `.github/workflows/release.yml`, which runs the checks again, publishes to npm and makes the GitHub release from the changelog section. npm trusts that workflow by name (trusted publishing, set up on npmjs.com under the package's settings), so there is no token, and nobody runs `npm publish` by hand.

## The cloudflared that `serve public` downloads

`src/tunnel.ts` names one cloudflared release and the SHA-256 of its program for each of eight kinds of machine. A download is run only if it matches. To move to a newer release:

1. Open that release on github.com/cloudflare/cloudflared and copy the checksums from its notes for `linux-amd64`, `linux-arm64`, `linux-arm`, `linux-386`, `darwin-amd64`, `darwin-arm64`, `windows-amd64` and `windows-386`.
2. For the two macOS entries the notes give the checksum of the program inside the `.tgz`, not of the `.tgz`. That is the one to use, because HiveNote checks the program it is about to run.
3. Change the version and all eight checksums together, then run `hivenote serve public` once on a machine with no cloudflared installed to see the download pass its check.

## Tests

- Test the main behavior users rely on, not every small detail. A new feature gets one or two tests of its main path, and a fixed bug gets one test that reproduces it.
- Don't add tests for unlikely edge cases, small input-validation variations, or code paths no user will hit.
- Prefer one realistic end-to-end test over many narrow ones.
- Before adding a test, ask: would a user notice if this broke? If not, skip it.
- When a refactor breaks one of the older narrow tests, delete it rather than rewrite it, unless it guards something a user would notice.

## Keeping users' data safe

People keep their notes in one SQLite file across every update. No release may lose or corrupt it.

- The schema version is `PRAGMA user_version` (`SCHEMA_VERSION` in `src/database.ts`). A schema change bumps it and adds a migration from the previous version; existing files are upgraded, never recreated.
- Migrations only add things: tables, columns with defaults, indexes. Never drop or rename a table or column that holds user data, and never rewrite note content.
- Before migrating, copy the file to `<db>.before-v<N>`, then run the whole migration in one transaction.
- A program that finds a newer schema refuses to open the file (it already does) rather than writing to it.
- Test each migration once against a real database file made by the previous release.
