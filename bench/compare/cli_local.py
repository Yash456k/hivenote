#!/usr/bin/env python3
"""Per-command latency of the `hivenote` CLI on a local hive (one file, no queen).

Each run is a fresh process, as when an agent runs a command. Uses a temp HIVENOTE_HOME,
so your own hive is never touched. Usage: python3 cli_local.py [runs=15]
"""
import json, os, shutil, statistics, subprocess, sys, tempfile, time

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 15
home = tempfile.mkdtemp(prefix='hivenote-cli-local-')
env = {k: v for k, v in os.environ.items() if not k.startswith('HIVENOTE_')}
env['HIVENOTE_HOME'] = home

def run(*a):
    t = time.perf_counter()
    subprocess.run(['hivenote', *a], env=env, capture_output=True, check=True)
    return (time.perf_counter() - t) * 1000

try:
    run('task', 'cl-t', 'cli latency')
    out = {'bench': 'hivenote_cli_latency_local', 'mode': 'local hive file, no queen', 'runs': RUNS}
    cmds = {'add': lambda i: run('add', f'n{i}', 'd', 'x'), 'read': lambda i: run('read', 'cl-t'),
            'append': lambda i: run('append', 'cl-t', 'progress'), 'tasks': lambda i: run('tasks')}
    for name, fn in cmds.items():
        xs = [fn(i) for i in range(RUNS)]
        out[name + '_ms'] = {'p50': round(statistics.median(xs)), 'mean': round(statistics.mean(xs))}
    print(json.dumps(out))
finally:
    shutil.rmtree(home, ignore_errors=True)
