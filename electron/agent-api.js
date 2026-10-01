'use strict';
// The local API an AI agent plays through (#187): one HTTP listener on
// 127.0.0.1, two ways in.
//
//   POST /v1/command   {"cmd": "walk", "args": ["150", "180"], "agent": 2}  -- the CLI
//   POST /mcp          MCP, streamable HTTP, JSON responses, agent 1       -- MCP clients
//   POST /mcp/<n>      the same for agent n, when the player allows several
//
// Both need `Authorization: Bearer <token>`. The token and port are written to
// a file only the user can read (see agent-play.js), so another user on the
// machine cannot drive the player's game, and a web page cannot either: a
// browser request carries an Origin, and one that names any Host but ours is
// refused, which is what stops DNS rebinding.
//
// MCP is hand-rolled, as the rest of the app's protocols are: the whole of what
// a tool server needs is initialize, tools/list and tools/call.

const http = require('node:http');
const crypto = require('node:crypto');
const { COMMANDS } = require('./agent-driver');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LIMIT = 64 * 1024;

function equal(a, b) {
	const x = Buffer.from(String(a)), y = Buffer.from(String(b));
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Named MCP arguments to the positional ones the commands take.
function positional(cmd, input) {
	const spec = COMMANDS[cmd];
	const args = [];
	for (const [name] of spec.args) {
		const v = input?.[name];
		if (v === undefined || v === null || v === '') continue;
		if (name === 'rest' || name === 'text' || name === 'name') args.push(...String(v).split(/\s+/).filter(Boolean));
		else args.push(String(v));
	}
	return args;
}

function toolList() {
	return Object.entries(COMMANDS).map(([name, spec]) => ({
		name,
		description: spec.description,
		inputSchema: {
			type: 'object',
			properties: Object.fromEntries(spec.args.map(([arg, type, description]) => [arg, { type, description }])),
			required: spec.args.filter(a => !a[3]).map(a => a[0]),
			additionalProperties: false,
		},
	}));
}

/**
 * @param {object} opts
 *   run(cmd, args, agent) -> Promise<result>  runs one command against one agent's game
 *   token                                     the bearer token
 *   agents() -> number                        how many agents the player allows
 *   log(text)
 */
function createAgentApi({ run, token, agents = () => 1, log = () => {} }) {
	// One command at a time per agent: each game has one mouse. Different
	// agents play side by side.
	const queues = new Map();
	const exec = (cmd, args, n) => {
		const queue = queues.get(n) || Promise.resolve();
		const next = queue.then(() => run(cmd, args, n), () => run(cmd, args, n));
		queues.set(n, next.catch(() => {}));
		return next;
	};

	async function mcp(message, n) {
		const { id, method, params } = message;
		const reply = result => ({ jsonrpc: '2.0', id, result });
		const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
		switch (method) {
			case 'initialize': {
				const asked = params?.protocolVersion;
				return reply({
					protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'ragnarok-offline', title: 'Ragnarok Offline', version: '1' },
					instructions: `You are playing Ragnarok Online on the player's own server, in your own game window, as the account "${n === 1 ? 'aiagent' : 'aiagent' + n}". Start with login, then characters, then char (or create). Use state often: it includes chat said to you or near you. Use shot when you need to see. Read AGENT.md for how to play well.`,
				});
			}
			case 'ping': return reply({});
			case 'tools/list': return reply({ tools: toolList() });
			case 'tools/call': {
				const name = params?.name;
				if (!COMMANDS[name]) return fail(-32602, `unknown tool ${name}`);
				try {
					const result = await exec(name, positional(name, params.arguments || {}), n);
					if (name === 'shot') {
						return reply({ content: [
							result.jpeg
								? { type: 'image', data: result.jpeg.toString('base64'), mimeType: 'image/jpeg' }
								: { type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' },
							{ type: 'text', text: JSON.stringify({ file: result.file }) },
						] });
					}
					return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
				} catch (e) {
					return reply({ content: [{ type: 'text', text: e.message }], isError: true });
				}
			}
			default:
				return id === undefined ? null : fail(-32601, `method not found: ${method}`);
		}
	}

	const server = http.createServer((req, res) => {
		const send = (code, body, headers = {}) => {
			const text = body === undefined ? '' : JSON.stringify(body);
			res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
			res.end(text);
		};
		const port = server.address()?.port;
		const hostOk = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
		const origin = req.headers.origin;
		if (!hostOk || (origin && origin !== 'null' && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) return send(403, { error: 'forbidden' });
		const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
		if (!auth || !equal(auth[1], token)) return send(401, { error: 'missing or wrong token; see the connection file' }, { 'www-authenticate': 'Bearer' });
		const route = /^\/mcp(?:\/([1-9]))?$/.exec(req.url);
		if (req.method !== 'POST' || !(route || req.url === '/v1/command')) return send(405, { error: 'POST /v1/command or /mcp' }, { allow: 'POST' });
		const mcpAgent = route ? Number(route[1] || 1) : null;
		if (mcpAgent && mcpAgent > agents()) return send(404, { error: `there is no agent ${mcpAgent}; the player allowed ${agents()}` });

		let size = 0;
		const chunks = [];
		req.on('data', c => { size += c.length; if (size > LIMIT) req.destroy(); else chunks.push(c); });
		req.on('end', async () => {
			let body;
			try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'not JSON' }); }
			if (req.url === '/v1/command') {
				const { cmd, args } = body;
				const n = body.agent === undefined ? 1 : Number(body.agent);
				if (!Number.isInteger(n) || n < 1 || n > agents()) return send(400, { error: `there is no agent ${body.agent}; the player allowed ${agents()}` });
				if (!COMMANDS[cmd]) return send(400, { error: `unknown command ${cmd}`, commands: Object.keys(COMMANDS) });
				if (args !== undefined && (!Array.isArray(args) || args.some(a => typeof a !== 'string' && typeof a !== 'number'))) return send(400, { error: 'args must be a list of strings' });
				log(`agent ${n}: ${cmd} ${JSON.stringify(args || [])}`);
				try {
					const out = await exec(cmd, (args || []).map(String), n);
					if (cmd === 'shot') return send(200, { file: out.file });
					return send(200, out);
				} catch (e) {
					return send(500, { error: e.message });
				}
			}
			// MCP: one message or a batch; notifications get no reply.
			const messages = Array.isArray(body) ? body : [body];
			if (messages.some(m => m?.method === 'tools/call')) log(`agent ${mcpAgent} (mcp): ${messages.filter(m => m?.method === 'tools/call').map(m => m.params?.name).join(', ')}`);
			const replies = (await Promise.all(messages.map(m => mcp(m || {}, mcpAgent)))).filter(Boolean);
			if (!replies.length) return send(202);
			return send(200, Array.isArray(body) ? replies : replies[0]);
		});
	});

	return {
		listen: (port = 0) => new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => resolve(server.address().port));
		}),
		close: () => new Promise(resolve => server.close(() => resolve())),
		server,
	};
}

module.exports = { createAgentApi, positional, toolList };
