#!/usr/bin/env python3
"""Beads (bd 1.3.1, embedded Dolt, default mode) on one machine.

1. claim race: for R tasks, A agents run `bd update ID --claim` at the same moment,
   each with its own BEADS_ACTOR. Count winners, failures, latency.
2. CLI latency: create / show / update / ready per command (what an agent waits).
3. concurrent writers: A agents each add K comments to one issue at once; count
   lost writes and errors (embedded mode is documented as single-writer).
Usage: python3 beads_bench.py [rounds=20] [agents=5] [comments_each=10]
"""
import json, os, shutil, statistics, subprocess, sys, threading, time

import tempfile
BD = os.environ.get('BD_BIN', 'bd')  # Beads binary; verify its checksum against the release first
B = tempfile.mkdtemp(prefix='beads-bench-')
BD_HOME = os.path.join(B, 'home'); os.makedirs(BD_HOME)  # isolated HOME so bd never touches your config
with open(os.path.join(BD_HOME, '.gitconfig'), 'w') as f: f.write('[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n')
R = int(sys.argv[1]) if len(sys.argv) > 1 else 20
A = int(sys.argv[2]) if len(sys.argv) > 2 else 5
K = int(sys.argv[3]) if len(sys.argv) > 3 else 10
WS = B + '/ws-bench'

def st(xs):
    if not xs: return {'n': 0}
    s = sorted(xs); q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {'n': len(s), 'mean': round(statistics.mean(s)), 'p50': round(q(.5)), 'p95': round(q(.95)), 'max': round(s[-1])}

def bd(*args, actor='planner'):
    env = {**os.environ, 'HOME': BD_HOME, 'BEADS_ACTOR': actor}
    t = time.perf_counter()
    r = subprocess.run([BD, *args], cwd=WS, env=env, capture_output=True, text=True)
    return r, (time.perf_counter() - t) * 1000

shutil.rmtree(WS, ignore_errors=True); os.makedirs(WS)
subprocess.run(['git', 'init', '-q'], cwd=WS, env={**os.environ, 'HOME': BD_HOME}, check=True)
subprocess.run([BD, 'init', '--stealth', '--skip-agents', '--quiet'], cwd=WS, env={**os.environ, 'HOME': BD_HOME}, check=True, capture_output=True)

# 2. CLI latency
lat = {k: [] for k in ('create', 'show', 'update', 'ready')}
ids = []
for i in range(15):
    r, ms = bd('create', f'lat task {i}', '-p', '2', '--json'); lat['create'].append(ms); ids.append(json.loads(r.stdout)['id'])
    _, ms = bd('show', ids[-1], '--json'); lat['show'].append(ms)
    _, ms = bd('update', ids[-1], '--notes', f'progress {i}'); lat['update'].append(ms)
    _, ms = bd('ready', '--json'); lat['ready'].append(ms)
print(json.dumps({'bench': 'beads_cli_latency', 'mode': 'embedded', **{k + '_ms': st(v) for k, v in lat.items()}}), flush=True)

# 1. claim race
winners_per, errs, claim_ms, err_kinds = [], 0, [], {}
for r_ in range(R):
    r, _ = bd('create', f'race {r_}', '-p', '1', '--json'); tid = json.loads(r.stdout)['id']
    barrier = threading.Barrier(A); res = [None] * A
    def agent(i):
        barrier.wait()
        res[i] = bd('update', tid, '--claim', actor=f'agent{i}')
    ts = [threading.Thread(target=agent, args=(i,)) for i in range(A)]; [t.start() for t in ts]; [t.join() for t in ts]
    ok = [x for x in res if x[0].returncode == 0]
    for x in res:
        claim_ms.append(x[1])
        if x[0].returncode != 0:
            msg = (x[0].stderr or x[0].stdout).strip().splitlines()
            key = (msg[-1] if msg else 'rc%d' % x[0].returncode)[:90]
            err_kinds[key] = err_kinds.get(key, 0) + 1
    final, _ = bd('show', tid, '--json')
    fj = json.loads(final.stdout); fj = fj[0] if isinstance(fj, list) else fj
    winners_per.append(len(ok))
print(json.dumps({'bench': 'beads_claim_race', 'mode': 'embedded', 'rounds': R, 'agents': A,
                  'rounds_exactly_one_success': sum(1 for w in winners_per if w == 1),
                  'rounds_multiple_successes': sum(1 for w in winners_per if w > 1),
                  'rounds_zero_success': sum(1 for w in winners_per if w == 0),
                  'claim_ms': st(claim_ms), 'failure_messages': err_kinds}), flush=True)

# 3. concurrent writers on one issue
r, _ = bd('create', 'shared log', '-p', '2', '--json'); sid = json.loads(r.stdout)['id']
fails, wl = [0], []
lock = threading.Lock()
barrier = threading.Barrier(A)
def writer(i):
    barrier.wait()
    for k in range(K):
        r, ms = bd('comments', 'add', sid, f'agent{i} update{k}', actor=f'agent{i}')
        with lock:
            wl.append(ms)
            if r.returncode != 0: fails[0] += 1
t0 = time.perf_counter()
ts = [threading.Thread(target=writer, args=(i,)) for i in range(A)]; [t.start() for t in ts]; [t.join() for t in ts]
wall = time.perf_counter() - t0
r, _ = bd('comments', sid, '--json')
try:
    cs = json.loads(r.stdout); texts = [c.get('text') or c.get('body') or '' for c in cs]
except Exception:
    texts = [l for l in r.stdout.splitlines()]
want = {f'agent{i} update{k}' for i in range(A) for k in range(K)}
got = [t for t in texts if t in want]
print(json.dumps({'bench': 'beads_concurrent_writes', 'mode': 'embedded', 'agents': A, 'writes_each': K, 'wall_s': round(wall, 2),
                  'write_ms': st(wl), 'command_failures': fails[0], 'stored': len(set(got)), 'missing': len(want - set(got)),
                  'duplicated': len(got) - len(set(got))}), flush=True)
