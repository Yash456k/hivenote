#!/usr/bin/env python3
"""Per-command latency an agent sees: real `hivenote` CLI processes against a queen.

Each agent tool call runs a fresh `hivenote` process, so this includes Node start-up,
connection setup and the request. Compared: helper off (new connection per command)
vs helper on (0.5's background helper keeps one connection open to the queen).
Usage: HN_URL=... python3 cli_latency.py [runs=30]
"""
import json, os, statistics, subprocess, sys, tempfile, time

URL = os.environ['HN_URL']
TOKEN = os.environ['HN_TOKEN']
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 30

def st(xs):
    s = sorted(xs); q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {'n': len(s), 'mean': round(statistics.mean(s)), 'p50': round(q(.5)), 'p95': round(q(.95))}

base = {k: v for k, v in os.environ.items() if not k.startswith('HIVENOTE_')}
home = tempfile.mkdtemp(prefix='hncli-', dir=os.environ.get('TMPDIR'))
base['HIVENOTE_HOME'] = home
subprocess.run(['hivenote', 'connect', URL], input=TOKEN + '\n', env=base, capture_output=True, text=True, check=True)
name = f'cli-{int(time.time())}'
subprocess.run(['hivenote', 'add', name, 'cli latency', 'x'], env=base, capture_output=True, check=True)
out = {'bench': 'cli_latency', 'queen': URL, 'runs': RUNS}
for mode in ('off', 'on'):
    env = {**base, 'HIVENOTE_HELPER': mode if mode == 'off' else '600'}
    subprocess.run(['hivenote', 'read', name], env=env, capture_output=True)  # warm (starts helper when on)
    for cmd in (['read', name], ['append', name, 'progress line']):
        xs = []
        for _ in range(RUNS):
            t = time.perf_counter(); subprocess.run(['hivenote', *cmd], env=env, capture_output=True, check=True); xs.append((time.perf_counter() - t) * 1000)
        out[f'helper_{mode}_{cmd[0]}_ms'] = st(xs)
t = time.perf_counter(); subprocess.run(['node', '-e', '0'], check=True); out['bare_node_start_ms'] = round((time.perf_counter() - t) * 1000)
subprocess.run(['hivenote', 'disconnect'], env=base, capture_output=True)
print(json.dumps(out))
