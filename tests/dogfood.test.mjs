import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, cliJson, run, sandbox } from './helpers.mjs';

// Found by using every command the way a newcomer would, on a throwaway hive.

/** The CLI as a person at a terminal sees it: stdout reports a terminal, and no agent is detected. */
const AT_A_TERMINAL = 'data:text/javascript,Object.defineProperty(process.stdout,"isTTY",{value:true})';
const NO_AGENT = { HERMES_SESSION_ID: undefined, HERMES_AGENT: undefined, CODEX_CI: undefined, CODEX_PERMISSION_PROFILE: undefined, CODEX_SANDBOX: undefined, CLAUDECODE: undefined, NO_COLOR: '1' };
function atTerminal(db, args) {
  return run(process.execPath, ['--import', AT_A_TERMINAL, cli, ...args], { env: { ...NO_AGENT, HIVENOTE_DB: db } });
}

test('search takes text with colons as plain words, and says how to search for a syntax word', async t => {
  const db = join(await sandbox(t, 'search-colon'), 'notes.db');
  await cliJson(['--db', db, 'add', 'crash', 'Server notes', 'TODO: fix the crash at http://localhost:3000, error: ENOENT, 2^10 retries']);
  await cliJson(['--db', db, 'add', 'deploy', 'Deploy notes', 'deploy staging']);
  // Text pasted from a log or a note has colons in it; it used to be refused as broken search syntax.
  for (const query of ['TODO: fix', 'http://localhost:3000', 'localhost:3000', 'error: ENOENT', '2^10']) {
    assert.deepEqual((await cliJson(['--db', db, 'search', query])).notes.map(note => note.name), ['crash'], query);
  }
  // A column or a ^ at the start of a word is still search syntax.
  assert.deepEqual((await cliJson(['--db', db, 'search', 'description:server'])).notes.map(note => note.name), ['crash']);
  assert.deepEqual((await cliJson(['--db', db, 'search', '^deploy'])).notes.map(note => note.name), ['deploy']);
  // NOT on its own is the operator with nothing around it: the answer says to quote it.
  const refused = await run(process.execPath, [cli, '--db', db, 'search', 'NOT']);
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.stderr).error.message, /AND, OR, NOT and NEAR are search syntax.*double quotes/u);
});

test('a database file that is damaged or not a database is named, with what to do, instead of "Database operation failed"', async t => {
  const dir = await sandbox(t, 'damaged');
  const db = join(dir, 'notes.db');
  writeFileSync(db, 'this is not a database, just text that happens to sit where the hive should be\n'.repeat(20));
  for (const command of ['list', 'status']) {
    const result = await run(process.execPath, [cli, '--db', db, command]);
    assert.equal(result.code, 1, command);
    const { error } = JSON.parse(result.stderr);
    assert.equal(error.code, 'storage_error');
    assert.ok(error.message.includes(db), error.message);
    assert.match(error.message, /is damaged, or is not a HiveNote database.*left it as it is.*hivenote backup/u);
  }
});

test('a config file that cannot be used is named, and so is the setting it does not know', async t => {
  const home = await sandbox(t, 'config');
  const env = { HIVENOTE_HOME: home, HIVENOTE_DB: undefined, HIVENOTE_URL: undefined };
  const config = join(home, 'config.json');
  writeFileSync(config, '{not json');
  let { error } = JSON.parse((await run(process.execPath, [cli, 'list'], { env })).stderr);
  assert.equal(error.code, 'invalid_config');
  assert.ok(error.message.includes(config), error.message);
  assert.match(error.message, /not valid JSON/u);
  writeFileSync(config, JSON.stringify({ colour: 'blue' }));
  ({ error } = JSON.parse((await run(process.execPath, [cli, 'list'], { env })).stderr));
  assert.match(error.message, /doesn't know: colour\. It knows db, url/u);
  assert.ok(error.message.includes(config), error.message);
});

test('restoring a version a note never had, and marking a note, name the note and say what to do', async t => {
  const db = join(await sandbox(t, 'restore-mark'), 'notes.db');
  await cliJson(['--db', db, 'add', 'plan', 'The plan', 'step one']);
  const restore = JSON.parse((await run(process.execPath, [cli, '--db', db, 'restore', 'plan', '9'])).stderr).error;
  assert.equal(restore.code, 'not_found');
  assert.equal(restore.message, "'plan' has no version 9. hivenote history plan lists its versions");
  const mark = JSON.parse((await run(process.execPath, [cli, '--db', db, 'mark', 'plan', 'done'])).stderr).error;
  assert.equal(mark.message, "'plan' is a note, not a task: only tasks have a status or a due date");
});

test('at a terminal: an empty hive says how to start, a refused edit shows the note, history names the note to restore', async t => {
  const db = join(await sandbox(t, 'terminal'), 'notes.db');
  const empty = await atTerminal(db, ['list']);
  assert.equal(empty.stdout, 'No notes yet. Add one: hivenote add NAME "description" "text"\n');
  await cliJson(['--db', db, 'add', 'deploy notes', 'How we deploy', 'Run the script, then check the health page']);
  const edit = await atTerminal(db, ['edit', 'deploy notes', 'not in the note', 'x']);
  assert.equal(edit.code, 1);
  // The message says "here is the note", so the note follows it, as it does in the JSON answer.
  assert.match(edit.stderr, /^hivenote: The old text is not in the note as it stands now\. Here is the note; redo the edit against it\n\ndeploy notes\nHow we deploy\n\nRun the script, then check the health page\n/u);
  const history = await atTerminal(db, ['history', 'deploy notes']);
  assert.match(history.stdout, /Undo with: hivenote restore 'deploy notes' VERSION\n$/u);
});

test('at a terminal, take prints the task with its progress, as the README says', async t => {
  const db = join(await sandbox(t, 'take-progress'), 'notes.db');
  await cliJson(['--db', db, 'task', 'migrate', 'Move the data', '--agent', 'first-agent']);
  await cliJson(['--db', db, 'mark', 'migrate', 'doing', '--agent', 'first-agent']);
  await cliJson(['--db', db, 'append', 'migrate', 'Copied the users table', '--agent', 'first-agent']);
  await cliJson(['--db', db, 'mark', 'migrate', 'todo', 'Handing this over', '--agent', 'first-agent']);
  const took = await atTerminal(db, ['take']);
  assert.equal(took.code, 0, took.stderr);
  assert.match(took.stdout, /^Took migrate\nMove the data\n\nProgress\n.*Copied the users table\n.*Handing this over\n$/u);
});

test('a one-second wait says "1 second"', async t => {
  const db = join(await sandbox(t, 'second'), 'notes.db');
  const waited = await run(process.execPath, [cli, '--db', db, 'wait', '1s']);
  assert.equal(waited.code, 1);
  assert.equal(JSON.parse(waited.stderr).error.message, 'Nothing changed within 1 second');
});
