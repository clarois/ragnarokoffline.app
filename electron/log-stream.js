'use strict';
// The log viewer's live streams (Settings -> Tools, #202).
//
// The page asks for ro-tool://log-viewer/stream?sources=client,map,app and is
// answered with one long-lived Server-Sent Events response. Nothing in the
// page runs anything or reads a file: this module does, and the page only
// ever sees lines -- already redacted, the way Copy diagnostics redacts.
//
// A source is either files, tailed from the end, or a game container, followed
// by `ragnarok-stack logs --follow <service>`. Each source runs only while a
// page is listening to it, and keeps only a short backlog for the next page to
// open; nothing here buffers without limit.

const fs = require('node:fs');
const path = require('node:path');

const BACKLOG = 200;          // lines a newly opened page is given, per source
const POLL_MS = 250;          // how often a tailed file is looked at
const READ_CAP = 1024 * 1024; // the most read from a file in one go
const LINE_CAP = 8 * 1024;    // a longer line is cut
const QUEUE_CAP = 256 * 1024; // bytes a slow page may fall behind before lines are dropped

/**
 * The sources, in the order the page lists them. `files` are relative to the
 * state directory unless they start with `nebula:`, for the engine's logs.
 */
const SOURCES = [
	{ id: 'client', name: 'Game client', files: ['client.log'] },
	{ id: 'map', name: 'Map server', service: 'map' },
	{ id: 'char', name: 'Char server', service: 'char' },
	{ id: 'login', name: 'Login server', service: 'login' },
	{ id: 'db', name: 'Database', service: 'db' },
	{ id: 'app', name: 'App', files: ['app.log'] },
	{ id: 'assets', name: 'Asset server', files: ['assets.log', 'assets/logs/missing-files.log'] },
	{ id: 'engine', name: 'Engine', files: ['nebula:nebulad.log', 'nebula:vessel-console.log', 'nebula:vessel-console.worker-stderr.log'] },
];

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * error | warning | info | debug, from rAthena's tags, the client log's
 * console levels and the engine's tracing levels.
 */
function levelOf(text) {
	const t = stripAnsi(text);
	if (/\[(fatal error|error|sql)\]|\[error\]|^\s*error\b|\bERROR\b|\bpanic(ked)?\b|Uncaught /i.test(t) && !/\b0 errors?\b/i.test(t)) return 'error';
	if (/\[warning\]|\bWARN(ING)?\b|MISSING FILES/i.test(t)) return 'warning';
	if (/\[(debug|verbose)\]|\bDEBUG\b|\bTRACE\b/i.test(t)) return 'debug';
	return 'info';
}

/** A leading ISO timestamp, split off: ["2026-…Z", rest] or [null, text]. */
function splitTime(text) {
	const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s?(.*)$/s.exec(text);
	return m ? [m[1], m[2]] : [null, text];
}

/**
 * The same timestamp, comparable as a string: docker trims trailing zeros
 * from the fraction, so "…:05.1Z" and "…:05.09Z" do not sort as written.
 */
function sortableTime(iso) {
	const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(iso || '');
	return m ? `${m[1]}.${(m[2] || '').padEnd(9, '0').slice(0, 9)}Z` : '';
}

/** Secrets that can reach a log line by a route the app does not redact. */
function redactSecrets(text, secrets = []) {
	let safe = String(text);
	for (const s of secrets.filter(s => s && s.length >= 6).sort((a, b) => b.length - a.length)) safe = safe.split(s).join('[redacted]');
	return safe
		.replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [redacted]')
		.replace(/\b(password|passwd|user_pass|pass|token|secret|confirmation)(["']?\s*[:=]\s*["']?)([^\s"',&;)]+)/gi, '$1$2[redacted]');
}

// ---------------------------------------------------------------------------
// Feeds: one per source, shared by every page listening to it
// ---------------------------------------------------------------------------

class Feed {
	constructor(source, deps) {
		this.source = source;
		this.deps = deps;
		this.backlog = [];
		this.listeners = new Set();
	}

	emit(text, { time = null, level = null, marker = false } = {}) {
		text = String(text).replace(/\r$/, '');
		if (!text.trim() && !marker) return;
		if (text.length > LINE_CAP) text = text.slice(0, LINE_CAP) + ' …';
		text = this.deps.redact(text);
		const event = {
			source: this.source.id,
			time: time || new Date().toISOString(),
			level: marker ? 'marker' : (level || levelOf(text)),
			text,
		};
		this.backlog.push(event);
		if (this.backlog.length > BACKLOG) this.backlog.splice(0, this.backlog.length - BACKLOG);
		for (const listener of this.listeners) listener(event);
	}

	listen(listener) {
		for (const event of this.backlog) listener(event);
		this.listeners.add(listener);
		clearTimeout(this.idle);
		if (!this.started) { this.started = true; this.start(); }
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size) return;
			// Not straight away: a page that changes its sources reconnects,
			// and should find the same backlog rather than a fresh read.
			clearTimeout(this.idle);
			this.idle = setTimeout(() => this.halt(), this.deps.graceMs ?? 20000);
			if (this.idle.unref) this.idle.unref();
		};
	}

	halt() {
		clearTimeout(this.idle);
		if (this.listeners.size || !this.started) return;
		this.started = false;
		this.stop();
	}
}

/** Files, tailed from their end: truncation and rotation start them over. */
class FileFeed extends Feed {
	constructor(source, deps) {
		super(source, deps);
		this.tails = source.files.map(f => ({
			file: f.startsWith('nebula:') ? path.join(deps.nebulaLogsDir(), f.slice(7)) : path.join(deps.stateDir(), f),
			name: path.basename(f.replace(/^nebula:/, '')),
			pos: null, ino: null, rest: '',
		}));
		this.timer = null;
	}

	start() {
		// Backlog only the first time: a restarted feed keeps what it had.
		const fresh = !this.backlog.length;
		for (const t of this.tails) this.open(t, true, fresh);
		this.timer = setInterval(() => { for (const t of this.tails) this.poll(t); }, this.deps.pollMs || POLL_MS);
		if (this.timer.unref) this.timer.unref();
	}

	stop() {
		clearInterval(this.timer);
		this.timer = null;
		// The next page starts from the backlog and the end of the file.
		for (const t of this.tails) { t.pos = null; t.rest = ''; }
	}

	// The first look: the last lines as a backlog, then follow from the end.
	open(t, first, fresh) {
		let st;
		try { st = fs.statSync(t.file); } catch { t.pos = null; return; }
		t.ino = st.ino;
		if (!first) { t.pos = 0; t.rest = ''; return; }
		const from = Math.max(0, st.size - 64 * 1024);
		const lines = this.read(t, from, st.size).split('\n');
		if (from > 0) lines.shift(); // torn by where the read began
		if (lines[lines.length - 1] === '') lines.pop();
		if (fresh) for (const line of lines.slice(-Math.floor(BACKLOG / this.tails.length))) this.line(t, line);
		t.pos = st.size;
		t.rest = '';
	}

	read(t, from, to) {
		const length = Math.min(to - from, READ_CAP);
		if (length <= 0) return '';
		const buf = Buffer.alloc(length);
		const fd = fs.openSync(t.file, 'r');
		try { fs.readSync(fd, buf, 0, length, to - length); } finally { fs.closeSync(fd); }
		return buf.toString('utf8');
	}

	poll(t) {
		let st;
		try { st = fs.statSync(t.file); } catch {
			// Gone for now (rotated away, not written yet); picked up when back.
			if (t.pos !== null) { t.pos = null; t.rest = ''; }
			return;
		}
		if (t.pos === null) { t.ino = st.ino; t.pos = 0; t.rest = ''; }
		// Replaced (a new inode) or truncated (client.log is, every run).
		const replaced = t.ino && st.ino && st.ino !== t.ino;
		if (replaced || st.size < t.pos) {
			this.emit(`— ${t.name} started over —`, { marker: true });
			t.ino = st.ino; t.pos = 0; t.rest = '';
		}
		if (st.size <= t.pos) return;
		let from = t.pos;
		if (st.size - from > READ_CAP) {
			this.emit(`— ${Math.round((st.size - from - READ_CAP) / 1024)} KB of ${t.name} skipped —`, { marker: true });
			from = st.size - READ_CAP;
			t.rest = '';
		}
		let text;
		try { text = t.rest + this.read(t, from, st.size); } catch { return; }
		t.pos = st.size;
		const lines = text.split('\n');
		t.rest = lines.pop();
		if (t.rest.length > LINE_CAP) { lines.push(t.rest); t.rest = ''; }
		for (const line of lines) this.line(t, line);
	}

	line(t, raw) {
		if (t.name === 'missing-files.log') {
			// One JSON object a line: say which file, not the whole record.
			try {
				const o = JSON.parse(raw);
				return this.emit(`missing: ${o.requestedPath}`, { time: o.timestamp, level: 'warning' });
			} catch { /* a torn line: shown as it is */ }
		}
		const [time, text] = splitTime(raw.replace(/\r$/, ''));
		this.emit(this.tails.length > 1 ? `${t.name}: ${text}` : text, { time });
	}
}

/** A game container, followed by the supervisor; reconnects by itself. */
class ServiceFeed extends Feed {
	constructor(source, deps) {
		super(source, deps);
		this.child = null;
		this.retry = null;
		this.running = false;
		this.state = 'init'; // init | up | down
		this.everUp = false;
		this.last = '';      // newest timestamp seen, sortable
		this.delay = this.firstDelay = deps.retryMs || 1000;
	}

	start() {
		this.running = true;
		this.spawn();
	}

	stop() {
		this.running = false;
		clearTimeout(this.retry);
		this.retry = null;
		if (this.child) kill(this.child, this.deps.spawn);
		this.child = null;
		// A new page starts with a new backlog of its own.
		this.backlog = [];
		this.last = '';
		this.state = 'init';
		this.everUp = false;
	}

	spawn() {
		if (!this.running) return;
		const { cwd, env } = this.deps.stackEnv();
		// The whole backlog the first time, and a little more than a
		// reconnect should need after that; timestamps drop the overlap.
		const tail = this.last ? '400' : String(BACKLOG);
		let child;
		try {
			child = this.deps.spawn(this.deps.stackBin(), ['logs', '--follow', this.source.service, '--tail', tail], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
				// Its own process group, so stopping it stops the engine
				// client it runs as well (see kill).
				detached: process.platform !== 'win32' });
		} catch (e) {
			this.emit(`— could not follow the ${this.source.name.toLowerCase()}: ${e.message} —`, { marker: true });
			return this.later();
		}
		this.child = child;
		// Per follow: the time of the last stamped line, and whether it was
		// a repeat dropped as overlap (see line()).
		this.stamp = null;
		this.repeat = false;
		let rest = { stdout: '', stderr: '' };
		const take = which => chunk => {
			const lines = (rest[which] + chunk.toString('utf8')).split('\n');
			rest[which] = lines.pop();
			for (const line of lines) this.line(line);
		};
		child.stdout.on('data', take('stdout'));
		child.stderr.on('data', take('stderr'));
		child.on('error', () => {});
		child.on('close', code => {
			if (rest.stdout) this.line(rest.stdout);
			if (rest.stderr) this.line(rest.stderr);
			if (this.child !== child) return;
			this.child = null;
			if (!this.running) return;
			// 0: the container stopped. 3: the stream broke with it still up,
			// which is not worth a marker. 4 (or anything else): no container.
			if (code === 0 && this.state === 'up') this.mark('stopped');
			else if (code !== 0 && code !== 3 && this.state !== 'down') this.mark(this.state === 'up' ? 'stopped' : 'not running');
			this.later(code === 3 ? 500 : undefined);
		});
	}

	later(delay) {
		if (!this.running) return;
		clearTimeout(this.retry);
		this.retry = setTimeout(() => this.spawn(), Math.min(delay ?? this.delay, this.delay));
		if (this.retry.unref) this.retry.unref();
		this.delay = Math.min(this.delay * 2, this.firstDelay * 5);
	}

	mark(what) {
		const name = this.source.name.toLowerCase();
		if (what === 'up') {
			this.emit(`— ${name} ${this.everUp ? 'restarted' : 'started'} —`, { marker: true });
		} else {
			this.emit(`— ${name} ${what} —`, { marker: true });
		}
		this.state = what === 'up' ? 'up' : 'down';
		if (what === 'up') this.everUp = true;
	}

	line(raw) {
		// rAthena redraws a progress line in place ("Loading 'x'...\r"), and
		// docker stamps each piece after a \r as it would a new line. What a
		// terminal would show is the last piece, so that is the line.
		raw = raw.split('\r').filter(piece => piece.trim()).pop() || '';
		const [time, text] = splitTime(raw);
		if (!time) {
			if (!raw.trim()) return;
			// Docker stamps a write, not a line: when rAthena writes two lines
			// at once the second comes unstamped. It belongs with the line
			// before it, repeat or not.
			if (this.stamp) {
				if (!this.repeat) this.emit(raw, { time: this.stamp });
				return;
			}
			// Nothing from the container yet: the supervisor's own complaint.
			this.emit(raw, { level: 'warning' });
			return;
		}
		this.stamp = time;
		const key = sortableTime(time);
		this.repeat = !!key && key <= this.last;
		if (this.repeat) return; // already shown before a reconnect
		if (this.state !== 'up') {
			// Lines from a container we had seen stop: it came back.
			if (this.state === 'down') this.mark('up');
			else { this.state = 'up'; this.everUp = true; }
		}
		this.delay = this.firstDelay;
		this.last = key;
		this.emit(text, { time });
	}
}

/**
 * The follow and the `docker logs -f` it runs: that one would otherwise
 * carry on until its container next wrote a line into a closed pipe.
 */
function kill(child, spawn) {
	try {
		if (process.platform === 'win32') {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
		} else if (child.pid) {
			process.kill(-child.pid, 'SIGTERM');
		} else {
			child.kill();
		}
	} catch {
		try { child.kill(); } catch { /* already gone */ }
	}
}

// ---------------------------------------------------------------------------
// The SSE response
// ---------------------------------------------------------------------------

function sse(event) {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * @param {object} deps
 *   stateDir(), nebulaLogsDir(), stackBin(), stackEnv(), redact(text),
 *   spawn (child_process.spawn), pollMs?
 */
function createLogStreams(deps) {
	const feeds = new Map();
	const d = { spawn: require('node:child_process').spawn, ...deps };

	function feed(id) {
		if (!feeds.has(id)) {
			const source = SOURCES.find(s => s.id === id);
			if (!source) return null;
			feeds.set(id, source.service ? new ServiceFeed(source, d) : new FileFeed(source, d));
		}
		return feeds.get(id);
	}

	/** Listen to some sources; returns the function that stops listening. */
	function subscribe(ids, listener) {
		const stops = [];
		for (const id of new Set(ids)) {
			const f = feed(id);
			if (f) stops.push(f.listen(listener));
		}
		return () => { for (const stop of stops.splice(0)) stop(); };
	}

	/** The body of the /stream response. */
	function stream(ids) {
		let unsubscribe = null;
		let ping = null;
		let dropped = 0;
		const cleanup = () => {
			clearInterval(ping);
			if (unsubscribe) unsubscribe();
			unsubscribe = null;
		};
		return new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				const send = text => {
					try { controller.enqueue(encoder.encode(text)); } catch { cleanup(); }
				};
				send(`retry: 2000\n: ${SOURCES.map(s => s.id).join(',')}\n\n`);
				unsubscribe = subscribe(ids, event => {
					// A page that does not keep up loses lines, not memory.
					if (controller.desiredSize !== null && controller.desiredSize < -QUEUE_CAP) { dropped++; return; }
					if (dropped) {
						send(sse({ source: event.source, time: event.time, level: 'marker', text: `— ${dropped} lines dropped: the window fell behind —` }));
						dropped = 0;
					}
					send(sse(event));
				});
				// Keeps the connection honest, and finds a closed page.
				ping = setInterval(() => send(': ping\n\n'), 15000);
				if (ping.unref) ping.unref();
			},
			cancel() { cleanup(); },
		}, { highWaterMark: QUEUE_CAP, size: chunk => chunk.byteLength });
	}

	function response(url) {
		const wanted = (url.searchParams.get('sources') || '').split(',').map(s => s.trim()).filter(Boolean);
		const ids = wanted.length ? wanted.filter(id => SOURCES.some(s => s.id === id)) : SOURCES.map(s => s.id);
		return new Response(stream(ids), {
			headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
		});
	}

	function stopAll() { for (const f of feeds.values()) { f.listeners.clear(); f.halt(); } }
	// Followers run in their own process groups, which an exiting app does
	// not take down with it.
	if (!deps.keepOnExit) process.once('exit', stopAll);

	return { subscribe, stream, response, stopAll, sources: () => SOURCES.map(({ id, name }) => ({ id, name })) };
}

module.exports = { createLogStreams, SOURCES, levelOf, splitTime, sortableTime, redactSecrets, stripAnsi };
