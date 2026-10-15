#!/usr/bin/env python3
"""GitHub Issues as an agent task board vs HiveNote: concurrent claims.

Pattern agents use on GitHub: look at the issue; if nobody has claimed it, post a
"claimed by <agent>" comment (or self-assign) and start work. GitHub has no
compare-and-set, so several agents that look at the same moment can all claim.
For each of I issues, A agents try to claim at once. Counted: issues with more
than one claimant, API calls used, claim latency. HiveNote: same I tasks x A agents
with `mark doing` (claim: true).

Usage: python3 gh_issues_claim.py OWNER/REPO [issues=10] [agents=5]
"""
import json, subprocess, sys, threading, time, uuid, statistics
from urllib import request
import os

REPO, I, A = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 10, int(sys.argv[3]) if len(sys.argv) > 3 else 5
JITTER = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0  # agents start spread uniformly over this many seconds
import random
calls = [0]; lock = threading.Lock()

def gh(*args):
    with lock: calls[0] += 1
    r = subprocess.run(['gh', 'api', *args], capture_output=True, text=True)
    return json.loads(r.stdout) if r.stdout.strip() else None

def st(xs):
    s = sorted(xs); q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {'n': len(s), 'mean': round(statistics.mean(s), 3), 'p50': round(q(.5), 3), 'p95': round(q(.95), 3), 'max': round(s[-1], 3)}

nums = [gh(f'repos/{REPO}/issues', '-f', f'title=bench task {k}', '-f', 'body=claim test')['number'] for k in range(I)]
gh_lat, multi, total_claims = [], 0, 0
for n in nums:
    claimed, barrier = [], threading.Barrier(A)
    def agent(i):
        barrier.wait()
        time.sleep(random.uniform(0, JITTER))
        t = time.perf_counter()
        comments = gh(f'repos/{REPO}/issues/{n}/comments') or []
        if not any(c['body'].startswith('claimed by') for c in comments):
            gh(f'repos/{REPO}/issues/{n}/comments', '-f', f'body=claimed by agent{i}')
            with lock: claimed.append(i)
        with lock: gh_lat.append(time.perf_counter() - t)
    ts = [threading.Thread(target=agent, args=(i,)) for i in range(A)]; [t.start() for t in ts]; [t.join() for t in ts]
    time.sleep(2)
    final = [c for c in (gh(f'repos/{REPO}/issues/{n}/comments') or []) if c['body'].startswith('claimed by')]
    total_claims += len(final); multi += len(final) > 1
    print(f'issue {n}: {len(final)} claimants', file=sys.stderr)
    gh(f'repos/{REPO}/issues/{n}', '-X', 'PATCH', '-f', 'state=closed')
print(json.dumps({'bench': 'issues_claim', 'arm': 'github issues (check, then claim comment)', 'start_spread_s': JITTER, 'issues': I, 'agents_per_issue': A,
                  'issues_with_multiple_claimants': multi, 'claims_total': total_claims, 'api_calls': calls[0], 'claim_s': st(gh_lat)}), flush=True)

URL = os.environ.get('HN_URL', 'http://127.0.0.1:7499')
TOKEN = os.environ['HN_TOKEN']
def hc(m, p, agent):
    r = request.Request(URL + '/v1/call', data=json.dumps({'method': m, 'params': p, 'agent': agent}).encode(),
                        headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'})
    try:
        with request.urlopen(r, timeout=30) as x: return json.loads(x.read())
    except Exception as e: return json.loads(e.read())
h_lat, hmulti, hwins = [], 0, 0
for k in range(I):
    name = f'ic-{uuid.uuid4().hex[:8]}'
    hc('create', {'id': str(uuid.uuid4()), 'name': name, 'description': 't', 'content': 'x', 'kind': 'task', 'op_id': str(uuid.uuid4())}, 'planner')
    wins, barrier = [], threading.Barrier(A)
    def agent(i):
        barrier.wait(); time.sleep(random.uniform(0, JITTER)); t = time.perf_counter()
        r = hc('update_task', {'note': name, 'status': 'doing', 'claim': True, 'op_id': str(uuid.uuid4())}, f'agent{i}')
        with lock:
            h_lat.append(time.perf_counter() - t)
            if 'result' in r: wins.append(i)
    ts = [threading.Thread(target=agent, args=(i,)) for i in range(A)]; [t.start() for t in ts]; [t.join() for t in ts]
    hwins += len(wins); hmulti += len(wins) > 1
print(json.dumps({'bench': 'issues_claim', 'arm': 'hivenote (mark doing, claim)', 'start_spread_s': JITTER, 'issues': I, 'agents_per_issue': A,
                  'issues_with_multiple_claimants': hmulti, 'claims_total': hwins, 'api_calls': I * A, 'claim_s': st(h_lat)}), flush=True)
