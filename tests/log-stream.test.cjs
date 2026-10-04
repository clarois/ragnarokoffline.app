'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLogStreams, levelOf, sortableTime, redactSecrets, splitTime } = require('../electron/log-stream');
const { JoinSession } = require('../electron/join-session');

const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-logs-'));
  fs.mkdirSync(path.join(dir, 'state'));
  fs.mkdirSync(path.join(dir, 'nebula'));
  return dir;
}

// The redaction main.js hands the viewer: the join session's, then this one.
function redactor() {
  const join = new JoinSession();
  return text => redactSecrets(join.redact(text), [TOKEN]);
}

function streams(dir, extra = {}) {
  return createLogStreams({
    stateDir: () => path.join(dir, 'state'),
    nebulaLogsDir: () => path.join(dir, 'nebula'),
    stackBin: () => 'ragnarok-stack',
    stackEnv: () => ({ cwd: dir, env: {} }),
    redact: redactor(),
    pollMs: 20, graceMs: 0, retryMs: 20, keepOnExit: true,
    ...extra,
  });
}

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};

test('levels come from rAthena tags, console levels and the engine', () => {
  assert.strictEqual(levelOf('\x1b[1;31m[Error]\x1b[0m: script:op_2: unexpected'), 'error');
  assert.strictEqual(levelOf('[Fatal Error]: out of memory'), 'error');
  assert.strictEqual(levelOf('[Warning]: npc_parsesrcfile: Unknown syntax'), 'warning');
  assert.strictEqual(levelOf('[error] Uncaught TypeError: x is undefined (index.js:3)'), 'error');
  assert.strictEqual(levelOf('[warning] slow frame'), 'warning');
  assert.strictEqual(levelOf(' WARN nebulad::net: port forward removed'), 'warning');
  assert.strictEqual(levelOf('[Status]: Loading maps...'), 'info');
  assert.strictEqual(levelOf('[Debug]: something'), 'debug');
  assert.strictEqual(levelOf('Done reading 0 errors.'), 'info');
});

test('docker timestamps compare in order whatever their precision', () => {
  assert.ok(sortableTime('2026-09-30T10:00:05.1Z') > sortableTime('2026-09-30T10:00:05.09Z'));
  assert.ok(sortableTime('2026-09-30T10:00:05Z') < sortableTime('2026-09-30T10:00:05.000000001Z'));
  assert.deepStrictEqual(splitTime('2026-09-30T19:33:24.839Z start_stack: up'), ['2026-09-30T19:33:24.839Z', 'start_stack: up']);
  assert.deepStrictEqual(splitTime('[Status]: no time'), [null, '[Status]: no time']);
});

test('no stream carries the agent token, a password or an invite', () => {
  const r = redactor();
  const lines = [
    `claude mcp add --transport http ragnarok-offline http://127.0.0.1:7777/mcp/1 --header "Authorization: Bearer ${TOKEN}"`,
    `agent connection ${TOKEN}`,
    'accounts: {"username":"alice","password":"hunter2-secret","confirmation":"hunter2-secret"}',
    'UPDATE login SET user_pass=0x68756e746572322d736563726574 WHERE account_id=2000000',
    'password: hunter2-secret',
    'joined https://friend.example/play#invite=zzzsecretzzz',
  ];
  for (const line of lines) {
    const out = r(line);
    assert.ok(!out.includes(TOKEN), out);
    assert.ok(!out.includes('hunter2'), out);
    assert.ok(!out.includes('68756e746572322d736563726574'), out);
    assert.ok(!out.includes('zzzsecretzzz'), out);
  }
});

test('a tailed file gives a backlog, then new lines live, redacted, through truncation', async () => {
  const dir = scratch();
  const log = path.join(dir, 'state', 'client.log');
  fs.writeFileSync(log, '2026-09-30T10:00:00.000Z client log started\n2026-09-30T10:00:01.000Z [info] hello\n');
  const s = streams(dir);
  const seen = [];
  const stop = s.subscribe(['client'], e => seen.push(e));
  assert.deepStrictEqual(seen.map(e => e.text), ['client log started', '[info] hello']);
  assert.strictEqual(seen[1].time, '2026-09-30T10:00:01.000Z');

  fs.appendFileSync(log, `2026-09-30T10:00:02.000Z [error] Uncaught Error: mod broke token=${TOKEN}\n`);
  await until(() => seen.length === 3, 'the appended line');
  assert.strictEqual(seen[2].level, 'error');
  assert.ok(!seen[2].text.includes(TOKEN), seen[2].text);

  // A half-written line waits for its end.
  fs.appendFileSync(log, '2026-09-30T10:00:03.000Z [info] par');
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(seen.length, 3);
  fs.appendFileSync(log, 'tial\n');
  await until(() => seen.length === 4, 'the completed line');
  assert.strictEqual(seen[3].text, '[info] partial');

  // client.log is truncated every run.
  fs.writeFileSync(log, '2026-09-30T11:00:00.000Z client log started\n');
  await until(() => seen.length === 6, 'the restart');
  assert.strictEqual(seen[4].level, 'marker');
  assert.match(seen[4].text, /started over/);
  assert.strictEqual(seen[5].text, 'client log started');
  stop();
});

test('missing-files.log says which file, as a warning; other asset lines keep their file name', async () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'state', 'assets', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'assets.log'), 'Asset server listening\n');
  fs.writeFileSync(path.join(dir, 'state', 'assets', 'logs', 'missing-files.log'),
    '{"timestamp":"2026-09-30T19:33:49.684Z","requestedPath":"data/sprite/x.spr","grfPath":"x","mappedPath":null}\n');
  const s = streams(dir);
  const seen = [];
  const stop = s.subscribe(['assets'], e => seen.push(e));
  assert.ok(seen.some(e => e.text === 'assets.log: Asset server listening'));
  const miss = seen.find(e => e.text === 'missing: data/sprite/x.spr');
  assert.ok(miss && miss.level === 'warning' && miss.time === '2026-09-30T19:33:49.684Z');
  stop();
});

function fakeSpawn(scripts) {
  const calls = [];
  let pids = 1000;
  const spawn = (bin, args) => {
    // On Windows a follow is stopped with `taskkill /pid N /T /F`: stop the
    // fake with that pid, as the real one would be.
    if (bin === 'taskkill') {
      const target = calls.find(c => String(c.child.pid) === args[args.indexOf('/pid') + 1]);
      if (target) target.child.killed = true;
      const done = new EventEmitter();
      setImmediate(() => done.emit('close', 0));
      return done;
    }
    const child = new EventEmitter();
    // Only where it is used: elsewhere a pid would be signalled for real.
    if (process.platform === 'win32') child.pid = ++pids;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    calls.push({ bin, args, child });
    const script = scripts[calls.length - 1];
    setImmediate(async () => {
      if (!script) return; // stays open
      for (const line of script.lines) child.stdout.write(line + '\n');
      await new Promise(r => setTimeout(r, 5));
      if (script.code !== undefined) child.emit('close', script.code);
    });
    return child;
  };
  return { spawn, calls };
}

test('a container stream marks a stop, reconnects, drops the overlap and marks the restart', async () => {
  const dir = scratch();
  const { spawn, calls } = fakeSpawn([
    { lines: ['2026-09-30T10:00:00.5Z [Status]: map ready', '2026-09-30T10:00:01Z \x1b[1;31m[Error]\x1b[0m: script error in npc/mods/my-mod/a.txt'], code: 0 },
    { lines: [], code: 4 },
    { lines: ['2026-09-30T10:00:00.5Z [Status]: map ready', '2026-09-30T10:00:01Z [Error]: old', '2026-09-30T10:05:00Z [Status]: map ready again'] },
  ]);
  const s = streams(dir, { spawn });
  // Fast retries for the test.
  const seen = [];
  const stop = s.subscribe(['map'], e => seen.push(e));
  await until(() => calls.length >= 1, 'the first follow');
  assert.deepStrictEqual(calls[0].args, ['logs', '--follow', 'map', '--tail', '200']);
  await until(() => seen.some(e => /stopped/.test(e.text)), 'the stop marker');
  assert.strictEqual(seen[1].level, 'error');
  await until(() => seen.some(e => /restarted/.test(e.text)), 'the restart marker');
  const texts = seen.map(e => e.text);
  assert.deepStrictEqual(texts, [
    '[Status]: map ready',
    '\x1b[1;31m[Error]\x1b[0m: script error in npc/mods/my-mod/a.txt',
    '— map server stopped —',
    '— map server restarted —',
    '[Status]: map ready again',
  ]);
  // A reconnect asks for enough to cover the gap.
  assert.deepStrictEqual(calls[2].args.slice(-2), ['--tail', '400']);
  stop();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(calls[2].child.killed, 'the follow stops with its last listener');
});

test('a progress line rAthena redraws with \\r shows as its last piece, and an unstamped line takes the time before it', async () => {
  const dir = scratch();
  const { spawn } = fakeSpawn([
    { lines: [
      "\x1b[1;32m[Status]\x1b[0m: Loading 'barters/a.yml'...\x1b[K\r2026-09-30T20:40:50.8166Z \x1b[1;32m[Status]\x1b[0m: Loading '7' entries in 'barters/a.yml'\r",
      '2026-09-30T20:40:50.8173Z [Status]: Done reading \'7\' entries\r\n[Status]: Map Server is now online.\r',
    ] },
  ]);
  const s = streams(dir, { spawn });
  const seen = [];
  const stop = s.subscribe(['map'], e => seen.push(e));
  await until(() => seen.length >= 3, 'all three lines');
  assert.deepStrictEqual(seen.map(e => [e.time, e.text, e.level]), [
    ['2026-09-30T20:40:50.8166Z', "\x1b[1;32m[Status]\x1b[0m: Loading '7' entries in 'barters/a.yml'", seen[0].level],
    ['2026-09-30T20:40:50.8173Z', "[Status]: Done reading '7' entries", seen[1].level],
    // Written in the same breath, so docker stamped only the first.
    ['2026-09-30T20:40:50.8173Z', '[Status]: Map Server is now online.', seen[2].level],
  ]);
  assert.ok(seen.every(e => e.level !== 'warning'), JSON.stringify(seen));
  stop();
});

test('a server that is not running says so once', async () => {
  const dir = scratch();
  const { spawn, calls } = fakeSpawn([{ lines: [], code: 4 }, { lines: [], code: 4 }]);
  const s = streams(dir, { spawn });
  const seen = [];
  const stop = s.subscribe(['char'], e => seen.push(e));
  await until(() => seen.length === 1, 'the marker');
  assert.strictEqual(seen[0].text, '— char server not running —');
  stop();
  void calls;
});

test('the SSE response streams events and stops listening when cancelled', async () => {
  const dir = scratch();
  const log = path.join(dir, 'state', 'app.log');
  fs.writeFileSync(log, '2026-09-30T10:00:00.000Z start_stack: up\n');
  const s = streams(dir);
  const res = s.response(new URL('ro-tool://log-viewer/stream?sources=app,nope'));
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events = () => text.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)));
  const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value); } })();
  await until(() => events().length === 1, 'the backlog event');
  assert.deepStrictEqual(events()[0], { source: 'app', time: '2026-09-30T10:00:00.000Z', level: 'info', text: 'start_stack: up' });
  fs.appendFileSync(log, '2026-09-30T10:00:01.000Z mods: my-mod supplies npc\n');
  await until(() => events().length === 2, 'the live event');
  await reader.cancel();
  await pump;
});

test('backups and restores have their own source, with failures as errors', async () => {
  const dir = scratch();
  fs.mkdirSync(path.join(dir, 'state', 'logs'));
  fs.writeFileSync(path.join(dir, 'state', 'logs', 'backup-restore.log'),
    '2026-10-02T19:07:19Z [restore] loading the backup into the database\n' +
    '2026-10-02T19:07:19Z [restore] [error] failed: Restore failed: the database said: --------------\n' +
    "2026-10-02T19:07:19Z [restore] [error] ERROR 1064 (42000) at line 2496: You have an error in your SQL syntax\n");
  const s = streams(dir);
  const seen = [];
  const stop = s.subscribe(['saves'], e => seen.push(e));
  assert.strictEqual(seen.length, 3);
  assert.strictEqual(seen[0].time, '2026-10-02T19:07:19Z');
  assert.strictEqual(seen[0].level, 'info');
  assert.deepStrictEqual(seen.slice(1).map(e => e.level), ['error', 'error']);
  stop();
});
