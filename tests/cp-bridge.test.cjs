'use strict';
// The Control panel's bridge (#230): what reaches `ragnarok-stack cp`, what
// goes through the app's server-operation queue, and what does not. The
// statements are built and tested in stack/src/control_panel.rs; here the
// "supervisor" is a script that records what it was asked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCpBridge } = require('../electron/cp-bridge');
const { TOOLS } = require('../electron/tools');

// Node runs a file called `cp` in the working directory, so node itself
// stands in for the supervisor binary: `node cp`, on every platform.
function fakeStack(behaviour, { host = true } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-cp-bridge-'));
	fs.writeFileSync(path.join(dir, 'cp'), `
		const fs = require('node:fs');
		const input = fs.readFileSync(0, 'utf8');
		fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
		const request = JSON.parse(input);
		${behaviour}
	`);
	const logged = [];
	const queued = [];
	const accounts = [];
	const bridge = createCpBridge({
		stackBin: () => process.execPath,
		stackEnv: () => ({ cwd: dir, env: process.env }),
		log: line => logged.push(line),
		serverOperation: async (run, options) => { queued.push(options); return run(); },
		createAccount: async request => { accounts.push(request); return { era: 'renewal', updated: true, changed: 1 }; },
		context: () => ({ host, era: 'renewal' }),
	});
	const calls = () => {
		const file = path.join(dir, 'calls.jsonl');
		return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
	};
	return { bridge, calls, logged, queued, accounts };
}

const post = (call, body, headers = {}) => new Request(`ro-tool://control-panel/api/${call}`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', ...headers },
	body: JSON.stringify(body),
});

test('the panel is one of the tools, and needs the server', () => {
	const tool = TOOLS.find(t => t.id === 'control-panel');
	assert.ok(tool);
	assert.strictEqual(tool.name, 'Control panel');
	assert.strictEqual(tool.page, 'control-panel.html');
	assert.strictEqual(tool.needsServer, true);
	assert.ok(fs.existsSync(path.join(__dirname, '..', 'tools', 'control-panel', tool.page)));
});

test('reads run `cp` with only the action and the id, outside the queue', async () => {
	const { bridge, calls, queued } = fakeStack(`process.stdout.write(JSON.stringify({ ok: request.action }));`);
	const list = await bridge(post('characters', { sql: 'DROP TABLE login' }), 'characters');
	assert.strictEqual(list.status, 200);
	assert.deepStrictEqual(await list.json(), { ok: 'characters' });
	await bridge(post('character', { char_id: '150000', extra: 'x' }), 'character');
	// `node cp`: the script is the verb, and nothing follows it.
	assert.deepStrictEqual(calls().map(c => [c.args, JSON.parse(c.input)]), [
		[[], { action: 'characters' }],
		[[], { action: 'character', char_id: '150000' }],
	]);
	assert.deepStrictEqual(queued, []);
});

test('a move and a delete go through the queue; only the delete stops the game', async () => {
	const { bridge, calls, queued, logged } = fakeStack(`process.stdout.write(JSON.stringify({ done: request.action }));`);
	const move = await bridge(post('reset-position', { char_id: 7, target: { map: 'prontera', x: 1, y: 2, z: 3 } }), 'reset-position');
	assert.strictEqual(move.status, 200);
	const save = await bridge(post('reset-position', { char_id: '7', target: 'save' }), 'reset-position');
	assert.strictEqual(save.status, 200);
	const del = await bridge(post('delete-character', { char_id: '7', name: 'Bob', also: 1 }), 'delete-character');
	assert.deepStrictEqual(await del.json(), { done: 'delete-character' });
	assert.deepStrictEqual(calls().map(c => JSON.parse(c.input)), [
		{ action: 'reset-position', char_id: '7', target: { map: 'prontera', x: 1, y: 2 } },
		{ action: 'reset-position', char_id: '7', target: 'save' },
		{ action: 'delete-character', char_id: '7', name: 'Bob' },
	]);
	assert.deepStrictEqual(queued, [{ stopsGame: false }, { stopsGame: false }, { stopsGame: true }]);
	assert.ok(logged.some(l => /delete-character 7; the game stops/.test(l)), logged.join('\n'));
});

test('what the supervisor said on failure is what the page shows', async () => {
	const { bridge } = fakeStack(`process.stdout.write(JSON.stringify({ error: 'Bob is in a party.' })); process.exit(1);`);
	const res = await bridge(post('delete-character', { char_id: '7', name: 'Bob' }), 'delete-character');
	assert.strictEqual(res.status, 502);
	assert.deepStrictEqual(await res.json(), { error: 'Bob is in a party.' });
});

test('only a POST from the page itself is answered, and only for its calls', async () => {
	const { bridge, calls } = fakeStack(`process.stdout.write('{}');`);
	assert.strictEqual((await bridge(new Request('ro-tool://control-panel/api/characters'), 'characters')).status, 405);
	assert.strictEqual((await bridge(post('characters', {}, { origin: 'ro-tool://db-browser' }), 'characters')).status, 405);
	assert.strictEqual((await bridge(post('sql', {}), 'sql')).status, 404);
	for (const body of [{}, { char_id: null }, { char_id: { a: 1 } }]) {
		assert.strictEqual((await bridge(post('character', body), 'character')).status, 400, JSON.stringify(body));
	}
	assert.strictEqual((await bridge(post('reset-position', { char_id: '7', target: 'home' }), 'reset-position')).status, 400);
	assert.strictEqual((await bridge(post('delete-character', { char_id: '7' }), 'delete-character')).status, 400);
	assert.deepStrictEqual(calls(), []);
	assert.strictEqual((await bridge(post('characters', {}, { origin: 'ro-tool://control-panel' }), 'characters')).status, 200);
});

test('one change at a time', async () => {
	const { bridge } = fakeStack(`setTimeout(() => process.stdout.write('{"moved":true}'), 400);`);
	const first = bridge(post('reset-position', { char_id: '7', target: 'save' }), 'reset-position');
	await new Promise(r => setTimeout(r, 50));
	const second = await bridge(post('delete-character', { char_id: '8', name: 'x' }), 'delete-character');
	assert.strictEqual(second.status, 409);
	assert.strictEqual((await first).status, 200);
	assert.strictEqual((await bridge(post('reset-position', { char_id: '7', target: 'save' }), 'reset-position')).status, 200);
});

test('an account is made by the Accounts tab\'s own path, and only by the host', async () => {
	const { bridge, accounts, calls, logged } = fakeStack(`process.stdout.write('{}');`);
	const made = await bridge(post('create-account', { username: 'friend1', password: 'a-secret-pass', confirmation: 'a-secret-pass', group_id: 99 }), 'create-account');
	assert.strictEqual(made.status, 200);
	assert.deepStrictEqual(accounts, [{ username: 'friend1', password: 'a-secret-pass', confirmation: 'a-secret-pass' }]);
	assert.deepStrictEqual(calls(), [], 'not through `cp`');
	assert.ok(!logged.join('\n').includes('a-secret-pass'), 'the password is never logged');
	assert.strictEqual((await bridge(post('create-account', { username: 'x' }), 'create-account')).status, 400);

	const joined = fakeStack(`process.stdout.write('{}');`, { host: false });
	const refused = await joined.bridge(post('create-account', { username: 'friend1', password: 'a-secret-pass', confirmation: 'a-secret-pass' }), 'create-account');
	assert.strictEqual(refused.status, 409);
	assert.deepStrictEqual(joined.accounts, []);
	assert.deepStrictEqual(await (await joined.bridge(post('context', {}), 'context')).json(), { host: false, era: 'renewal' });
});
