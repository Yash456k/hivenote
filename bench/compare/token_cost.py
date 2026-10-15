#!/usr/bin/env python3
"""What an agent reads to find the 3 notes it needs, as shared knowledge grows.

Synthetic notes sized like Yash's real hive (27 notes: content median ~1.8 KB, mean
~3.1 KB; description ~160 chars). Each note has a distinct topic word. The agent's
job: get the full text of the 3 notes about its topic.

- Shared file (NOTES.md / AGENTS.md / plans/): the agent reads the whole file.
- HiveNote, list route: `hivenote list` (names + descriptions), then `hivenote read a b c`.
- HiveNote, search route: `hivenote search TOPIC`, then `hivenote read a b c`.
Measured as the bytes of real CLI output against a queen; tokens ~ bytes/4 (estimate).

Usage: python3 token_cost.py [sizes=50,200,1000]
"""
import json, os, random, subprocess, sys, tempfile, uuid
from urllib import request

URL = os.environ.get('HN_URL', 'http://127.0.0.1:7499')
TOKEN = os.environ['HN_TOKEN']
ENV = {k: v for k, v in os.environ.items() if not k.startswith('HIVENOTE_')}
random.seed(7)
WORDS = ('deploy service config queue retry token schema migration worker cache index request latency budget review '
         'release branch build test fixture error handler route client server backup restore limit owner decision note').split()

def hc(m, p):
    r = request.Request(URL + '/v1/call', data=json.dumps({'method': m, 'params': p, 'agent': 'seed'}).encode(),
                        headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'})
    with request.urlopen(r, timeout=30) as x: return json.loads(x.read())

def text(n):
    out = []
    while sum(len(w) + 1 for w in out) < n: out.append(random.choice(WORDS))
    return ' '.join(out)

def cli(*a, stdin=None):
    return subprocess.run(['hivenote', *a, '--json'], env=ENV, input=stdin, capture_output=True, text=True, check=True).stdout

sizes = [int(x) for x in (sys.argv[1] if len(sys.argv) > 1 else '50,200,1000').split(',')]
for size in sizes:
    tag = uuid.uuid4().hex[:6]
    notes = []
    for i in range(size):
        topic = f't{tag}x{i // 3}'  # 3 notes per topic
        clen = int(random.lognormvariate(7.5, 0.6))  # median ~1.8 KB
        notes.append({'name': f'{topic}-{i % 3}', 'description': f'{topic}: ' + text(150), 'content': f'{topic} ' + text(clen)})
    # A separate hive per size so `list` shows only this size's notes.
    import shutil
    home = os.path.join(tempfile.gettempdir(), f'hivenote-tc-{size}-{tag}')
    shutil.rmtree(home, ignore_errors=True); os.makedirs(home)
    ENV['HIVENOTE_HOME'] = home
    shared_md = '\n\n'.join(f"## {n['name']}\n{n['description']}\n\n{n['content']}" for n in notes)
    for n in notes:
        cli('add', n['name'], n['description'], '-', stdin=n['content'])
    want_topic = notes[len(notes) // 2]['name'].rsplit('-', 1)[0]
    want = [n['name'] for n in notes if n['name'].startswith(want_topic + '-')]
    read_out = cli('read', *want)
    listing = cli('list')
    search_out = cli('search', want_topic)
    found = sum(1 for w in want if w in search_out)
    r = {'bench': 'token_cost', 'notes': size, 'needed': 3,
         'shared_file_bytes': len(shared_md.encode()), 'hive_list_plus_read_bytes': len(listing.encode()) + len(read_out.encode()),
         'hive_search_plus_read_bytes': len(search_out.encode()) + len(read_out.encode()), 'search_found_needed': found}
    r['tokens_est'] = {k.replace('_bytes', ''): r[k] // 4 for k in list(r) if k.endswith('_bytes')}
    r['search_route_reduction_x'] = round(r['shared_file_bytes'] / r['hive_search_plus_read_bytes'], 1)
    r['list_route_reduction_x'] = round(r['shared_file_bytes'] / r['hive_list_plus_read_bytes'], 1)
    print(json.dumps(r), flush=True)
