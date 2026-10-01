'use strict';
// The database browser's bridge (#200): what reaches `ragnarok-stack db`, and
// what does not. The statements themselves are built and tested in
// stack/src/database.rs; here the "supervisor" is a script that records what
// it was asked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDbBridge } = require('../electron/db-bridge');

// Node runs a file called `db` in the working directory, so node itself
// stands in for the supervisor binary: `node db <call> ...`, on every platform.
function fakeStack(behaviour) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-db-bridge-'));
	fs.writeFileSync(path.join(dir, 'db'), `
		const fs = require('node:fs');
		const input = fs.readFileSync(0, 'utf8');
		fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
		${behaviour}
	`);
	const logged = [];
	const bridge = createDbBridge({
		stackBin: () => process.execPath,
		stackEnv: () => ({ cwd: dir, env: process.env }),
		log: line => logged.push(line),
	});
	const calls = () => {
		const file = path.join(dir, 'calls.jsonl');
		return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
	};
	return { bridge, calls, logged };
}

const post = (call, body, headers = {}) => new Request(`ro-tool://db-browser/api/${call}`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', ...headers },
	body: JSON.stringify(body),
});

test('each call runs its verb and hands back the JSON it printed', async () => {
	const { bridge, calls } = fakeStack(`process.stdout.write(JSON.stringify({ ok: process.argv[2] }));`);
	const tables = await bridge(post('tables', {}), 'tables');
	assert.strictEqual(tables.status, 200);
	assert.deepStrictEqual(await tables.json(), { ok: 'tables' });
	await bridge(post('describe', { table: 'char' }), 'describe');
	await bridge(post('rows', { table: 'char', limit: 50, filters: [{ column: 'name', op: 'contains', value: 'Agent' }] }), 'rows');
	const seen = calls();
	assert.deepStrictEqual(seen.map(c => c.args), [['tables'], ['describe', 'char'], ['rows']]);
	assert.deepStrictEqual(JSON.parse(seen[2].input), { table: 'char', limit: 50, filters: [{ column: 'name', op: 'contains', value: 'Agent' }] });
});

test('a save sends only the change list, never anything else the page adds', async () => {
	const { bridge, calls, logged } = fakeStack(`process.stdout.write('{"applied":1,"backup":"b.sql"}');`);
	const changes = [{ table: 'char', key: { char_id: '150000' }, set: { zeny: '5' }, old: { zeny: '1' } }];
	const res = await bridge(post('apply', { changes, sql: 'DROP TABLE login' }), 'apply');
	assert.strictEqual(res.status, 200);
	assert.deepStrictEqual(await res.json(), { applied: 1, backup: 'b.sql' });
	assert.deepStrictEqual(JSON.parse(calls()[0].input), { changes });
	assert.ok(logged.some(l => /saving 1 change/.test(l)) && logged.some(l => /saved 1 change/.test(l)), logged.join('\n'));
});

test('what the supervisor said on failure is what the page shows', async () => {
	const { bridge } = fakeStack(`process.stderr.write('Change 2 of 2: zeny takes a number\\n'); process.exit(1);`);
	const res = await bridge(post('apply', { changes: [] }), 'apply');
	assert.strictEqual(res.status, 502);
	assert.deepStrictEqual(await res.json(), { error: 'Change 2 of 2: zeny takes a number' });
});

test('only a POST from the page itself is answered, and only for the four calls', async () => {
	const { bridge, calls } = fakeStack(`process.stdout.write('{}');`);
	const get = await bridge(new Request('ro-tool://db-browser/api/tables'), 'tables');
	assert.strictEqual(get.status, 405);
	const other = await bridge(post('apply', { changes: [] }, { origin: 'ro-tool://item-browser' }), 'apply');
	assert.strictEqual(other.status, 405);
	assert.strictEqual((await bridge(post('sql', {}), 'sql')).status, 404);
	for (const table of ['char; DROP TABLE login', '../x', '', 7]) {
		assert.strictEqual((await bridge(post('describe', { table }), 'describe')).status, 400, String(table));
	}
	assert.deepStrictEqual(calls(), []);
	const own = await bridge(post('tables', {}, { origin: 'ro-tool://db-browser' }), 'tables');
	assert.strictEqual(own.status, 200);
});

test('one save at a time', async () => {
	const { bridge } = fakeStack(`setTimeout(() => process.stdout.write('{"applied":1}'), 400);`);
	const first = bridge(post('apply', { changes: [{}] }), 'apply');
	await new Promise(r => setTimeout(r, 50));
	const second = await bridge(post('apply', { changes: [{}] }), 'apply');
	assert.strictEqual(second.status, 409);
	assert.strictEqual((await first).status, 200);
	const third = await bridge(post('apply', { changes: [{}] }), 'apply');
	assert.strictEqual(third.status, 200);
});
