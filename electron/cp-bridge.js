'use strict';
// The Control panel's one way into the app (#230).
//
// The page (tools/control-panel/) posts each call to
// ro-tool://control-panel/api/<call>, and this answers it:
//
//   characters, character               `ragnarok-stack cp`, read-only, live
//   reset-position, delete-character    `ragnarok-stack cp`, one at a time,
//                                       in the app's server-operation queue
//   create-account                      the Accounts tab's own `accounts
//                                       create`, through the same handler
//   context                             host or join, and the era
//
// The page never sends SQL, only an action and a character id; the
// supervisor builds every statement (stack/src/control_panel.rs).
//
// Writes go through `deps.serverOperation`, main.js's queue, so a move or a
// delete never lands halfway through a start, an era switch or a restore.
// The supervisor's operation lock would refuse one anyway; the queue makes it
// wait its turn instead. (The Database tool's saves do not queue: they only
// meet that lock. This bridge does not change that.)

const { runStack } = require('./db-bridge');

const READS = new Set(['characters', 'character']);
const WRITES = new Set(['reset-position', 'delete-character']);
const MAX_REQUEST = 4096;

function json(body, status = 200) {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

/** One `ragnarok-stack cp` request. It answers JSON either way, errors included. */
async function runCp(deps, request, timeoutMs) {
	const { code, out } = await runStack(deps, ['cp'], JSON.stringify(request), timeoutMs);
	let answer;
	try { answer = JSON.parse(out); } catch { throw new Error(code === 0 ? 'The control panel could not read the answer.' : `ragnarok-stack cp exited with ${code}`); }
	if (code !== 0 || answer.error) throw new Error(typeof answer.error === 'string' ? answer.error : `ragnarok-stack cp exited with ${code}`);
	return answer;
}

// Only what each action takes, so nothing else the page sends reaches the
// supervisor.
function pick(call, body) {
	const id = body.char_id;
	if (typeof id !== 'string' && typeof id !== 'number') return null;
	if (call === 'character') return { action: call, char_id: String(id) };
	if (call === 'reset-position') {
		const t = body.target;
		if (t === 'save') return { action: call, char_id: String(id), target: 'save' };
		if (t && typeof t === 'object' && typeof t.map === 'string') return { action: call, char_id: String(id), target: { map: t.map, x: t.x, y: t.y } };
		return null;
	}
	if (call === 'delete-character') return typeof body.name === 'string' ? { action: call, char_id: String(id), name: body.name } : null;
	return null;
}

/**
 * @param {object} deps
 *   stackBin(), stackEnv(), log(text),
 *   serverOperation(run, { stopsGame }) -> Promise   main.js's queue
 *   createAccount({ username, password, confirmation }) -> Promise   `accounts create`
 *   context() -> { host, era }
 * @returns {(request: Request, call: string) => Promise<Response>}
 */
function createCpBridge(deps) {
	let writing = false;

	return async function handle(request, call) {
		// Only the page itself, and only by POST with a JSON body, as the
		// Database tool's bridge does.
		const origin = request.headers.get('origin');
		if (request.method !== 'POST' || (origin && origin !== 'ro-tool://control-panel')) return json({ error: 'not allowed' }, 405);
		if (!READS.has(call) && !WRITES.has(call) && call !== 'create-account' && call !== 'context') return json({ error: 'no such call' }, 404);
		const text = await request.text();
		if (text.length > MAX_REQUEST) return json({ error: 'That request is too large.' }, 413);
		let body;
		try { body = text ? JSON.parse(text) : {}; } catch { return json({ error: 'The request is not valid JSON.' }, 400); }
		if (!body || typeof body !== 'object') return json({ error: 'The request is not valid JSON.' }, 400);
		try {
			if (call === 'context') return json(deps.context());
			if (call === 'characters') return json(await runCp(deps, { action: 'characters' }, 60000));
			const asked = call === 'create-account' ? null : pick(call, body);
			if (call !== 'create-account' && !asked) return json({ error: 'Which character?' }, 400);
			if (call === 'character') return json(await runCp(deps, asked, 60000));
			// A write: one at a time from this window. A second press while one
			// runs is refused rather than queued behind it, so the page never
			// acts on a list that the first one changed.
			if (writing) return json({ error: 'A change is already under way.' }, 409);
			writing = true;
			try {
				if (call === 'create-account') {
					const { username, password, confirmation } = body;
					if (![username, password, confirmation].every(v => typeof v === 'string')) return json({ error: 'Fill in the account name and the password twice.' }, 400);
					if (!deps.context().host) return json({ error: 'Accounts belong to the host. Switch to your own server to manage them.' }, 409);
					// Never logged with the password: only the name.
					deps.log(`tools: control panel: creating account ${username}`);
					return json(await deps.createAccount({ username, password, confirmation }));
				}
				const stopsGame = call === 'delete-character';
				deps.log(`tools: control panel: ${call} ${asked.char_id}${stopsGame ? '; the game stops while it does' : ''}`);
				const answer = await deps.serverOperation(() => runCp(deps, asked, stopsGame ? 10 * 60000 : 60000), { stopsGame });
				deps.log(`tools: control panel: ${call} ${asked.char_id} done`);
				return json(answer);
			} catch (e) {
				deps.log(`tools: control panel: ${call} failed: ${e.message}`);
				throw e;
			} finally {
				writing = false;
			}
		} catch (e) {
			return json({ error: e.message }, 502);
		}
	};
}

module.exports = { createCpBridge, runCp };
