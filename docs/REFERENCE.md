# HiveNote reference

Everything the [README](../README.md) leaves out. `hivenote help` lists the commands too.

## Notes

```sh
hivenote list                                   # every note: name and one-line description
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

The description and text a command needs are saved exactly as written, even when they look like an option, so a note can say `--help`. Any text argument can be `-`, which reads the text from stdin: a file piped in, or a heredoc. Use that for the one case words can't express: an optional text (the third word of `add` or `task`) that is exactly `--json` or `--agent`. Text that is valid UTF-8 is stored exactly as given. A file saved in an older Windows encoding is read as Windows-1252, so letters like é survive.

**Changes and undo.** Every version of a note is kept in its history with who made it and when, including deletes: `restore` brings back any earlier version, and it finds a deleted note by its name. Progress lines are kept too, but they are not versions, so `restore` leaves them as they are. There is no version checking; the latest write wins. `edit` works on the current text and needs its old text to appear exactly once, so an edit based on outdated text is refused instead of landing in the wrong place. `append` adds a progress line without changing the note's text.

**Search.** It covers each note's name, description, text and latest 100 progress lines. Plain words find notes containing all of them, so names like `api-decisions` and hosts like `stg.example.com` work as typed. Quotes, parentheses, `*` or `AND`/`OR`/`NOT` switch to SQLite full-text syntax, such as `"exact phrase"` or `deploy*`.

**Size.** One answer is at most 5 MB. `read` names any note that didn't fit in `too_big` (read it on its own), and says when older progress was left out.

Shell habits are understood: `ls` is `list`, `cat` is `read`, `grep` and `find` are `search`, `rm` is `delete` and `log` is `history`.

## Tasks

```sh
hivenote task build-api "POST /bookings with conflict checks"
hivenote tasks                                  # the board
hivenote mark build-api doing                   # todo, doing, done or cancelled
hivenote wait build-api done                    # until it's done
hivenote wait build-api                         # until it changes at all, including progress
hivenote wait                                   # until anything in the hive changes
hivenote wait build-api done 30m                # hold on for 30 minutes (90s, 2h and forever work too)
```

A task is a note with a status. The board shows each task's status, who changed it last and how long ago, such as `[doing · codex · 2h ago]`. That is the whole coordination model: nothing is locked, and nothing expires. A task that has said `doing` for hours may belong to an agent that stopped; whoever sees it decides what to do.

`wait` checks every 5 seconds for up to 9 minutes, then exits with an error, which keeps it under the 10-minute limit agents such as Claude Code put on one command. A script or service with no such limit can end the command with its own: `90s`, `30m`, `2h`, or `forever` to never give up. Waiting for a status checks how things stand first, so a loop that waits again after a timeout misses nothing; the limit word is always the last one, so a note that is itself named `forever` is waited for as `hivenote wait forever forever`. If the note doesn't exist yet, it says so and holds on until someone adds it. With no name, it returns as soon as anything in the hive changes and lists each change: the note, what happened, and who did it. It follows the note it found first, so a different task created later under the same name never counts. If the queen restarts or the network drops while waiting, it keeps checking until its time is up. It only reads, so `hivenote wait build-api done && your-command` is how a script carries on afterwards.

## Labels

Every change records who made it. When HiveNote runs inside Claude Code, Codex or Hermes, it labels changes `claude-code`, `codex` or `hermes` on its own, from their environment variables. When several agents share one machine, give each a role with `--agent builder-1`. Labels are self-reported, for telling agents apart, not for security.

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
hivenote status                                 # which hive, and whether it answers
hivenote disconnect                             # back to this machine's own hive
```

`connect` checks the URL and token before saving them, keeps the token in a private file (mode 600) in HiveNote's settings folder, and from then on every note and task command on that machine, including agents', uses the queen. `ui`, `serve`, `token` and `backup` only run on the machine that holds the hive; from a worker, open the queen's dashboard at her address instead. A machine that is already connected is offered the token it has: `hivenote connect NEW-ADDRESS` asks `Use the token saved for OLD-ADDRESS? [Y/n]`, and Enter means yes. A hive keeps its tokens when its address changes, so nothing has to be pasted again; if the queen at the new address turns the token down, `connect` asks for one as usual. The question is only asked in a terminal, since it sends the saved token to the address you gave; a piped token is used as given. If the queen can't be reached, commands fail; they never quietly fall back to a local hive. `status` says which of these is wrong: the queen is down, the address isn't a queen, or the token was rejected.

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

**Moving the queen.** To make another machine the queen:

1. On the old queen, run `hivenote backup hive.db`, then stop `hivenote serve`. The old queen has to stop first; two machines serving copies of one hive drift apart.
2. Copy `hive.db` to the new machine and put it in place as that machine's database (the path is under [Scripts and environment](#scripts-and-environment)). If the new machine was a worker, run `hivenote disconnect` there first.
3. On the new machine, run `hivenote serve` or `hivenote serve public`.
4. On every worker, run `hivenote connect NEW-ADDRESS` and press Enter to keep the token it has. The copy carries the tokens, so they still work.

The old queen can join as a worker too: `hivenote token add LABEL` on the new queen, then `hivenote connect NEW-ADDRESS` on the old one.

**Versions.** The queen and its workers should run the same version. Every answer carries the queen's version, and a worker prints one warning when the two differ in their first two numbers. Update the queen first.

## Dashboard

`hivenote ui` opens a live view of this machine's hive: notes as cards you can drag around (the order is saved in your browser only), the task board, and a feed of what each agent did, refreshed every two seconds. It opens the page with a key made for that launch, carried in the link's `#` part, which browsers never send to any server; only a page holding that key can read, and nothing can write from the page. Starting `ui` again makes a new key. If port 7391 is taken, it uses the next free one.

The queen's `serve` also serves the dashboard at `/`. There, each browser pastes a token once (a read-only one is enough) and remembers it. A request with neither a token nor the `ui` key is refused, wherever it comes from.

## Scripts and environment

Agents and scripts always get JSON: results on stdout, and errors on stderr as `{"error":{"code","message","status"}}` with a nonzero exit. A person typing in a terminal gets a readable view instead; `--json` forces JSON there too, and `NO_COLOR` turns off bold and dim text.

| Variable | What it does |
|---|---|
| `HIVENOTE_HOME` | One folder for both the settings and the database |
| `HIVENOTE_DB` | Use this database file for this command |
| `HIVENOTE_CLOUDFLARED` | The `cloudflared` program `serve public` runs, instead of the one on your PATH or the one HiveNote downloads |
| `HIVENOTE_URL` + `HIVENOTE_TOKEN` | Use this queen for this command, without `connect`. The token saved by `connect` is only ever sent to the queen it was saved for |

Without them, the database lives at `~/.local/share/hivenote/data.db` on Linux, `~/Library/Application Support/hivenote` on macOS and `%LOCALAPPDATA%\hivenote` on Windows; settings live in `~/.config/hivenote`, the same macOS folder, and `%APPDATA%\hivenote`.

**Keep the database on a local disk.** Never put it in Dropbox, Syncthing or a network share. Several processes on one machine can use it at once; other machines go through the queen. While one process writes, others wait: a command waits up to 5 seconds, and the queen waits 0.2 seconds and answers "busy", which workers retry for up to 5 seconds on their own.

## Backups

```sh
hivenote backup ~/hivenote-2026-10-03.db
```

`backup` makes a consistent copy while the hive is in use, checks it, and refuses to overwrite an existing file. Backups contain the full history and the token hashes, so keep them private. To restore, stop the queen, put the backup in place of `data.db` (or point `HIVENOTE_DB` at it), and start it again.

A newer HiveNote opens a database made by an older one. An older HiveNote refuses to open a database made by a newer one and leaves the file untouched.

## MCP

`hivenote mcp` runs HiveNote as a stdio MCP server, against this machine's hive or the queen this machine is connected to. Its tools mirror the commands, and every tool that takes a note takes its name (`note`). Example for Claude Desktop:

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

The queen answers `POST /v1/call` with a JSON body `{"method", "params"}` and an `Authorization: Bearer TOKEN` header, and `GET /health` with `{"ok", "version", "queen"}`. Methods: `list`, `read`, `search`, `create`, `edit`, `replace`, `append`, `delete`, `history`, `revision`, `restore`, `changes`, `update_task`. Notes are named with `note` (their name); each write takes an `op_id`, and resending the same `op_id` returns the first answer instead of applying the change twice. Requests are limited to 1 MB.
