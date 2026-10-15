# How HiveNote compares

Measured on 2026-10-15 with HiveNote 0.5.0 on one 4-vCPU / 7.6 GB Linux server (AMD EPYC), Node 26.5. Every number below came from a script in [`bench/compare/`](https://github.com/Yash456k/hivenote/tree/main/bench/compare), and the text says which. Rivals were run at the versions named below.

"Same machine" means the agents and the queen ran on one computer, so no network time is included. "Over the internet" means every request went out through a Cloudflare quick tunnel and back; the queen and agents still shared the computer, so this is a real round trip through Cloudflare, not two continents apart.

## Reproduce it

```sh
npm ci
bash bench/compare/run.sh quick   # about a minute, to check it works
bash bench/compare/run.sh         # the full HiveNote and MCP memory runs, about 10 minutes
```

`run.sh` builds this checkout, starts a throwaway queen on `127.0.0.1` with a fresh token in a temp folder, and deletes it afterwards. Your own hive is never touched. Results are written as JSON lines to `bench/compare/results/`. The GitHub and Beads comparisons need accounts or binaries, so they are run by hand; their commands are under each section.

## Against what people use today

### Shared notes in a GitHub repo

Agent A records that a step is done by committing to `NOTES.md` and pushing to a private GitHub repo. Agent B, waiting for that step, runs `git pull` every 15 seconds. With HiveNote, A runs `append` and B sits in `hivenote wait`.

| 12 handoffs | GitHub | HiveNote |
|---|---|---|
| A's write | p50 1.95 s (commit + push) | p50 10 ms |
| Until B knows | p50 **11.6 s**, p95 17.7 s | p50 **50 ms** same machine (`handoff.mjs`, 200 trials; the 12 trials in this script got 11 ms), **103 ms** over the internet (50 trials) |

The GitHub number depends on how often B pulls; pulling every 15 s puts the average near half of that plus the push and the pull. B also has to remember to pull.
`python3 bench/compare/rivals/github_handoff.py https://github.com/YOU/throwaway.git 12 15` (with `HN_URL`/`HN_TOKEN` set)

A stress version, ten agents pushing 20 updates each to one branch as fast as they can (`git_vs_hive.py 10 20`, local bare repo): Git took 19.6 s with 1,204 rejected pushes, HiveNote 0.62 s with none. This is a worst case for Git and not how agents normally work; a typical Git update in that run took 114 ms against HiveNote's 30 ms.

### GitHub Issues as a task board

Five agents look at the same issue, see it unclaimed, and post a "claimed by" comment. Ten issues. With HiveNote, the same five run `hivenote mark NAME doing`.

| Agents start | GitHub Issues: tasks claimed by more than one agent | HiveNote |
|---|---|---|
| at the same moment | **10 of 10** (50 claims for 10 tasks) | 0 of 10 |
| spread over 5 s | 3 of 10 | 0 of 10 |
| spread over 30 s | 1 of 10 | 0 of 10 |

A GitHub claim took 0.4 to 1.1 s over the internet; a HiveNote claim 2 to 10 ms on the same machine. GitHub's issue API has no check-and-set.
`python3 bench/compare/rivals/gh_issues_claim.py YOU/throwaway 10 5 [spread_s]`

### The official MCP memory server

[`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) 1.0.0, one server process per agent on one shared memory file (how several Claude Code or Cursor sessions share it). Ten agents add 20 observations each to one entity. HiveNote gets a fresh, empty queen for each size, holding the same number of notes as the memory file. Three runs each; the table gives the middle one.

| Already stored | MCP memory: all 200 writes / one write p50 / p95 | HiveNote: all 200 writes / one write p50 / p95 |
|---|---|---|
| nothing | 0.53 s / **3 ms** / 90 ms | 0.46 s / 18 ms / 42 ms |
| 1,000 entries | 1.45 s / 10 ms / 244 ms | **0.46 s** / 19 ms / 40 ms |
| 10,000 entries | 6.51 s / 63 ms / 1.30 s | **0.99 s** / 43 ms / 87 ms |

Neither lost or duplicated a write: the memory server locks its file. On an empty store the two finished in about the same time, and a typical single write was quicker on the memory server. It rewrites the whole file on every write, so the slow writes grow with memory: at 10,000 entries the 10 agents finished 6.5 times sooner with HiveNote. It is a knowledge graph on one machine, with no tasks, history or sharing between machines, so this compares only the part both do.
Part of `run.sh`; on its own: `MCP_MEMORY_DIR=… node bench/compare/rivals/mcp_memory_vs_hive.mjs 10 20 10000`

### Beads

[Beads](https://github.com/gastownhall/beads) 1.3.1, the issue tracker for coding agents, in its default embedded mode, binary checked against the release checksums.

On one machine both claim safely: Beads had one winner in each of 50 rounds of 10 agents, HiveNote in each of 1,000 rounds of 100 (`race.mjs`).

| One machine | Beads | HiveNote |
|---|---|---|
| Claim, 10 agents at once | p50 1.7 s | p50 2 to 30 ms |
| 10 agents × 20 writes to one item | **76 s**, p95 12 s; 0 lost | under 1 s; 0 lost |

The Beads figures start a `bd` process for every command. The HiveNote claim and write figures are API calls (from `race.mjs` and the GitHub Issues test); running them as `hivenote` commands adds about 65 ms each, as the last row shows.
| One command (create / show / update / ready vs add / read / append / tasks) | p50 467 / 339 / 330 / 248 ms | p50 63 / 62 / 66 / 63 ms (`cli_local.py`) |

Across machines, Beads keeps a copy on each and syncs them through a git remote with `bd sync`. Two machines, ten tasks, an agent on each claiming the same task:

| Agents start | Both told they own it | `bd sync` then stops on a merge conflict until fixed by hand |
|---|---|---|
| at the same moment | **10 of 10** | 9 of 10 |
| sync first, within 5 s of each other | 4 of 10 | 2 of 10 |
| sync first, within 30 s | 1 of 10 | 0 of 10 |

A handoff between the two machines, with B running `bd sync` every 15 s against a remote on the same disk, took p50 **7.5 s**. With HiveNote's single queen a double claim can't happen, and a handoff took about 0.1 s over the internet.

Beads does more than HiveNote with tasks: dependencies, `bd ready` for unblocked work, and epics with sub-tasks. Its data lives in the project's git remote, and each machine works offline and merges later, with no server to run. Its server mode for many writers on one host was not tested.
`BD_BIN=/path/to/bd python3 bench/compare/rivals/beads_bench.py 50 10 20` and `… beads_sync.py 10 10 15`

## Reliability

| Test | Result |
|---|---|
| The queen is killed with `kill -9` 50 times while 20 agents write | 17,887 writes acknowledged: **0 lost, 0 duplicated**; SQLite's integrity check passed on the database afterwards (`crash.mjs 50 20`) |
| 1,197 of 5,000 writes (24%) are cut off mid-request and sent again | 0 lost, 0 duplicated. A client that resends without HiveNote's operation id duplicated 1,287 (`retry.mjs 5000 0.3 50 [naive]`). Over the internet: 317 of 1,000 cut off, 0 lost, 0 duplicated |
| 100 agents claim one task at the same moment, 1,000 times | exactly one winner every time, 100,000 claims in all, p99 58 ms (`race.mjs 1000 100`). Over the internet, 50 rounds of 20: the same |

## What an agent reads to find what it needs

The agent needs the full text of 3 notes on its topic. With one shared notes file it reads the whole file; with HiveNote it reads `list` (names and descriptions) or `search`, then `read`s the 3. Notes are made up, sized like a real hive (median 1.8 KB). Tokens are estimated as bytes ÷ 4.

| Notes | One shared file | `list` + `read` | `search` + `read` |
|---|---|---|---|
| 50 | about 29,000 | about 3,800 | about 1,300 |
| 200 | about 115,000 | about 14,400 | about 3,300 |
| 1,000 | about 600,000 | about 60,000 | about 2,000 |

`list` + `read` is 7.6 to 10 times less than reading the file. An agent that greps the shared file would read far less than all of it; that case was not measured. Search found the 3 notes every time, but the made-up notes use a distinct word per topic, which makes search easier than real notes would. (`token_cost.py 50,200,1000`)

## Speed

| | Same machine | Over the internet |
|---|---|---|
| Writes | about 340 a second, the same from 10 to 200 agents; 0 errors | about 140 a second from 10 agents, p50 70 ms |
| Reads | about 2,800 a second, p50 3 ms from 10 agents | about 220 a second from 10 agents, p50 43 ms |
| One `hivenote` command, as an agent runs it | p50 62 to 66 ms (no queen, `cli_local.py`) | p50 225 ms, or 132 to 140 ms with the connection helper |

Writes go through SQLite's single writer, so adding agents adds waiting, not throughput. Agents writing every few seconds are far below that.

## What these numbers don't show

- That agents do better work with HiveNote. None of these tests measure the quality of what agents build.
- How it behaves with the queen and agents on different continents. The internet numbers still started and ended on one computer.
- Power cuts or a machine crashing: only the server process was killed.
- A worker that loses its connection can't write until the queen is back. A hive on one machine with no queen needs no network at all.
- HiveNote 0.4's 5-second polling handoff (about 2.5 s on average) is worked out from its interval, not measured.

The JavaScript clients in these scripts use `node:http`: Node 26's built-in `fetch` added 0.4 to 2 s pauses after idle gaps, which would have measured the client, not HiveNote.
