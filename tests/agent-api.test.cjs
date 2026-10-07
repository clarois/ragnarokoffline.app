'use strict';
// The AI agent's local API (#187): who may call it, and that MCP and the
// command route reach the same commands with the same arguments.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createAgentApi, positional, toolList } = require('../electron/agent-api');

const TOKEN = 'a'.repeat(64);

function request(port, { path = '/v1/command', body, token = TOKEN, host, origin } = {}) {
	return new Promise((resolve, reject) => {
		const text = JSON.stringify(body ?? {});
		const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), host: host || `127.0.0.1:${port}` };
		if (token) headers.authorization = `Bearer ${token}`;
		if (origin) headers.origin = origin;
		const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers }, res => {
			let data = '';
			res.on('data', c => { data += c; });
			res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
		});
		req.on('error', reject);
		req.end(text);
	});
}

async function withApi(run, fn) {
	const api = createAgentApi({ run, token: TOKEN });
	const port = await api.listen(0);
	try { await fn(port); } finally { await api.close(); }
}

test('a request without the token, with another Host, or from a web page is refused', async () => {
	let ran = 0;
	await withApi(async () => { ran++; return { ok: true }; }, async port => {
		assert.strictEqual((await request(port, { body: { cmd: 'state' }, token: null })).status, 401);
		assert.strictEqual((await request(port, { body: { cmd: 'state' }, token: 'b'.repeat(64) })).status, 401);
		// DNS rebinding: a page on evil.example resolving to 127.0.0.1.
		assert.strictEqual((await request(port, { body: { cmd: 'state' }, host: `evil.example:${port}` })).status, 403);
		assert.strictEqual((await request(port, { body: { cmd: 'state' }, origin: 'https://evil.example' })).status, 403);
		assert.strictEqual(ran, 0);
		assert.strictEqual((await request(port, { body: { cmd: 'state' } })).status, 200);
		assert.strictEqual(ran, 1);
	});
});

test('the command route runs known commands with their arguments and nothing else', async () => {
	const calls = [];
	await withApi(async (cmd, args) => { calls.push([cmd, args]); return { ok: true }; }, async port => {
		assert.strictEqual((await request(port, { body: { cmd: 'walk', args: ['150', 180] } })).status, 200);
		assert.deepStrictEqual(calls, [['walk', ['150', '180']]]);
		const unknown = await request(port, { body: { cmd: 'eval', args: ['1'] } });
		assert.strictEqual(unknown.status, 400);
		assert.ok(unknown.body.commands.includes('walk'));
		assert.strictEqual(calls.length, 1);
	});
});

test('MCP initializes, lists every command as a tool, and maps named arguments', async () => {
	const calls = [];
	await withApi(async (cmd, args) => {
		calls.push([cmd, args]);
		return cmd === 'shot' ? { file: '/tmp/x.png', png: Buffer.from('png') } : { ok: true };
	}, async port => {
		const init = await request(port, { path: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } } });
		assert.strictEqual(init.body.result.protocolVersion, '2025-03-26');
		assert.ok(init.body.result.capabilities.tools);
		const note = await request(port, { path: '/mcp', body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
		assert.strictEqual(note.status, 202);
		const list = await request(port, { path: '/mcp', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
		const names = list.body.result.tools.map(t => t.name);
		for (const name of ['login', 'char', 'state', 'walk', 'attack', 'interact', 'choose', 'skill', 'equip', 'use', 'shot', 'say']) assert.ok(names.includes(name), name);
		assert.ok(!names.includes('eval'));
		const skill = await request(port, { path: '/mcp', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skill', arguments: { id: 5, rest: '10 --target nearest' } } } });
		assert.ok(!skill.body.result.isError);
		assert.deepStrictEqual(calls.at(-1), ['skill', ['5', '10', '--target', 'nearest']]);
		const shot = await request(port, { path: '/mcp', body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shot', arguments: {} } } });
		assert.strictEqual(shot.body.result.content[0].type, 'image');
		assert.strictEqual(shot.body.result.content[0].data, Buffer.from('png').toString('base64'));
		const bad = await request(port, { path: '/mcp', body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'eval', arguments: {} } } });
		assert.ok(bad.body.error);
	});
});

test('commands run one at a time, in order', async () => {
	const order = [];
	await withApi(async cmd => {
		order.push(`start ${cmd}`);
		await new Promise(r => setTimeout(r, cmd === 'walk' ? 80 : 5));
		order.push(`end ${cmd}`);
		return { ok: true };
	}, async port => {
		await Promise.all([
			request(port, { body: { cmd: 'walk', args: ['1', '2'] } }),
			request(port, { body: { cmd: 'state' } }),
		]);
		assert.deepStrictEqual(order, ['start walk', 'end walk', 'start state', 'end state']);
	});
});

test('say and create keep their text; required arguments are marked', () => {
	assert.deepStrictEqual(positional('say', { text: 'hello there' }), ['hello', 'there']);
	assert.deepStrictEqual(positional('create', { slot: 0, name: 'Agent Smith' }), ['0', 'Agent', 'Smith']);
	const walk = toolList().find(t => t.name === 'walk');
	assert.deepStrictEqual(walk.inputSchema.required, ['x', 'y']);
	const state = toolList().find(t => t.name === 'state');
	assert.deepStrictEqual(state.inputSchema.required, []);
});

test('several agents: each has its own MCP route and queue, and none beyond the allowed number', async () => {
	const calls = [];
	const api = createAgentApi({ token: TOKEN, agents: () => 2, run: async (cmd, args, n) => {
		calls.push(`start ${n} ${cmd}`);
		await new Promise(r => setTimeout(r, cmd === 'walk' ? 80 : 5));
		calls.push(`end ${n} ${cmd}`);
		return { ok: true, agent: n };
	} });
	const port = await api.listen(0);
	try {
		const call = (path, name) => request(port, { path, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } } });
		const two = await call('/mcp/2', 'state');
		assert.strictEqual(JSON.parse(two.body.result.content[0].text).agent, 2);
		assert.strictEqual((await call('/mcp/3', 'state')).status, 404);
		const init = await request(port, { path: '/mcp/2', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
		assert.match(init.body.result.instructions, /"aiagent2"/);
		const cli = await request(port, { body: { cmd: 'state', agent: 2 } });
		assert.strictEqual(cli.body.agent, 2);
		assert.strictEqual((await request(port, { body: { cmd: 'state', agent: 3 } })).status, 400);
		// Agent 1's long walk does not hold agent 2's state.
		calls.length = 0;
		await Promise.all([
			request(port, { body: { cmd: 'walk', args: ['1', '2'], agent: 1 } }),
			request(port, { body: { cmd: 'state', agent: 2 } }),
		]);
		assert.ok(calls.indexOf('end 2 state') < calls.indexOf('end 1 walk'), calls.join(', '));
	} finally { await api.close(); }
});
