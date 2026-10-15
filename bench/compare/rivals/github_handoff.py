#!/usr/bin/env python3
"""Realistic handoff over GitHub vs HiveNote.

Agent A finishes a step and records it; agent B is waiting to start the next step.
GitHub arm: A commits a line to NOTES.md and pushes to a real private GitHub repo;
B runs `git pull` every P seconds (an agent checking the shared notes) and starts
as soon as the line appears. Measured: A's push time, and time from A starting its
write until B sees it. HiveNote arm: A appends; B sits in a held `changes` request
(what `hivenote wait` does). Same measurement.

Usage: python3 github_handoff.py REPO_URL [trials=10] [poll_s=15]
"""
import json, os, subprocess, sys, tempfile, threading, time, uuid, statistics
from urllib import request

REPO, TRIALS, POLL = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 10, float(sys.argv[3]) if len(sys.argv) > 3 else 15

def git(cwd, *a, check=True):
    return subprocess.run(['git', *a], cwd=cwd, capture_output=True, text=True, check=check)

def st(xs):
    s = sorted(xs); q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {'n': len(s), 'mean': round(statistics.mean(s), 3), 'p50': round(q(.5), 3), 'p95': round(q(.95), 3), 'max': round(s[-1], 3)}

root = tempfile.mkdtemp(prefix='ghh-', dir=os.environ.get('TMPDIR'))
A, B = os.path.join(root, 'a'), os.path.join(root, 'b')
for d, n in ((A, 'agent-a'), (B, 'agent-b')):
    git(root, 'clone', '-q', REPO, d); git(d, 'config', 'user.name', n); git(d, 'config', 'user.email', f'{n}@bench')

push_s, seen_s, pulls = [], [], []
for t in range(TRIALS):
    line = f'- step {t} done {uuid.uuid4().hex[:6]}'
    # B starts polling at a random phase, like an agent that is mid-way through its own loop.
    found = {}
    def watcher():
        time.sleep(POLL * (hash(line) % 1000) / 1000)
        n = 0
        while 'at' not in found:
            git(B, 'pull', '-q', '--rebase', check=False); n += 1
            if line in open(os.path.join(B, 'NOTES.md')).read():
                found['at'] = time.perf_counter(); found['pulls'] = n; return
            time.sleep(POLL)
    w = threading.Thread(target=watcher); w.start()
    time.sleep(1)
    t0 = time.perf_counter()
    git(A, 'pull', '-q', '--rebase', check=False)
    with open(os.path.join(A, 'NOTES.md'), 'a') as f: f.write(line + '\n')
    git(A, 'commit', '-qam', f'step {t}'); git(A, 'push', '-q', 'origin', 'HEAD')
    push_s.append(time.perf_counter() - t0)
    w.join()
    seen_s.append(found['at'] - t0); pulls.append(found['pulls'])
    print(f'trial {t}: push {push_s[-1]:.2f}s seen {seen_s[-1]:.2f}s', file=sys.stderr)
print(json.dumps({'bench': 'github_handoff', 'arm': 'github (real private repo, B pulls every %gs)' % POLL, 'trials': TRIALS,
                  'write_s': st(push_s), 'handoff_s': st(seen_s), 'pulls_per_handoff_mean': round(statistics.mean(pulls), 1)}), flush=True)

URL = os.environ.get('HN_URL', 'http://127.0.0.1:7499')
TOKEN = os.environ['HN_TOKEN']
def hc(m, p, agent='bench'):
    r = request.Request(URL + '/v1/call', data=json.dumps({'method': m, 'params': p, 'agent': agent}).encode(),
                        headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'})
    with request.urlopen(r, timeout=30) as x: return json.loads(x.read())['result']
name = 'ghh-' + uuid.uuid4().hex[:8]
hc('create', {'id': str(uuid.uuid4()), 'name': name, 'description': 'handoff', 'content': '# notes', 'op_id': str(uuid.uuid4())})
w_s, h_s = [], []
for t in range(TRIALS):
    cur = hc('changes', {'tail': 1})['cursor']; found = {}
    def waiter():
        c = cur
        while True:
            r = hc('changes', {'since': c, 'hold': 8000}, 'agent-b')
            if any(e.get('body', '').startswith(f'- step {t} ') for e in r['events']): found['at'] = time.perf_counter(); return
            c = r['cursor']
    w = threading.Thread(target=waiter); w.start(); time.sleep(1)
    t0 = time.perf_counter(); hc('append', {'note': name, 'body': f'- step {t} done', 'op_id': str(uuid.uuid4())}, 'agent-a')
    w_s.append(time.perf_counter() - t0); w.join(); h_s.append(found['at'] - t0)
print(json.dumps({'bench': 'github_handoff', 'arm': 'hivenote (B in hivenote wait)', 'queen': URL, 'trials': TRIALS,
                  'write_s': st(w_s), 'handoff_s': st(h_s)}), flush=True)
