#!/usr/bin/env python3
"""Head-to-head: N agents each add K progress lines to one shared notes file.

Git arm: each agent has its own clone of a bare remote and, per update, does
pull --rebase, appends a line to NOTES.md, commits, pushes; a rejected push or a
rebase conflict is retried (the conflict resolved by keeping both sides, which is
what a careful agent would do). Measured: wall time, per-update latency, rejected
pushes, rebase conflicts, and lines missing/duplicated at the end.

HiveNote arm: the same N agents append the same lines to one note through the
queen. Same counts measured. Local bare remote = best case for Git (no network);
pass --remote URL to use a real GitHub repo.

Usage: python3 git_vs_hive.py [agents=10] [updates=20] [--arm git|hive|both]
"""
import argparse, json, os, shutil, statistics, subprocess, tempfile, threading, time, uuid
from urllib import request

ap = argparse.ArgumentParser()
ap.add_argument('agents', nargs='?', type=int, default=10)
ap.add_argument('updates', nargs='?', type=int, default=20)
ap.add_argument('--arm', default='both')
ap.add_argument('--remote', default=None)
a = ap.parse_args()

def stats(xs):
    if not xs: return {'n': 0}
    s = sorted(xs); q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {'n': len(s), 'mean': round(statistics.mean(s), 1), 'p50': round(q(.5), 1), 'p95': round(q(.95), 1), 'max': round(s[-1], 1)}

def git(cwd, *args, check=True):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, check=check)

def git_arm():
    root = tempfile.mkdtemp(prefix='gitbench-', dir=os.environ.get('TMPDIR'))
    remote = a.remote or os.path.join(root, 'remote.git')
    if not a.remote:
        git(root, 'init', '--bare', '-q', '-b', 'main', remote)
        seed = os.path.join(root, 'seed'); git(root, 'clone', '-q', remote, seed)
        open(os.path.join(seed, 'NOTES.md'), 'w').write('# notes\n')
        git(seed, 'add', '.'); git(seed, '-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-qm', 'seed'); git(seed, 'push', '-q', 'origin', 'main')
    clones = []
    for i in range(a.agents):
        d = os.path.join(root, f'agent{i}'); git(root, 'clone', '-q', remote, d)
        git(d, 'config', 'user.name', f'agent{i}'); git(d, 'config', 'user.email', f'a{i}@x'); clones.append(d)
    lat, rejected, conflicts = [], [0], [0]
    lock = threading.Lock()

    def agent(i):
        d = clones[i]
        for k in range(a.updates):
            line = f'- agent{i} update{k}\n'
            t = time.perf_counter()
            while True:
                r = git(d, 'pull', '-q', '--rebase', 'origin', 'main', check=False)
                if r.returncode != 0:  # rebase conflict on NOTES.md: keep both sides
                    with lock: conflicts[0] += 1
                    txt = open(os.path.join(d, 'NOTES.md')).read()
                    txt = '\n'.join(l for l in txt.splitlines() if not l.startswith(('<<<<<<<', '=======', '>>>>>>>'))) + '\n'
                    open(os.path.join(d, 'NOTES.md'), 'w').write(txt)
                    git(d, 'add', 'NOTES.md'); git(d, '-c', 'core.editor=true', 'rebase', '--continue', check=False)
                with open(os.path.join(d, 'NOTES.md'), 'a') as f: f.write(line)
                git(d, 'commit', '-qam', f'agent{i} {k}')
                p = git(d, 'push', '-q', 'origin', 'main', check=False)
                if p.returncode == 0: break
                with lock: rejected[0] += 1
                git(d, 'reset', '-q', '--hard', 'HEAD~1')  # drop local commit, re-pull, redo the update
            with lock: lat.append((time.perf_counter() - t) * 1000)

    t0 = time.perf_counter()
    ts = [threading.Thread(target=agent, args=(i,)) for i in range(a.agents)]
    [t.start() for t in ts]; [t.join() for t in ts]
    wall = time.perf_counter() - t0
    check = os.path.join(root, 'check'); git(root, 'clone', '-q', remote, check)
    lines = [l for l in open(os.path.join(check, 'NOTES.md')).read().splitlines() if l.startswith('- agent')]
    want = {f'- agent{i} update{k}' for i in range(a.agents) for k in range(a.updates)}
    out = {'arm': 'git', 'remote': 'github' if a.remote else 'local bare repo', 'agents': a.agents, 'updates_each': a.updates,
           'wall_s': round(wall, 2), 'update_latency_ms': stats(lat), 'rejected_pushes': rejected[0], 'rebase_conflicts': conflicts[0],
           'missing': len(want - set(lines)), 'duplicated': len(lines) - len(set(lines))}
    if not a.remote: shutil.rmtree(root, ignore_errors=True)
    return out

URL = os.environ.get('HN_URL', 'http://127.0.0.1:7499')
TOKEN = os.environ['HN_TOKEN']

def hcall(method, params, agent='bench'):
    req = request.Request(URL + '/v1/call', data=json.dumps({'method': method, 'params': params, 'agent': agent}).encode(),
                          headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'})
    try:
        with request.urlopen(req, timeout=30) as r: return json.loads(r.read())
    except Exception as e:
        body = getattr(e, 'read', lambda: b'{}')()
        return json.loads(body or b'{}')

def hive_arm():
    name = f'gvh-{uuid.uuid4().hex[:8]}'
    hcall('create', {'id': str(uuid.uuid4()), 'name': name, 'description': 'git vs hive', 'content': '# notes', 'op_id': str(uuid.uuid4())})
    head = hcall('changes', {'tail': 1})['result']['cursor']
    lat, errors = [], [0]; lock = threading.Lock()

    def agent(i):
        for k in range(a.updates):
            t = time.perf_counter()
            r = hcall('append', {'note': name, 'body': f'- agent{i} update{k}', 'op_id': str(uuid.uuid4())}, f'agent{i}')
            with lock:
                lat.append((time.perf_counter() - t) * 1000)
                if 'error' in r: errors[0] += 1

    t0 = time.perf_counter()
    ts = [threading.Thread(target=agent, args=(i,)) for i in range(a.agents)]
    [t.start() for t in ts]; [t.join() for t in ts]
    wall = time.perf_counter() - t0
    lines, cur = [], head
    while True:
        r = hcall('changes', {'since': cur, 'limit': 100})['result']
        lines += [e['body'] for e in r['events'] if e['kind'] == 'append' and e.get('body', '').startswith('- agent')]
        cur = r['cursor']
        if not r['has_more']: break
    want = {f'- agent{i} update{k}' for i in range(a.agents) for k in range(a.updates)}
    return {'arm': 'hivenote', 'agents': a.agents, 'updates_each': a.updates, 'wall_s': round(wall, 2),
            'update_latency_ms': stats(lat), 'errors': errors[0], 'rejected_pushes': 0, 'rebase_conflicts': 0,
            'missing': len(want - set(lines)), 'duplicated': len(lines) - len(set(lines))}

for arm in (['git', 'hive'] if a.arm == 'both' else [a.arm]):
    print(json.dumps({'bench': 'git_vs_hive', **(git_arm() if arm == 'git' else hive_arm())}), flush=True)
