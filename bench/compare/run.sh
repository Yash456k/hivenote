#!/usr/bin/env bash
# Reproduce the numbers in docs/BENCHMARKS.md on your own machine.
#
#   bash bench/compare/run.sh            # HiveNote tests + MCP memory comparison (~10 min)
#   bash bench/compare/run.sh quick      # small sizes, ~1 min, to check it works
#
# It builds this checkout, starts a throwaway queen on 127.0.0.1 with a fresh token in a
# temp folder, and uses this checkout's `hivenote` for every command. Your own hive and
# settings are never touched. Results go to bench/compare/results/<timestamp>.jsonl.
#
# Comparisons that need more setup are run by hand (see docs/BENCHMARKS.md):
#   rivals/github_handoff.py, rivals/gh_issues_claim.py   need a throwaway GitHub repo + gh login
#   rivals/beads_bench.py, rivals/beads_sync.py           need the Beads binary (BD_BIN)
#   cli_latency.py over the internet                      needs a tunnel to the queen
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MODE="${1:-full}"
PORT="${HN_BENCH_PORT:-7499}"

(cd "$REPO" && npm run build >/dev/null)
WORK="$(mktemp -d -t hivenote-bench-XXXXXX)"
mkdir -p "$WORK/bin" "$WORK/queen"
printf '#!/usr/bin/env bash\nexec node "%s/dist/cli.js" "$@"\n' "$REPO" > "$WORK/bin/hivenote"
chmod +x "$WORK/bin/hivenote"
export PATH="$WORK/bin:$PATH"
unset HIVENOTE_URL HIVENOTE_TOKEN HIVENOTE_DB

QUEEN=""
cleanup() { [ -n "$QUEEN" ] && kill "$QUEEN" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
# Start a fresh, empty queen in its own folder and point HN_URL/HN_TOKEN at it.
start_queen() {
  [ -n "$QUEEN" ] && { kill "$QUEEN" 2>/dev/null || true; wait "$QUEEN" 2>/dev/null || true; }
  local qhome; qhome="$(mktemp -d "$WORK/queen-XXXXXX")"
  HN_TOKEN="$(HIVENOTE_HOME="$qhome" hivenote token add bench --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')"
  HIVENOTE_HOME="$qhome" hivenote serve "127.0.0.1:$PORT" >"$qhome.log" 2>&1 &
  QUEEN=$!
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done
  kill -0 "$QUEEN" 2>/dev/null || { echo "queen did not start on port $PORT (in use? set HN_BENCH_PORT)" >&2; exit 1; }
  export HN_URL="http://127.0.0.1:$PORT" HN_TOKEN
}
start_queen
mkdir -p "$HERE/results"
OUT="$HERE/results/$(date +%Y%m%d-%H%M%S).jsonl"
host() { node -e 'const os=require("os");console.log(JSON.stringify({bench:"host",cpus:os.cpus().length,cpu:os.cpus()[0].model,mem_gb:Math.round(os.totalmem()/2**30),node:process.version,platform:process.platform}))'; }
host | tee -a "$OUT"
cd "$HERE"

if [ "$MODE" = quick ]; then
  node race.mjs 20 20 2>/dev/null | tee -a "$OUT"
  node handoff.mjs 20 | tee -a "$OUT"
  node throughput.mjs write 10 5 | tee -a "$OUT"
  node throughput.mjs read 10 5 | tee -a "$OUT"
  node retry.mjs 500 0.3 20 | tee -a "$OUT"
  node crash.mjs 3 5 2>/dev/null | tee -a "$OUT"
  python3 token_cost.py 50 | tee -a "$OUT"
  python3 cli_local.py 5 | tee -a "$OUT"
else
  node race.mjs 1000 100 2>/dev/null | tee -a "$OUT"
  node handoff.mjs 200 | tee -a "$OUT"
  for c in 10 50 200; do node throughput.mjs write "$c" 20 | tee -a "$OUT"; done
  for c in 10 50 200; do node throughput.mjs read "$c" 20 | tee -a "$OUT"; done
  node throughput.mjs mixed 100 20 | tee -a "$OUT"
  node retry.mjs 5000 0.3 50 | tee -a "$OUT"
  node retry.mjs 5000 0.3 50 naive | tee -a "$OUT"
  node crash.mjs 50 20 2>/dev/null | tee -a "$OUT"
  python3 token_cost.py 50,200,1000 | tee -a "$OUT"
  python3 git_vs_hive.py 10 20 | tee -a "$OUT"
  python3 cli_local.py 15 | tee -a "$OUT"
  if [ "${SKIP_MCP_MEMORY:-}" != 1 ]; then
    export MCP_MEMORY_DIR="$WORK/mcp-memory"
    npm install --silent --prefix "$MCP_MEMORY_DIR" @modelcontextprotocol/server-memory@1.0.0 >/dev/null
    # A fresh, empty queen for each size, so HiveNote holds exactly what the memory file holds.
    for s in 0 1000 10000; do start_queen; node rivals/mcp_memory_vs_hive.mjs 10 20 "$s" | tee -a "$OUT"; done
  fi
fi
echo "results: $OUT"
