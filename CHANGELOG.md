# Changelog

## 1.0.0

Tasks can wait on each other, agents can ask for the next one instead of picking it, a task whose agent stopped is picked up again, notes can be put in folders, and a worker keeps its writes while the queen is away. Nothing that worked before changes: old commands, the JSON they print and hive files made by 0.5 work as they did, and there is no schema change. A 1.0 worker needs the queen on 1.0 for `ready`, `take`, `after`, `task --after` and folders; with an older queen they fail with `queen_too_old` and change nothing, and everything else works.

- **A task can wait on others.** `hivenote task deploy "Ship it" --after build-api,review-api` makes a task that is ready only once both are done. `hivenote after deploy smoke-test` adds one later and `hivenote after deploy not review-api` takes one away. The board shows what each task still waits on (`waits_on`), and `read` does too. The hive keeps them by ID, so renaming a task keeps every link to it. A task can't end up waiting on itself through others.
- **`hivenote ready`** lists the tasks that can be started now: `todo`, with everything they wait on `done`. Oldest first.
- **`hivenote take`** takes the next ready task and answers as `mark NAME doing` does, with its text and progress. The queen picks and marks it in one write, so agents that start together each get a different task: 16 agents asking at once for 12 tasks got one each, and the other 4 were told nothing was ready and why.
- **A task whose agent stopped is picked up again.** A `doing` task with nothing done on it for 2 hours can be taken by `mark NAME doing` or `take` without `--anyway`, and the answer says from whom and how long it was idle (`"taken_over":{"from":"builder@laptop","idle":"3h"}`). Set the time with `{"takeover": "45m"}` in `config.json` on the machine that holds the hive, or `"off"`.
- **Folders.** A name with a `/` is in a folder: `deploy/staging-notes` is in `deploy/`. `hivenote list deploy/` shows what is in it. At a terminal, `list` shows each folder under its path; the JSON is as before. The dashboard shows a note's folder above its name, and what a task waits on.
- **A worker keeps its writes while the queen is away.** A write that can't reach her is kept on the worker and answered `{"ok":"queued",...}`; the next command that reaches her sends the kept writes first, in order. Each keeps the operation ID it was made with, so one that did arrive is not made twice, and one she refuses is said once and dropped. Taking a task and reading are never kept: they fail and say how many writes are waiting. `hivenote status` shows how many there are.
- **MCP and HTTP:** a `take` method and tool; `list` takes `ready` and `folder`; `create` takes `after`; `update_task` takes `after` and `not_after`.

## 0.5.0

Commands now print what an agent acts on, not everything the hive stores. Replayed over five recorded multi-agent runs, what the agents were shown came to 64% fewer tokens (about 85,000 a run down to about 31,000). A script that reads ids, attribution or the note a write returns adds `--full`. A 0.5 worker works with a 0.4 queen; the heads-up below needs the queen on 0.5. The HTTP API and the MCP tools answer as before, with fields added (`seq`, `activity_at`, `changed_by`, `active_by`, `previous`).

- **A write answers with one line.** `add`, `task`, `edit`, `append`, `replace`, `describe`, `mark`, `delete` and `restore` used to print the whole note back, with every field. Now `hivenote append build-api "..."` prints `{"ok":"appended","note":"build-api"}`. A change to the text says its new version number, and `delete` says the command that undoes it.
- **`read` shows the note, not its record.** Each note comes as its name, description, kind, status, when and by whom it last changed, its text, and its progress as `{by, ago, text}` lines. Before, every progress line was a whole event with an operation id and an attribution record, and every note carried its id, four timestamps and two more attribution records. `wait NAME` prints the same shape.
- **`history` is one line per change**, without a copy of the note in each.
- **`mark NAME doing` takes a task, and only one agent can.** An agent acting on an old look at the board could mark `doing` a task another agent was on, or had just finished, and both were told it worked. Now the hive refuses it and changes nothing: `'build-api' is taken: builder@laptop marked it doing 12s ago`, with what to do next. Two agents asking at the same moment cannot both get the task. `--anyway` marks it all the same. In 20 trial runs where three agents picked from one board, two of them marked the same task in 16; and in 20 where the board had gone stale, the agent reopened the finished task in all 20 before putting it back. The queen needs 0.5 for the check, and so does the machine that asks: a `mark doing` from a worker still on 0.4 happens as before.
- **A task that is taken is shown.** `mark NAME doing` answers with the task's description, text and progress, so an agent starts on it without a `read`. In the test runs, reading a task and then marking it were nearly always two commands.
- **Other marks say when they replace a state another agent set.** Setting a finished task back to `todo`, or anything marked with `--anyway`, still happens. The answer says what the task was (`"was":"done"`) and, when someone else set that, adds a `heads_up` naming them, how long ago, and the command that puts it back. It goes by who set the status, not who last edited the task.
- **Names say which machine.** A change made through a token shows as `codex@laptop`, the agent's label and the machine the token belongs to, on the board, in progress lines and in `wait`. Five Codex agents on five machines used to all read `codex`.
- **Times are ages.** `"ago":"3m"` where there was `"updated_at":"2026-10-10T16:21:06.737Z"`. An agent seldom knows what time it is, so an age is what it can act on, and it costs a fifth of the tokens. Exact times are in `--full`.
- **`--since` shows only what is new.** Every `list`, `tasks`, `read` and `wait` answer ends with `"seq"`, the number of the hive's latest change, and a `read` gives the command to run next time under `only_new`. `hivenote read build-api contract --since 47` gives the new progress lines, each note's status, and, where a note's text was rewritten, the passages that changed as `{was, now}`; notes with nothing new are named under `unchanged`. `wait NAME --since 47` answers in the same form, and names under `also_changed` the other notes that changed meanwhile. `hivenote wait --since 47` counts changes from that point, so one made between an agent's last look and the start of its wait is no longer slept through. The queen needs 0.5 for `read` and `list` to send `seq`. A note added since then comes whole, a changed description is shown, and a note rewritten back to what it said is reported as that, with who did what.
- **`wait` wakes at once.** It used to look every 5 seconds, so a waiting agent learned of a finished task 2.5 seconds late on average. Now the hive holds the question open and answers when something changes. The queen needs 0.5 for this; with an older queen `wait` looks every 5 seconds as before.
- **Listings put the latest activity first.** `list` and `tasks` were in name order. Now the note or task something last happened to leads, and a progress line counts. For a task, the name and the age shown are of one event; when someone else posted the latest line it is given beside them as `last_line`, so a task its owner has left does not look alive. Every note is still listed.
- **`mark NAME done "what you did"`** leaves the progress line and marks the task in one command. A third of the marks in those runs came straight after an `append` to the same task. On something that is not a task it is refused and adds nothing.
- **A `wait` that runs out of time says where the task stands:** `'build-api' did not reach done within 45 seconds. It is doing, last changed 3m ago by codex@laptop`. Half the time agents had read the task straight afterwards to find that out.
- **Clearer refusals.** Adding under a name that is taken says what is there (`'api' already exists: a task (doing) last changed by planner`). An `edit` whose old text doesn't match says whether it is missing or there more than once.
- **Text with `\n` typed out gets a word back.** A shell passes `'one\ntwo'` on as it is, so the note is saved with those two characters where a line break was meant. The answer now says so, and shows the stdin form that keeps real line breaks.
- **The version warning comes once a day.** A worker on a different release from its queen printed the warning on every command. An agent runs each command as a new process, so that was a line of noise on every answer.
- **`--full`** prints the stored record, as every version before this one did.
- **The hive's file stays smaller.** The hive keeps the answer it gave to each write, so that a write sent again after a lost connection is not made twice. It kept every one, each with a copy of the whole note: in a test of 11,000 writes they were 24 MB of a 36 MB file. Now it keeps the latest 2,000. A write sent again later than that is refused, not repeated. An existing file does not shrink, but the space is used again before the file grows.
- **The guide and `help` say that commands can share a line**, such as `hivenote list && hivenote read build-api`, which is one step for an agent where two commands are two.

## 0.4.1

- **Commands on a worker share one open connection.** Opening a connection to a queen far away took longer than the request itself. The first command now starts a small helper in the background that keeps the connection open for the ones after it; it leaves after ten idle minutes. From India to a queen in Germany a command went from about 600 ms to about 250 ms. Only workers need this version. A `"helper": "off"` line in `config.json` turns it off on a machine (`HIVENOTE_HELPER=off` for one command), and `hivenote status` shows whether the connection is kept open.
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
