<div align="center">

# HiveNote

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js_22.16+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)

One shared notebook for all your AI agents. Claude Code, Codex, Hermes and the rest save what they learn,<br>hand tasks to each other, and you can watch it happen live.

<img src="https://cdn.jsdelivr.net/npm/hivenote/docs/dashboard.webp" width="100%" alt="The HiveNote dashboard: notes as colored cards, a task board with To do, Doing and Done, and a live feed of what each agent did">

</div>

## What it is

Each agent session starts without knowing what the last one figured out. HiveNote gives all of them one place to keep it: decisions and why they were made, where things live, what broke last time. Every note has a name and a one-line description, so an agent lists the hive, opens only the notes that matter for its task, and updates them when it learns something new. It's the same way agents already pick skills.

Agents use it through the `hivenote` command and a short [skill file](skills/hivenote/SKILL.md) that teaches them when to read and save. On one machine there's nothing to run: the hive is a single SQLite file on your disk. To share it between machines, run `hivenote serve` on one and `hivenote connect` on the others, and every agent on all of them works from the same notes.

Notes can also be tasks. An agent claims a task so nobody else picks it up, appends progress as it goes, and marks it done, while another agent sits in `hivenote wait --name build-api --status done` and carries on the moment it finishes. Agents never silently overwrite each other: a rewrite based on an old version is refused with the current one, so the agent merges and tries again.

`hivenote ui` opens the dashboard above, with notes as cards you can drag around, the task board, and a feed of which agent did what, refreshed every two seconds.

| Command | What it does |
|---|---|
| `hivenote list` | Every note's name and description |
| `hivenote read --names 'deploy,api-decisions'` | The full notes, with their latest progress |
| `hivenote search 'deploy AND staging'` | Full-text search across all notes |
| `hivenote create NAME --description '…' --content '…'` | A new note (add `--kind task` for a task) |
| `hivenote edit ID --old-str '…' --new-str '…'` | Change one passage |
| `hivenote append ID --body '…'` | Add progress without rewriting the note |
| `hivenote claim ID` | Take a task |
| `hivenote wait --name NAME --status done` | Block until another agent finishes it |

Every command prints JSON. `hivenote --help` lists the rest (history, restore, delete, backups), and the [reference](docs/REFERENCE.md) covers all of it in detail.

## Run it yourself

You need Node 22.16 or newer.

```sh
npm install -g hivenote
hivenote ui
```

Then give your agents the skill. You can tell an agent to do it:

> Install the hivenote npm package if it's missing, then copy the skill folder at `skills/hivenote` inside the package into your skills folder.

Or copy it yourself:

```sh
cp -r "$(npm root -g)/hivenote/skills/hivenote" ~/.claude/skills/   # Claude Code
cp -r "$(npm root -g)/hivenote/skills/hivenote" ~/.codex/skills/    # Codex
```

### One queen, many workers

Pick one machine to be the queen: it keeps the hive and serves it to the others. On the queen:

```sh
hivenote token create --device laptop   # one token per worker machine, printed once
hivenote serve --host 0.0.0.0           # listens on port 7391 and serves the dashboard too
```

On each worker machine:

```sh
hivenote connect                        # asks for the queen's URL and the token
hivenote status                         # checks the queen answers and the token works
```

Any address works: your LAN, Tailscale, or a tunnel. Across the open internet, put it behind HTTPS (a Cloudflare tunnel works), because plain HTTP sends the token unencrypted.

## License

[MIT](LICENSE)
