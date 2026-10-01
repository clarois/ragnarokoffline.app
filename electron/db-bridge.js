'use strict';
// The database browser's one way into the app (#200).
//
// The page (tools/db-browser/) is generic: it is written against an adapter
// of four calls, { tables, describe, rows, apply }, and knows nothing about
// Ragnarok Offline. Its adapter here posts each call to
// ro-tool://db-browser/api/<call>, and this answers it by running
// `ragnarok-stack db <call>`, which does the database work: the page never
// sends SQL for a write, only the change list, and the supervisor builds the
// statements (stack/src/database.rs).
//
// `apply` stops the game, takes a backup, applies and starts it again, the way
// `sql --write` does. Only one runs at a time.

const { spawn } = require('node:child_process');

const CALLS = new Set(['tables', 'describe', 'rows', 'apply']);
const MAX_REQUEST = 4 * 1024 * 1024;
const MAX_ANSWER = 32 * 1024 * 1024;

function runDb(deps, args, input, timeoutMs) {
	const { cwd, env } = deps.stackEnv();
	return new Promise((resolve, reject) => {
		const child = spawn(deps.stackBin(), ['db', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const out = [];
		let outBytes = 0;
		let err = '';
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error); else resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error('The database did not answer in time.'));
		}, timeoutMs);
		child.stdout.on('data', chunk => {
			outBytes += chunk.length;
			if (outBytes > MAX_ANSWER) { child.kill(); finish(new Error('The answer was too large. Ask for fewer rows.')); return; }
			out.push(chunk);
		});
		child.stderr.on('data', chunk => { if (err.length < 16384) err += chunk; });
		child.on('error', error => finish(error));
		child.on('close', code => {
			if (code === 0) finish(null, Buffer.concat(out).toString('utf8'));
			else finish(new Error(err.trim() || `ragnarok-stack db exited with ${code}`));
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input || '');
	});
}

function json(body, status = 200) {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

/**
 * @param {object} deps  stackBin(), stackEnv(), log(text)
 * @returns {(request: Request, call: string) => Promise<Response>}
 */
function createDbBridge(deps) {
	let saving = false;

	return async function handle(request, call) {
		// Only the page itself, and only by POST with a JSON body: a page on
		// another origin cannot send that without a preflight nobody answers.
		const origin = request.headers.get('origin');
		if (request.method !== 'POST' || (origin && origin !== 'ro-tool://db-browser')) return json({ error: 'not allowed' }, 405);
		if (!CALLS.has(call)) return json({ error: 'no such call' }, 404);
		const text = await request.text();
		if (text.length > MAX_REQUEST) return json({ error: 'That request is too large. Save fewer changes at a time.' }, 413);
		let body;
		try { body = text ? JSON.parse(text) : {}; } catch { return json({ error: 'The request is not valid JSON.' }, 400); }
		try {
			if (call === 'tables') return json(await runDb(deps, ['tables'], '', 60000));
			if (call === 'describe') {
				if (typeof body.table !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(body.table)) return json({ error: 'Which table?' }, 400);
				return json(await runDb(deps, ['describe', body.table], '', 60000));
			}
			if (call === 'rows') return json(await runDb(deps, ['rows'], JSON.stringify(body), 120000));
			// apply
			if (saving) return json({ error: 'A save is already under way.' }, 409);
			saving = true;
			const count = Array.isArray(body.changes) ? body.changes.length : 0;
			deps.log(`tools: database: saving ${count} change(s); the game stops while it does`);
			try {
				const answer = await runDb(deps, ['apply'], JSON.stringify({ changes: body.changes }), 10 * 60000);
				deps.log(`tools: database: saved ${count} change(s)`);
				return json(answer);
			} catch (e) {
				deps.log(`tools: database: save failed: ${e.message}`);
				throw e;
			} finally {
				saving = false;
			}
		} catch (e) {
			return json({ error: e.message }, 502);
		}
	};
}

module.exports = { createDbBridge };
