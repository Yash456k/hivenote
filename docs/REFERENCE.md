# HiveNote reference

Everything the [README](../README.md) leaves out. `hivenote help` lists the commands too.

## Notes

```sh
hivenote list                                   # every note: name and one-line description
hivenote list deploy/                           # the notes in a folder
hivenote read deploy-notes api-decisions        # full notes, with their latest 20 progress lines
hivenote search deploy staging                  # notes containing all of these words
hivenote add deploy-notes "How we ship" "Run migrations on staging first."
hivenote edit deploy-notes "staging" "production"
hivenote append deploy-notes "Shipped 1.4 to staging"
hivenote replace deploy-notes - < deploy.md     # rewrite the whole note
hivenote describe deploy-notes "How we ship, and what broke last time"
hivenote delete deploy-notes
hivenote history deploy-notes                   # the latest 100 changes, with version numbers
hivenote restore deploy-notes 3                 # undo: bring back version 3
```

Every note has a **name** (unique among notes that aren't deleted, at most 256 bytes), a one-line **description** (at most 4 KB) and **text** (at most 512 KB). Notes are always named by their name. A name keeps one history: add a note under the name of a deleted one and it continues that note, so the old versions are still in `history`. Each note also has an ID inside; it shows up in JSON but no command asks for it.

**Folders.** A name can contain `/`, and the part before the last `/` is the note's folder: `deploy/staging-notes` is in `deploy/`, and `deploy/prod/runbook` in `deploy/prod/`. There is nothing else to a folder; it exists while a note is in it. `hivenote list deploy/` shows everything under `deploy/`, subfolders included, and says so when nothing is there. At a terminal, plain `list` shows the notes outside any folder first, then each folder under its path. The JSON is the same as for any `list`, with each note under its full name.

The description and text a command needs are saved exactly as written, even when they look like an option, so a note can say `--help`. Any text argument can be `-`, which reads the text from stdin: a file piped in, or a heredoc. Use that for the one case words can't express: an optional text (the third word of `add` or `task`) that is exactly `--json`, `--agent` or `--after`. Text that is valid UTF-8 is stored exactly as given. A file saved in an older Windows encoding is read as Windows-1252, so letters like é survive.

**Changes and undo.** Every version of a note is kept in its history with who made it and when, including deletes: `restore` brings back any earlier version, and it finds a deleted note by its name. Progress lines are kept too, but they are not versions, so `restore` leaves them as they are. There is no version checking; the latest write wins. `edit` works on the current text and needs its old text to appear exactly once, so an edit based on outdated text is refused instead of landing in the wrong place. `append` adds a progress line without changing the note's text.

**Search.** It covers each note's name, description, text and latest 100 progress lines. Plain words find notes containing all of them, so names like `api-decisions` and hosts like `stg.example.com` work as typed. Quotes, parentheses, `*` or `AND`/`OR`/`NOT` switch to SQLite full-text syntax, such as `"exact phrase"` or `deploy*`.

**Size.** One answer is at most 5 MB. `read` names any note that didn't fit in `too_big` (read it on its own), and says when older progress was left out.

Shell habits are understood: `ls` is `list`, `cat` is `read`, `grep` and `find` are `search`, `rm` is `delete` and `log` is `history`.

## Tasks

```sh
hivenote task build-api "POST /bookings with conflict checks"
hivenote task deploy "Ship it" --after build-api,review-api   # waits until both are done
hivenote after deploy smoke-test                # deploy also waits on smoke-test
hivenote after deploy not review-api            # and no longer on review-api
hivenote tasks                                  # the board, with what each task waits on
hivenote ready                                  # todo tasks with nothing left to wait on
hivenote take                                   # take the next ready task and print it
hivenote mark build-api doing                   # take this one and print it; refused when another agent has it or has finished it
hivenote mark build-api todo                    # or done, cancelled
hivenote mark build-api done "what I did"       # leave a progress line and mark it, in one command
hivenote wait build-api done                    # until it's done
hivenote wait build-api                         # until it changes at all, including progress
hivenote wait                                   # until anything in the hive changes
hivenote wait build-api done 30m                # hold on for 30 minutes (90s, 2h and forever work too)
hivenote wait --since 47                        # count changes from an earlier answer's "seq", not from now
```

A task is a note with a status. The board shows each task's status, who changed it last and how long ago, and what it waits on, such as `[todo · planner · 2h ago · waits on build-api]`. That is the whole coordination model: nothing is locked.

**Waiting on other tasks.** `--after` names the tasks a new task waits on, separated by commas (or give `--after` more than once). `hivenote after NAME OTHER...` adds to them later and `hivenote after NAME not OTHER...` removes some; both answer with everything the task now waits on, as `after`. A task is ready when it is `todo` and each task it waits on is `done` or `cancelled`; a deleted one no longer holds it up either (restoring it brings the wait back). Cancelling a task that others wait on lets them go ahead without it, and the answer names them in `heads_up`, so whoever cancelled it can check whether they still make sense and cancel or delete them if not. `tasks`, `list` and `read` give the ones still open as `waits_on`. A task can wait only on tasks, never on itself, and never on one that already waits on it, directly or through others. The hive keeps the tasks by their IDs, so renaming one keeps every link to it, and the screen always shows their current names. `mark` does not check them: marking a waiting task `doing` is allowed, for whoever knows better.

**Taking a task.** `hivenote ready` lists the ready tasks, oldest first. `hivenote take` takes the first of them in one step and answers as `mark NAME doing` does, with `"ok":"taken"`. The queen picks the task and marks it inside one write, so agents that ask at the same moment each get a different one. When none is ready, it takes a task whose agent has gone quiet (below). When there is nothing at all, it exits with the error `nothing_ready`, which says how many tasks wait on others and how many are being done, so `hivenote take && ...` stops there.

An agent can act on an old look at the board, so taking a task is checked by the hive: `mark NAME doing` is refused with the error `taken`, and changes nothing, when another agent marked the task `doing`, `done` or `cancelled`. The refusal names them and says how long ago. Two agents that ask at the same moment cannot both get the task. `--anyway` marks it all the same, for a finished task that has to be reopened, or a task whose agent you know has stopped. The check is made by the queen when the machine that asks is on 0.5 or newer too; with an older queen, or from an older worker, the mark happens as before. Every other `mark` still happens whatever the task said: it says what that was (`"was":"doing"`), and adds a `heads_up` when the state it replaced was set by another agent, with the command that puts it back.

**A task whose agent stopped.** An agent that dies leaves its task `doing`. By default it stays that way until someone marks it with `--anyway`. To let such tasks be picked up on their own, set a takeover time on the machine that holds the hive (the queen, or this machine for a local hive) with a line in its `config.json`, read when a command or `serve` starts. Once nothing has happened on a task for that long (no mark, no edit, no progress line from anyone), `mark NAME doing` and `take` take it without `--anyway`, and the answer says from whom and for how long it was idle: `"taken_over":{"from":"builder@laptop","idle":"3h"}`. Its progress is in the same answer.

```json
{ "takeover": "45m" }
```

`90m`, `2h`, `1d` and so on work; `"off"`, or no line at all, means a task is never taken over this way. Pick a time longer than any of your agents goes quiet while working, such as a long build.

`wait` returns within a moment of the change it is waiting for: the hive holds the question open and answers when something happens (a queen older than 0.5 is asked every 5 seconds instead). It waits for up to 9 minutes, then exits with an error, which keeps it under the 10-minute limit agents such as Claude Code put on one command. A script or service with no such limit can end the command with its own: `90s`, `30m`, `2h`, or `forever` to never give up. Waiting for a status checks how things stand first, so a loop that waits again after a timeout misses nothing; the limit word is always the last one, so a note that is itself named `forever` is waited for as `hivenote wait forever forever`. If the note doesn't exist yet, it says so and holds on until someone adds it. With no name, it returns as soon as anything in the hive changes and lists each change: the note, what happened, and who did it. It follows the note it found first, so a different task created later under the same name never counts. If the queen restarts or the network drops while waiting, it keeps checking until its time is up. It only reads, so `hivenote wait build-api done && your-command` is how a script carries on afterwards. When its time is up, the error says where the task stands: `'build-api' did not reach done within 45 seconds. It is doing, last changed 3m ago by codex@laptop`.

### Coming back to notes you have read

An agent reads a task, works for a while, and comes back. Reading the notes again sends all of it again, and a `wait` begun now sleeps through whatever changed in between. Every `list`, `tasks`, `read` and `wait` answer therefore ends with `"seq"`, the number of the hive's latest change. A `read` also gives the command ready to run, as `"only_new":"hivenote read build-api contract --since 47"`. Handed back with `--since`:

```sh
hivenote read build-api contract --since 47     # only what changed after 47
hivenote wait --since 47                        # answers at once if anything changed after 47
```

`read --since` gives, for each note that changed, its status, who changed it and how long ago, and its new progress lines. A note added since then comes whole. If a note's text was rewritten, it gives the passages that changed as `text_changes`, a list of `{was, now}` (or `{after, added}` for lines that were only added), or the whole text when that is shorter; a changed description is given too. If it was rewritten and reads the same as before (an edit that another agent undid, say), it says `"text":"the same as at 47"` and lists who did what under `rewritten`. Notes with nothing new are named under `unchanged`. `wait NAME --since` answers in the same form, and names under `also_changed` any other notes that changed since then, so an agent watching one task hears that the contract moved. A number higher than the hive's latest change is refused. `--since` needs a queen on 0.5 or newer: an older one sends no `seq`.

## Labels

Every change records who made it. When HiveNote runs inside Claude Code, Codex or Hermes, it labels changes `claude-code`, `codex` or `hermes` on its own, from their environment variables. When several agents share one machine, give each a role with `--agent builder-1`. Labels are self-reported, for telling agents apart, not for security. On a queen, a change also carries the name of the token it came in with, which is checked, so names read `codex@laptop`: the agent's own label, then the machine.

## One queen, many workers

One machine is the **queen**: it keeps the hive's database and serves it. Every other machine is a **worker** that connects to it.

On the queen:

```sh
hivenote token add laptop                       # read/write; prints the token once
hivenote token add dashboard read-only          # for a browser that only watches
hivenote token list
hivenote token remove laptop                    # that machine is shut out at its next request
hivenote serve 0.0.0.0                          # or serve 0.0.0.0:8080, or serve :7391
hivenote serve public                           # on the internet through a Cloudflare tunnel (or serve public :8080; add yes to agree without being asked)
```

`serve` listens on 127.0.0.1:7391 unless told otherwise. `0.0.0.0` means every address the queen has; workers connect to one of them, such as `http://192.168.1.20:7391`. The database stores only a hash of each token.

On a worker:

```sh
hivenote connect                                # asks for the URL and the token (typed hidden)
echo "$TOKEN" | hivenote connect https://queen.example.com
hivenote status                                 # which hive, whether it answers, and notes kept here
hivenote merge                                  # send the queen the new notes kept while she was away
hivenote disconnect                             # back to this machine's own hive
```

`connect` checks the URL and token before saving them, keeps the token in a private file (mode 600) in HiveNote's settings folder, and from then on every note and task command on that machine, including agents', uses the queen. `ui`, `serve`, `token` and `backup` only run on the machine that holds the hive; from a worker, open the queen's dashboard at her address instead. A machine that is already connected is offered the token it has: `hivenote connect NEW-ADDRESS` asks `Use the token saved for OLD-ADDRESS? [Y/n]`, and Enter means yes. A hive keeps its tokens when its address changes, so nothing has to be pasted again; if the queen at the new address turns the token down, `connect` asks for one as usual. The question is only asked in a terminal, since it sends the saved token to the address you gave; a piped token is used as given. If the queen can't be reached, commands never quietly fall back to a local hive. `status` says which of these is wrong: the queen is down, the address isn't a queen, or the token was rejected.

**While the queen is away.** A worker keeps working. Reads (`list`, `read`, `search`, `tasks`) answer from what this machine last saw of her hive, with `"offline": {"as_of", "heads_up"}` saying how old that is; others may have changed it since. A machine that has never reached her has nothing to answer from, and says so. `wait` waits for her.

Writes that can't undo anyone's work are kept, and answer `{"ok":"queued","note","kept"}`, so the agent knows not to make them again:

- new notes and tasks (`add`, `task`);
- progress lines (`append`) on any note this machine has seen: they only add;
- anything done to a note added here while she was away (`edit`, `replace`, `describe`, `mark`, `delete`, `append`), since nobody else has it yet.

Every other change to one of her notes (an `edit`, `mark`, `delete` and so on) is refused and changes nothing, so nothing is ever replayed over what others did meanwhile. Taking a task needs her answer. While writes are kept, every command says so once: a line on stderr at a terminal, and `"kept"` in JSON, on errors too. Notes added here show up in `list` and `read` beside hers until they are merged.

`hivenote merge` sends what was kept to the queen this machine is connected to, oldest first, each by the note's ID, under the agent's label and with the operation ID it was made with: one she already has is never made twice, a progress line never lands on another note, and `merge` can run again after a crash part way through. It answers with how many were `applied`, how many she had `already`, and `conflicts`, each as `{note, kind, by, why}`: a note added here whose name someone used meanwhile, or progress for a note she deleted meanwhile. Nothing of hers is ever changed by a merge. Agents are told to run it only when the user says so. Writes are kept for the queen they were meant for: if this machine has since connected to another queen, `merge` refuses with `other_queen` and sends nothing, so one hive's notes never end up in another. A read-only token's writes are not kept as conflicts either: `merge` stops and keeps them.

A conflict waits on the worker until it is settled, and every answer carries `"conflicts"`, their count, until then:

```sh
hivenote conflicts                              # each one: what was kept, and what the queen has under that name
hivenote resolve outage as outage-writeup       # add it under another name (or the same name, to try again)
hivenote resolve outage append                  # add it as progress on the note she has
hivenote resolve outage drop                    # forget it
```

The MCP server doesn't do any of this; its calls fail while the queen is away.

**`serve public`** gives the queen an address on the internet without an account, a domain or an open port. It serves the hive on 127.0.0.1 and runs Cloudflare's `cloudflared` program, which connects out to Cloudflare and gets a random `https://….trycloudflare.com` address (a [quick tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). The command prints that address; workers use it with `hivenote connect`, and the dashboard is at the same address. Every request still needs a token.

- The address lasts until the command stops. Starting it again gives a new address, and every worker runs `hivenote connect` again. If `cloudflared` stops by itself, HiveNote starts it again and prints the new address.
- A new address can take up to a minute to work from every network.
- Cloudflare gives quick tunnels no uptime guarantee and allows 200 requests at a time. For a hive that must stay at one address, use a tunnel of your own or Tailscale, as below.
- **You are asked first.** The first time on a machine, `serve public` says what it is about to do and asks `Put this hive on the internet? [y/N]`; the default is no. After a yes it does not ask again there, and every later start prints one line saying the hive is public and which machines hold a token. Without a terminal (an agent, a script, a service) it answers with the same explanation and stops; running it again as `hivenote serve public yes` agrees.
- **What public means.** Anyone who has the address can reach the queen; reading or writing still needs a token. The traffic passes through Cloudflare, which can read it, so don't keep secrets in a hive you make public.
- **Which cloudflared runs.** The one on your PATH if there is one, or the one `HIVENOTE_CLOUDFLARED` points at; those are yours and are run as they are. Otherwise HiveNote downloads one fixed release for your machine from `github.com/cloudflare/cloudflared` and keeps it beside the database. It is run only if its SHA-256 is the one Cloudflare published for that release; the kept copy is checked again at every start, and a file that doesn't match is deleted without being run.

Any other address works too: your LAN, Tailscale, or a tunnel you run. The token travels with every request, so over plain `http://` anyone on the same network could read it; `connect` warns about that except for this machine and Tailscale addresses, which encrypt traffic themselves. On a network you don't fully trust, and always across the internet, use HTTPS or Tailscale. For an existing Cloudflare tunnel, add a route to its configuration:

```yaml
ingress:
  - hostname: queen.example.com
    service: http://127.0.0.1:7391
  - service: http_status:404
```

With Tailscale, `tailscale serve --bg --https=8444 http://127.0.0.1:7391` gives the queen a private HTTPS address on your tailnet. An SSH forward works too: `ssh -L 7391:127.0.0.1:7391 QUEEN_HOST`, then connect to `http://127.0.0.1:7391`.

**One connection, kept open.** Each command is its own process, and opening a connection to a queen far away takes longer than the request itself. So the first command on a worker starts a small helper in the background that keeps one connection to the queen open, and the commands after it hand their request to the helper. From India to a queen in Germany that took a command from about 600 ms to about 250 ms. The helper leaves after ten idle minutes, and `hivenote status` says whether the connection is `kept open`. It listens only on a private socket in HiveNote's settings folder, answers only a command that holds the same token, and talks only to the queen this machine is connected to. If it is missing or stuck, a command goes to the queen directly, as it always did.

To turn the helper off on a machine, add a line to `config.json` in HiveNote's settings folder (`~/.config/hivenote/config.json` on Linux):

```json
{ "helper": "off" }
```

`"helper": "300"` keeps it for 300 idle seconds instead of 600, and `"on"` or no line is the default. `connect` and `disconnect` leave the line alone. `HIVENOTE_HELPER` does the same for one command and wins over the file.

**Moving the queen.** To make another machine the queen:

1. On the old queen, run `hivenote backup hive.db`, then stop `hivenote serve`. The old queen has to stop first; two machines serving copies of one hive drift apart.
2. Copy `hive.db` to the new machine and put it in place as that machine's database (the path is under [Scripts and environment](#scripts-and-environment)). If the new machine was a worker, run `hivenote disconnect` there first.
3. On the new machine, run `hivenote serve` or `hivenote serve public`.
4. On every worker, run `hivenote connect NEW-ADDRESS` and press Enter to keep the token it has. The copy carries the tokens, so they still work.

The old queen can join as a worker too: `hivenote token add LABEL` on the new queen, then `hivenote connect NEW-ADDRESS` on the old one.

**Versions.** The queen and its workers should run the same version. Every answer carries the queen's version, and a worker prints a warning when the two differ in their first two numbers, once a day and not on every command. Update the queen first. A 1.0 worker with an older queen gets the error `queen_too_old`, and nothing changes, for `ready`, `take`, `after`, `task --after` and `list FOLDER/`; everything else works as before.

## Dashboard

`hivenote ui` opens a live view of this machine's hive: notes as cards you can drag around (the order is saved in your browser only), the task board, and a feed of what each agent did, refreshed every two seconds. It opens the page with a key made for that launch, carried in the link's `#` part, which browsers never send to any server; only a page holding that key can read, and nothing can write from the page. Starting `ui` again makes a new key. If port 7391 is taken, it uses the next free one.

The queen's `serve` also serves the dashboard at `/`. There, each browser pastes a token once (a read-only one is enough) and remembers it. A request with neither a token nor the `ui` key is refused, wherever it comes from.

## Scripts and environment

Agents and scripts always get JSON: results on stdout, and errors on stderr as `{"error":{"code","message","status"}}` with a nonzero exit.

That JSON holds what an agent acts on, not everything the hive stores:

- `read` and `wait NAME` give each note as `name`, `description`, `kind`, `status`, `updated_by`, `ago`, `content` and `progress`, a list of `{by, ago, text}`; `read` adds `waits_on` for a task that has some.
- `list`, `tasks`, `ready` and `search` give `name`, `description`, `kind`, `ago`, and for tasks `status`, `updated_by` and, when some are not done, `waits_on`. `list` and `tasks` put the latest activity first. For a task, `updated_by` and `ago` are one event: the latest thing its last changer did, a progress line included. If someone else posted the latest line, that is given beside it as `last_line`, `{by, ago}`, so a task its owner has left does not look alive.
- `history` gives one line per change: `version`, `kind`, `by`, `ago`, and `text` for a progress line.
- A write answers with `{"ok", "note"}`, plus `version` after a change to the text, `status` and `was` after `mark` and `take` (and, when the task was taken, its `description`, `content`, `progress` and the hive's `seq`, and `taken_over` when it came from an idle agent), `after` after `after` or `task --after`, the `status` put back by a `restore` of a task, and `undo` after `delete`. A note kept for a queen that can't be reached answers `{"ok":"queued", "note", "kept"}`, and on a worker every answer carries `"kept"` and `"conflicts"` while there are any.
- `ago` is an age, such as `40s`, `3m`, `2h` or `5d`. An agent seldom knows what time it is, so an age is what it can act on, and a timestamp costs about five times as many tokens. The exact times are in `--full`.
- `list`, `tasks`, `read` and `wait` end with `seq`, for `--since`; `read` adds `only_new`, that command written out.

`--full` prints the stored record instead: ids, every timestamp, the full attribution of each change, a copy of the note in each history entry (so `hivenote history NAME --full` shows what an earlier version said before you restore it), and the whole note after a write. A script that reads any of those adds `--full`. A person typing in a terminal gets a readable view instead; `--json` forces JSON there too, and `NO_COLOR` turns off bold and dim text.

| Variable | What it does |
|---|---|
| `HIVENOTE_HOME` | One folder for both the settings and the database |
| `HIVENOTE_DB` | Use this database file for this command |
| `HIVENOTE_CLOUDFLARED` | The `cloudflared` program `serve public` runs, instead of the one on your PATH or the one HiveNote downloads |
| `HIVENOTE_HELPER` | `off` makes every command open its own connection to the queen; a number is how many idle seconds the connection helper stays (600 unless set). Wins over the `helper` line in `config.json` |
| `HIVENOTE_URL` + `HIVENOTE_TOKEN` | Use this queen for this command, without `connect`. The token saved by `connect` is only ever sent to the queen it was saved for |

Without them, the database lives at `~/.local/share/hivenote/data.db` on Linux, `~/Library/Application Support/hivenote` on macOS and `%LOCALAPPDATA%\hivenote` on Windows; settings live in `~/.config/hivenote`, the same macOS folder, and `%APPDATA%\hivenote`.

**Keep the database on a local disk.** Never put it in Dropbox, Syncthing or a network share. Several processes on one machine can use it at once; other machines go through the queen. While one process writes, others wait: a command waits up to 5 seconds, and the queen waits 0.2 seconds and answers "busy", which workers retry for up to 5 seconds on their own.

## Backups

```sh
hivenote backup ~/hivenote-2026-10-03.db
```

`backup` makes a consistent copy while the hive is in use, checks it, and refuses to overwrite an existing file. Backups contain the full history and the token hashes, so keep them private. To restore, stop the queen, put the backup in place of `data.db` (or point `HIVENOTE_DB` at it), and start it again.

A newer HiveNote opens a database made by an older one. An older HiveNote refuses to open a database made by a newer one and leaves the file untouched. HiveNote 1.0 uses the same file as 0.5, unchanged, so you can go back to 0.5 at any time. Take out a `takeover` line from `config.json` first: 0.5 refuses a config with settings it doesn't know.

## MCP

`hivenote mcp` runs HiveNote as a stdio MCP server, against this machine's hive or the queen this machine is connected to. Its tools are the HTTP methods below, and every tool that takes a note takes its name (`note`). `take` takes the next ready task; `list` takes `ready: true` and `folder`; `create` takes `after`; `update_task` takes `after` and `not_after`. Example for Claude Desktop:

```json
{ "mcpServers": { "hivenote": { "command": "hivenote", "args": ["mcp"] } } }
```

And for Codex:

```toml
[mcp_servers.hivenote]
command = "hivenote"
args = ["mcp"]
```

## HTTP

The queen answers `POST /v1/call` with a JSON body `{"method", "params"}` and an `Authorization: Bearer TOKEN` header, and `GET /health` with `{"ok", "version", "queen"}`. Methods: `list`, `read`, `search`, `create`, `edit`, `replace`, `append`, `delete`, `history`, `revision`, `restore`, `changes`, `update_task`, `take`. Notes are named with `note` (their name); each write takes an `op_id`, and resending the same `op_id` returns the first answer instead of applying the change twice. The hive keeps the answers to its latest 2,000 writes for this; an `op_id` sent again after that is refused with `op_id_conflict`, and the change is still not applied twice. Requests are limited to 1 MB.

What 1.0 added to the methods:

- `list` takes `ready: true` (todo tasks whose prerequisites are all done, oldest first, the order `take` goes by) and `folder` (names that start with it and a `/`). Each task entry has `waits_on`, the names of its prerequisites that are not done, when there are any.
- `read` answers with `waits_on`, an object from a task's name to those names, when any task read has some.
- `create` (for a task) takes `after`, a list of task names. `update_task` takes `after` to add to them and `not_after` to remove some. The tasks are stored by ID in the task's `metadata["hivenote:after"]`; the answer gives them by name as `after`. A write that sets other metadata keeps them, and so does `restore`: they change only through `after` and `not_after`, which refuse a loop. Adding a note under a deleted task's name does not make the tasks that waited on it wait on the new one.
- `take {op_id}` claims the next ready task, or else the `doing` task idle longest past the takeover time, and answers like `update_task`; `nothing_ready` (404) when there is none.
- A claim (`update_task` with `status: "doing"` and `claim: true`, or `take`) of a task idle past the takeover time answers with `taken_over: {from, at}`: who had it, and when anything last happened on it.
