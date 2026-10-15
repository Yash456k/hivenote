# How HiveNote compares

Measured on 2026-10-15 with HiveNote 0.5.0 on one 4-vCPU / 8 GB Linux server (AMD EPYC), Node 26.5. Every number below came from a script in [`bench/compare/`](../bench/compare/), and the table says which. Rivals were run as their docs describe, at their current releases.

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
| Until B knows | p50 **11.6 s**, p95 17.7 s | p50 **50 ms** same machine, **103 ms** over the internet |

The GitHub number depends on how often B pulls; pulling every 15 s puts the average near half of that plus the push. B also has to remember to pull.
`python3 bench/compare/rivals/github_handoff.py https://github.com/YOU/throwaway.git 12 15` (with `HN_URL`/`HN_TOKEN` set)

A stress version, ten agents pushing 20 updates each to one branch as fast as they can (`git_vs_hive.py 10 20`, local bare repo): Git took 19.6 s with 1,204 rejected pushes, HiveNote 0.62 s with none. This is a worst case for Git and not how agents normally work; a typical Git update in that run took 114 ms against HiveNote's 30 ms.

### GitHub Issues as a task board

Five agents look at the same issue, see it unclaimed, and post a "claimed by" comment. Ten issues. With HiveNote, the same five run `hivenote mark NAME doing`.

| Agents start | GitHub Issues: tasks claimed by more than one agent | HiveNote |
|---|---|---|
| at the same moment | **10 of 10** (50 claims for 10 tasks) | 0 of 10 |
| spread over 5 s | 3 of 10 | 0 of 10 |
| spread over 30 s | 1 of 10 | 0 of 10 |

A GitHub claim took 0.4 to 1.1 s; a HiveNote claim 2 to 10 ms. GitHub has no check-and-set for an issue, so this can't be fixed on the agents' side without a lock somewhere else.
`python3 bench/compare/rivals/gh_issues_claim.py YOU/throwaway 10 5 [spread_s]`

### The official MCP memory server

[`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory) 1.0.0, one server process per agent on one shared memory file (how several Claude Code or Cursor sessions share it). Ten agents add 20 observations each to one entity.

| Already stored | MCP memory | HiveNote |
|---|---|---|
| nothing | **0.56 s**, p95 134 ms | 0.85 s, p95 67 ms |
| 1,000 entries | 1.31 s, p95 252 ms | 0.66 s, p95 61 ms |
| 10,000 entries | 6.44 s, p95 1.17 s | **1.46 s, p95 132 ms** |

Neither lost or duplicated a write: the memory server locks its file. It rewrites the whole file on every write, so it slows down as memory grows; on an empty store it was faster than HiveNote. It is a knowledge graph on one machine, with no tasks, history or sharing between machines, so this compares only the part both do.
Part of `run.sh`; on its own: `MCP_MEMORY_DIR=… node bench/compare/rivals/mcp_memory_vs_hive.mjs 10 20 10000`

### Beads

[Beads](https://github.com/gastownhall/beads) 1.3.1, the issue tracker for coding agents, in its default embedded mode, binary checked against the release checksums.

On one machine both claim safely: in 50 rounds of 10 agents taking one task, each tool had exactly one winner every time.

| One machine | Beads | HiveNote |
|---|---|---|
| Claim, 10 agents at once | p50 1.7 s | p50 2 to 30 ms |
| 10 agents × 20 writes to one item | **76 s**, p95 12 s; 0 lost | under 1 s; 0 lost |
| One command (create / show / update / ready vs add / read / append / tasks) | p50 467 / 339 / 330 / 248 ms | p50 80 / 70 / 75 / 63 ms |

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
| 30% of 5,000 writes are cut off mid-request and sent again | 0 lost, 0 duplicated. A client that resends without HiveNote's operation id duplicated 1,287 (`retry.mjs 5000 0.3 50 [naive]`). Over the internet: 317 cut off, 0 lost, 0 duplicated |
| 100 agents claim one task at the same moment, 1,000 times | exactly one winner every time, 100,000 claims in all, p99 58 ms (`race.mjs 1000 100`). Over the internet, 50 rounds of 20: the same |

## What an agent reads to find what it needs

The agent needs the full text of 3 notes on its topic. With one shared notes file it reads the whole file; with HiveNote it reads `list` (names and descriptions) or `search`, then `read`s the 3. Notes are made up, sized like a real hive (median 1.8 KB). Tokens are estimated as bytes ÷ 4.

| Notes | One shared file | `list` + `read` | `search` + `read` |
|---|---|---|---|
| 50 | about 29,000 | about 3,800 | about 1,300 |
| 200 | about 115,000 | about 14,400 | about 3,300 |
| 1,000 | about 600,000 | about 60,000 | about 2,000 |

`list` + `read` is 8 to 10 times less than reading the file. Search found the 3 notes every time, but the made-up notes use a distinct word per topic, which makes search easier than real notes would. (`token_cost.py 50,200,1000`)

## Speed

| | Same machine | Over the internet |
|---|---|---|
| Writes | about 340 a second, the same from 10 to 200 agents; 0 errors | about 140 a second from 10 agents, p50 70 ms |
| Reads | about 2,800 a second, p50 3 ms from 10 agents | about 220 a second from 10 agents, p50 43 ms |
| One `hivenote` command, as an agent runs it | p50 63 to 80 ms (no queen) | p50 225 ms, or 132 to 140 ms with the connection helper |

Writes go through SQLite's single writer, so adding agents adds waiting, not throughput. Agents writing every few seconds are far below that.

## What these numbers don't show

- That agents do better work with HiveNote. In a test with five agents building an app, teams using HiveNote, Git only, and a single agent all passed every check; the task was too easy to tell them apart.
- How it behaves with the queen and agents on different continents. The internet numbers still started and ended on one computer.
- A worker that loses its connection can't write until the queen is back. A hive on one machine with no queen needs no network at all.
- HiveNote 0.4's 5-second polling handoff (about 2.5 s on average) is worked out from its interval, not measured.

The JavaScript clients in these scripts use `node:http`: Node 26's built-in `fetch` added 0.4 to 2 s pauses after idle gaps, which would have measured the client, not HiveNote.
