#!/usr/bin/env python3
"""Beads across two machines (two clones syncing through one git remote, `bd sync`),
the documented multi-machine setup, vs HiveNote's single queen.

1. Cross-machine claims: for T tasks, machine A creates + syncs, machine B syncs.
   Then an agent on A and an agent on B both `bd update ID --claim` (each sees the
   task free locally), then both `bd sync`. Counted: tasks where BOTH claim commands
   succeeded (two agents start the same work), and the final assignee after sync.
2. Handoff: A closes a task and syncs; B runs `bd sync` every P seconds and starts
   when it sees the task closed. Measured: time from A's close until B knows.
Usage: python3 beads_sync.py [tasks=10] [handoffs=8] [poll_s=15]
"""
import json, os, random, shutil, statistics, subprocess, sys, threading, time

import tempfile
BD = os.environ.get('BD_BIN', 'bd')  # Beads binary; verify its checksum against the release first
HERE = tempfile.mkdtemp(prefix='beads-bench-')
BD_HOME = os.path.join(HERE, 'home'); os.makedirs(BD_HOME)  # isolated HOME so bd never touches your config
with open(os.path.join(BD_HOME, '.gitconfig'), 'w') as f: f.write('[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n')
T = int(sys.argv[1]) if len(sys.argv) > 1 else 10
H = int(sys.argv[2]) if len(sys.argv) > 2 else 8
POLL = float(sys.argv[3]) if len(sys.argv) > 3 else 15
ROOT = HERE + '/sync'

def sh(cwd, *a, check=True):
    return subprocess.run(list(a), cwd=cwd, env={**os.environ, 'HOME': BD_HOME}, capture_output=True, text=True, check=check)

def bd(m, *a, actor=None):
    env = {**os.environ, 'HOME': BD_HOME, 'BEADS_ACTOR': actor or m}
    t = time.perf_counter()
    r = subprocess.run([BD, *a], cwd=f'{ROOT}/{m}', env=env, capture_output=True, text=True)
    return r, time.perf_counter() - t

def st(xs):
    s = sorted(xs); q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {'n': len(s), 'mean': round(statistics.mean(s), 2), 'p50': round(q(.5), 2), 'p95': round(q(.95), 2), 'max': round(s[-1], 2)}

def show(m, tid):
    r, _ = bd(m, 'show', tid, '--json')
    j = json.loads(r.stdout); return j[0] if isinstance(j, list) else j

def fresh_pair():
    shutil.rmtree(ROOT, ignore_errors=True); os.makedirs(ROOT)
    sh(ROOT, 'git', 'init', '-q', '--bare', 'remote.git')
    sh(ROOT, 'git', 'clone', '-q', 'remote.git', 'seed', check=False)
    sh(f'{ROOT}/seed', 'git', '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '-q', '--allow-empty', '-m', 'seed')
    sh(f'{ROOT}/seed', 'git', 'push', '-q', 'origin', 'HEAD:main')
    sh(ROOT, 'git', 'clone', '-q', 'remote.git', 'A', check=False)
    r, _ = bd('A', 'init', '--skip-agents', '--quiet', '--prefix', 'shr'); assert r.returncode == 0, r.stderr
    bd('A', 'dolt', 'push')
    sh(ROOT, 'git', 'clone', '-q', 'remote.git', 'B', check=False)
    r, _ = bd('B', 'bootstrap'); assert r.returncode == 0, r.stderr

# 1. cross-machine claims, fresh pair per trial (a conflict wedges a replica until resolved by hand)
def claim_trial(mode, spread):
    fresh_pair()
    r, _ = bd('A', 'create', 'xm task', '-p', '1', '--json'); tid = json.loads(r.stdout)['id']
    bd('A', 'sync'); bd('B', 'sync')
    res = {}
    def agent(m):
        time.sleep(random.uniform(0, spread))
        if mode == 'careful': bd(m, 'sync')
        res[m] = bd(m, 'update', tid, '--claim', actor=f'agent-{m}')[0].returncode == 0
        if mode == 'careful' and res[m]: bd(m, 'sync')
    th = [threading.Thread(target=agent, args=(m,)) for m in 'AB']; [x.start() for x in th]; [x.join() for x in th]
    wedged = 0
    for m in ('A', 'B', 'A', 'B'):
        r, _ = bd(m, 'sync')
        if r.returncode != 0 and 'merge conflict' in (r.stderr + r.stdout): wedged = 1
    return res['A'] and res['B'], wedged

for mode, spread in (('simultaneous', 0.0), ('careful', 5.0), ('careful', 30.0)):
    both, wedged = 0, 0
    for t in range(T):
        b, w = claim_trial(mode, spread); both += b; wedged += w
        print(f'{mode} {spread}s trial {t}: both_claimed={b} sync_conflict={w}', file=sys.stderr)
    print(json.dumps({'bench': 'beads_cross_machine_claims', 'setup': 'two clones, git remote, bd sync', 'agent_mode': mode,
                      'start_spread_s': spread, 'tasks': T, 'tasks_both_claims_succeeded': both,
                      'tasks_ending_in_sync_conflict_needing_manual_fix': wedged}), flush=True)

# 2. handoff latency with B syncing every POLL seconds
fresh_pair()
hand = []
for h in range(H):
    r, _ = bd('A', 'create', f'handoff {h}', '-p', '1', '--json'); tid = json.loads(r.stdout)['id']
    bd('A', 'sync'); bd('B', 'sync')
    found = {}
    def watcher():
        time.sleep(random.uniform(0, POLL))
        while 'at' not in found:
            bd('B', 'sync')
            if show('B', tid)['status'] == 'closed': found['at'] = time.perf_counter(); return
            time.sleep(POLL)
    w = threading.Thread(target=watcher); w.start(); time.sleep(1)
    t0 = time.perf_counter(); bd('A', 'close', tid); bd('A', 'sync')
    w.join(); hand.append(found['at'] - t0)
    print(f'handoff {h}: {hand[-1]:.1f}s', file=sys.stderr)
print(json.dumps({'bench': 'beads_handoff', 'setup': f'B runs bd sync every {POLL:g}s (local git remote, no network)', 'trials': H,
                  'handoff_s': st(hand)}), flush=True)
