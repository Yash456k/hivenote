# Changelog

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
