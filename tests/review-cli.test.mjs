import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { sandbox, cli, run, cliJson } from './helpers.mjs';
import { connectMcp, methodNames } from './mcp-helpers.mjs';

async function setup(t) {
  const dir = await sandbox(t, 'review-cli');
  const db = join(dir, 'notes.sqlite');
  const env = { HIVENOTE_HOME: join(dir, 'config') };
  const args = ['--db', db];
  return {
    db, dir, env,
    call: (...command) => cliJson([...args, ...command], { env }),
    run: (...command) => run(process.execPath, [cli, ...args, ...command], { env, cwd: dir }),
  };
}
function invalid(result) {
  assert.notEqual(result.code, 0, `Unexpected success: ${result.stdout}`);
  assert.match(result.stderr, /"code":"(?:invalid_args|validation_error)"/u);
}

test('review: repeated delete IDs fail without changing either note', async t => {
  const ctx = await setup(t);
  const a = (await ctx.call('create', 'A')).note;
  const b = (await ctx.call('create', 'B')).note;
  const result = await ctx.run('delete', '--id', a.id, '--id', b.id, '--base-rev', '1');
  const after = await ctx.call('read', a.id, b.id);
  assert.deepEqual(after.notes.map(note => [note.id, note.rev]), [[a.id, 1], [b.id, 1]]);
  invalid(result);
});

test('review: repeated create names fail before opening the database', async t => {
  const ctx = await setup(t);
  invalid(await ctx.run('create', '--name', 'A', '--name', 'B'));
  await assert.rejects(access(ctx.db));
});

const unsupported = [
  ['create', 'bad', '--old-str', 'old', '--new-str', 'intended content'],
  ['create', 'bad', '--ids', 'ignored'],
  ['list', '--content', 'ignored'],
  ['read', '--id', 'unused', '--body', 'ignored'],
  ['search', 'query', '--new-str', 'ignored'],
  ['edit', '--id', 'unused', '--old-str', 'a', '--new-str', 'b', '--destination', 'ignored'],
  ['replace', '--id', 'unused', '--base-rev', '1', '--content', 'x', '--new-str', 'ignored'],
  ['append', '--id', 'unused', '--body', 'x', '--old-str', 'ignored'],
  ['delete', '--id', 'unused', '--base-rev', '1', '--body', 'ignored'],
  ['history', '--id', 'unused', '--content', 'ignored'],
  ['revision', '--id', 'unused', '--rev', '1', '--names', 'ignored'],
  ['restore', '--id', 'unused', '--rev', '1', '--base-rev', '1', '--body', 'ignored'],
  ['changes', '--names', 'ignored'],
  ['claim', '--id', 'unused', '--body', 'ignored'],
  ['release', '--id', 'unused', '--ttl-seconds', '60'],
  ['update-task', '--id', 'unused', '--base-rev', '1', '--new-str', 'ignored'],
  ['token', 'list', '--name', 'ignored'],
  ['backup', '--destination', 'unused', '--name', 'ignored'],
  ['serve', '--name', 'ignored'],
  ['mcp', '--name', 'ignored'],
  ['config', 'show', '--content', 'ignored'],
];
for (const command of unsupported) {
  test(`review: unsupported flags rejected before side effects: ${command.join(' ')}`, async t => {
    const ctx = await setup(t);
    // Only invoke commands that would retain a process with an already-invalid
    // positional argument; the option error must still be diagnosed first.
    const args = ['serve', 'mcp'].includes(command[0]) ? [...command, 'unexpected'] : command;
    const result = await ctx.run(...args);
    invalid(result);
    assert.match(result.stderr, /option/iu);
    await assert.rejects(access(ctx.db));
  });
}

test('review: raw read fields survive native selector conversion for strict validation', async t => {
  const ctx = await setup(t);
  const note = (await ctx.call('create', 'valid')).note;
  for (const raw of [{ ids: [note.id], name: 'bad' }, { names: [note.name], id: note.id }]) {
    invalid(await ctx.run('read', '--params', JSON.stringify(raw)));
  }
  invalid(await ctx.run('read', '--params', JSON.stringify({ name: 'bad' }), '--id', note.id));
});

test('review: raw/native field conflicts do not silently overwrite values', async t => {
  const ctx = await setup(t);
  const a = (await ctx.call('create', 'A', '--content', 'old')).note;
  const b = (await ctx.call('create', 'B')).note;
  const cases = [
    ['read', '--params', JSON.stringify({ ids: [a.id] }), '--id', b.id],
    ['read', '--params', JSON.stringify({ names: ['A'] }), '--names', 'B'],
    ['create', '--params', '{"name":"raw name"}', '--name', 'native name'],
    ['create', 'bad content', '--params', '{"content":"raw content"}', '--body', 'native content'],
    ['edit', a.id, '--params', '{"old_str":"old","new_str":"raw"}', '--new-str', 'native'],
    ['append', a.id, '--params', '{"body":"raw"}', '--content', 'native'],
    ['delete', '--params', JSON.stringify({ id: a.id, base_rev: 1 }), '--id', b.id],
  ];
  for (const command of cases) invalid(await ctx.run(...command));
  assert.deepEqual((await ctx.call('read', a.id, b.id)).notes.map(note => [note.id, note.rev]), [[a.id, 1], [b.id, 1]]);
  assert.equal((await ctx.call('list')).total, 2);
});

for (const option of ['help', 'version']) {
  test(`review: --${option}=false executes the command`, async t => {
    const ctx = await setup(t);
    const result = await ctx.call('create', option, `--${option}=false`);
    assert.equal(result.note?.name, option);
    assert.equal((await ctx.call('list')).total, 1);
  });
}

test('review: whitespace-prefixed JSON selectors preserve literal names', async t => {
  const ctx = await setup(t);
  const name = '  literal name  ';
  const a = (await ctx.call('create', name)).note;
  const b = (await ctx.call('create', 'second')).note;
  assert.deepEqual((await ctx.call('read', '--names', ` \n\t${JSON.stringify([name])} `)).notes.map(note => note.id), [a.id]);
  assert.deepEqual((await ctx.call('read', '--ids', ` \n${JSON.stringify([a.id])}`)).notes.map(note => note.id), [a.id]);
  assert.equal((await ctx.call('read', '--names', name)).notes[0].id, a.id);
  assert.deepEqual((await ctx.call('read', '--name', name, '--name', 'second')).notes.map(note => note.id), [a.id, b.id]);
  assert.deepEqual((await ctx.call('read', '--id', a.id, '--id', b.id)).notes.map(note => note.id), [a.id, b.id]);
  assert.deepEqual((await ctx.call('read', '--ids', a.id, '--ids', b.id)).notes.map(note => note.id), [a.id, b.id]);
  assert.deepEqual((await ctx.call('read', '--names', name, '--names', 'second')).notes.map(note => note.id), [a.id, b.id]);
});

test('review: normal help, aliases and nonconflicting raw/native inputs still work', async t => {
  const ctx = await setup(t);
  for (const args of [['--help'], ['-h'], ['create', '--help']]) {
    const result = await ctx.run(...args);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Commands:/u);
  }
  assert.equal((await ctx.call('--version')).version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  const created = await ctx.call('create', 'aliases', '--body', 'old', '--params', '{"kind":"task"}');
  const id = created.note.id;
  assert.equal((await ctx.call('edit', id, '--old-str', 'old', '--body', 'new')).note.content, 'new');
  assert.equal((await ctx.call('replace', id, '--base-rev', '2', '--body', 'replacement')).note.content, 'replacement');
  assert.equal((await ctx.call('append', id, '--content', 'activity')).note.rev, 3);
  assert.equal((await ctx.call('update-task', id, '--base-rev', '3', '--status', 'done')).note.status, 'done');
});

test('review: MCP destructive annotations distinguish additive operations from replacements', async t => {
  const ctx = await setup(t);
  const connection = await connectMcp(process.execPath, [cli, '--db', ctx.db, 'mcp'], ctx.env);
  t.after(() => connection.client.close());
  const { tools } = await connection.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...methodNames].sort());
  const destructive = new Set(['edit', 'replace', 'delete', 'restore', 'update_task', 'claim', 'release']);
  for (const tool of tools) {
    assert.equal(tool.annotations.destructiveHint, destructive.has(tool.name), tool.name);
    assert.equal(tool.annotations.readOnlyHint, !destructive.has(tool.name) && !['create', 'append'].includes(tool.name), tool.name);
  }
});
