// Verify every client bitmap the CompanionPanel references actually exists.
//
// This is the check that was missing when the panel's tabs disappeared: the HTML
// named btn_tab_off.bmp / btn_tab_over.bmp, which do not exist in the client, and
// ui-button with a missing bg renders nothing at all. A build cannot catch that -
// the path is a string - so it is checked here against the running asset server,
// which serves the same GRFs the client reads.
//
// Usage:
//   node tests/companion-panel-assets.test.cjs [http://127.0.0.1:3338]
//
// The server address is discovered from the app's own state when not given. If no
// asset server is running the test SKIPS rather than fails, so it never blocks a
// build in an environment without a client installed.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'patches', 'CompanionPanel.html');

// The interface folder is CP949-encoded in the GRF; the asset server exposes it
// under its percent-encoded name. Observed from the client's own requests.
const UI_DIR = '/data/texture/%C0%AF%C0%FA%C0%CE%C5%CD%C6%E4%C0%CC%BD%BA/';

function discoverPort() {
	// The app writes its http port into the asset log line "Server ready on http://...".
	const state = path.join(os.homedir(), 'AppData', 'Roaming', 'Ragnarok Offline', 'state');
	for (const file of ['assets.log', 'app.log']) {
		const p = path.join(state, file);
		if (!fs.existsSync(p)) continue;
		const m = fs.readFileSync(p, 'utf8').match(/http:\/\/localhost:(\d+)/);
		if (m) return Number(m[1]);
	}
	return null;
}

function head(port, urlPath) {
	return new Promise(resolve => {
		const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 15000 }, res => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on('error', () => resolve(0));
		req.on('timeout', () => { req.destroy(); resolve(0); });
	});
}

/** Every bitmap path the panel references, from both attributes and ui-image src. */
function referencedBitmaps(html) {
	const found = new Set();
	for (const m of html.matchAll(/(?:src|data-background|data-hover|data-down|data-active|bg|hover)="([^"$]+\.(?:bmp|tga|png))"/gi)) {
		found.add(m[1]);
	}
	return [...found];
}

const html = fs.readFileSync(HTML, 'utf8');
const bitmaps = referencedBitmaps(html);
const port = Number(process.argv[2]) || discoverPort();

test('the panel references at least one bitmap', () => {
	assert.ok(bitmaps.length > 0, 'expected the HTML to reference bitmaps');
});

test('every referenced bitmap exists in the client', { skip: port ? false : 'no asset server running' }, async () => {
	const missing = [];
	for (const rel of bitmaps) {
		const code = await head(port, UI_DIR + rel);
		if (code !== 200) missing.push(`${rel} (HTTP ${code || 'no response'})`);
	}
	assert.deepStrictEqual(
		missing,
		[],
		'these bitmap paths do not exist in the client: a ui-button/ui-image with a missing source renders nothing, which is how the panel tabs vanished'
	);
});

test('no invented bitmap families', () => {
	// btn_tab_*.bmp does not exist in the client and was added by mistake once.
	const invented = bitmaps.filter(b => /(^|\/)btn_tab_/.test(b));
	assert.deepStrictEqual(invented, [], 'btn_tab_* bitmaps do not exist in this client');
});
