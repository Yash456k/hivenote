# Changelog

## 0.4.1

- **Commands on a worker share one open connection.** Opening a connection to a queen far away took longer than the request itself. The first command now starts a small helper in the background that keeps the connection open for the ones after it; it leaves after ten idle minutes. From India to a queen in Germany a command went from about 600 ms to about 250 ms. Only workers need this version. `HIVENOTE_HELPER=off` turns it off, and `hivenote status` shows whether the connection is kept open.
- **`hivenote mcp` on a worker keeps its connection open too.**

## 0.4.0

Only the queen needs this version to open a tunnel. Workers on 0.3 can connect to it; each command there prints one line suggesting the update. Notes, tokens and connections are kept.

- **`hivenote serve public` puts the queen on the internet.** It opens a Cloudflare quick tunnel and prints an https address that workers connect to from anywhere, with no account, domain or open port. The first time on a machine it says what a public hive means and asks you to agree; an agent or a script is told the same and agrees with `hivenote serve public yes`. Unless `cloudflared` is already installed, HiveNote downloads one fixed release of it and runs it only if its checksum matches. The address is random and lasts until the command stops.
- **`connect` offers the token a machine already has.** When a hive's address changes, `hivenote connect NEW-ADDRESS` asks whether to use the saved token, and Enter means yes, so nothing is pasted again. The reference has the steps for moving the queen to another machine.
- **`wait` takes a time limit.** It still gives up after 9 minutes by default. End the command with `90s`, `30m`, `2h` or `forever` to choose, for scripts and services that nothing cuts off at 10 minutes.
- **Shell habits work.** `hivenote ls`, `cat`, `grep`, `find`, `rm` and `log` do what `list`, `read`, `search`, `delete` and `history` do.
- **`serve` and `ui` no longer print Node's SQLite warning.**
- **`wait` keeps waiting when the queen is down behind a tunnel.** A tunnel or proxy answers with its own error page while the queen restarts. `wait` used to stop there with "invalid JSON response"; now it treats that as the queen being unreachable and checks again.

## 0.3.2

- **`wait` holds on for a note that doesn't exist yet.** `hivenote wait api-notes` used to fail when nobody had added `api-notes`; now it says so and wakes when someone does. `hivenote wait build-api done` waits until the task exists and is done.
- **`hivenote wait` with no name** wakes when anything in the hive changes, and lists what did.

## 0.3.1

Fixes found by reviewing 0.3.0 as a new user would meet it. Update the queen and restart `hivenote serve`, then the workers. Notes, tokens and connections are kept.

- **Honeycomb view.** The dashboard can show notes as a honeycomb as well as cards.
- **Text that looks like an option is saved as text.** `hivenote edit flags "--help" "--usage"` used to print the help and change nothing. Help and version now count only before the note's name.
- **A reused name keeps its history.** Adding a note under the name of a deleted one continues that note, so `history` and `restore` still reach the old versions.
- **Search finds progress.** It now covers each note's latest 100 progress lines. Progress added before this version becomes searchable the next time its note changes.
- **`history` shows the newest versions** of very large notes, instead of stopping at the oldest ones that fit in an answer.
- **The dashboard loads very large notes** it used to leave without text.
- **The saved token stays with its queen.** With `HIVENOTE_URL` set to another server, the token saved by `connect` was sent there; now only `HIVENOTE_TOKEN` is.
- **Messages name commands that exist.** The dashboard's token screen and three error messages still pointed at `token create`, `--port` and `--token-file`.
- **`serve 0.0.0.0`** says which address workers should use.

## 0.3.0

The commands are now plain words, and HiveNote got simpler underneath. Update the queen and every worker together, then copy the skill again so agents learn the new commands. Notes, tokens and connections are kept.

**New commands.** Notes are always named by their name, and text goes in as plain words instead of options:

| Before | Now |
|---|---|
| `create NAME --description D --content T` | `add NAME "D" "T"` |
| `create NAME --kind task --description D` | `task NAME "D"` |
| `list --kind task` | `tasks` |
| `edit ID --old-str A --new-str B` | `edit NAME "A" "B"` |
| `append ID --body T` | `append NAME "T"` |
| `replace ID --base-rev N --content T` | `replace NAME "T"` |
| `replace ID --description D` | `describe NAME "D"` |
| `update-task ID --base-rev N --status S` | `mark NAME S` |
| `claim`, `release` | `mark NAME doing` (claims are gone) |
| `read --names 'a,b'` | `read a b` |
| `wait --name NAME --status done` | `wait NAME done` |
| `restore ID --rev N --base-rev M` | `restore NAME N` |
| `delete ID --base-rev N` | `delete NAME` |
| `serve --host H --port P` | `serve H:P` |
| `token create --device L --scope ro` | `token add L read-only` |
| `token revoke ID` | `token remove L` |
| `config set/show/reset` | `connect`, `disconnect`, `status` |

The only options left are `--agent NAME` and `--json`. Old command names print what to use instead.

**Simpler model.**
- No version checks: the latest write wins, every change stays in history, and `restore` is the undo.
- No claims: a task shows who changed it last and when, and nothing is locked or expires.

**Fixes.**
- `hivenote ui` only answers the page it opened. Before, a request through a proxy could read the hive without a token.
- `wait` keeps going when the queen restarts, and only finishes on the task it started watching.
- Searching kebab-case names and hostnames works.
- The queen no longer stalls everyone for up to 5 seconds while another process writes.
- One answer is never larger than 5 MB.
- Files in an older Windows encoding keep their accents.
- An older HiveNote never touches a newer database.
- `connect` warns when the token would travel over plain http.
- A port that is already taken gets a clear message, and `ui` moves to the next free port.

**New.** `hivenote status`, readable output when you type commands yourself, the queen's crowned bee on the dashboard, and a warning when the queen and a worker run different versions. CI now runs on Linux, macOS and Windows.

## 0.2.x

The first public releases: shared notes and tasks over a CLI, MCP and HTTP, a live dashboard, and connecting machines with tokens.
