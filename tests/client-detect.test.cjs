'use strict';
// Which client the GRFs are (kRO, iRO...), read from the msgstring_<service>.lub
// they ship, for mods that are only for one client's data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectClient, detectAndSave, describe, serviceCodes } = require('../electron/client-detect');

// iRO's data.grf (Sept 2026) and kRO's, as their names list.
const IRO = ['data\\luafiles514\\lua files\\msgstring_us.lub', 'data\\lua files\\msgstring_us.lub', 'data\\prontera.rsw'];
const KRO = ['data\\LuaFiles514\\Lua Files\\msgstring_kr.lub', 'data\\lua files\\msgstring_kr.lub'];

test('the service comes from the msgstring table a GRF ships', () => {
	assert.deepEqual(serviceCodes(IRO), ['us']);
	assert.deepEqual(serviceCodes(KRO), ['kr']);
	assert.deepEqual(serviceCodes(['data\\sprite\\msgstring_us.lub.bak', 'data\\msgstringtable.txt']), []);
});

test('data.grf decides; the others only when it says nothing', () => {
	const grfs = { '/c/data.grf': IRO, '/c/official_data.grf': KRO, '/c/empty.grf': ['data\\x.bmp'] };
	const read = f => { if (!grfs[f]) throw new Error('missing'); return grfs[f]; };
	assert.deepEqual(detectClient({ data_grf: '/c/data.grf', official_grf: '/c/official_data.grf' }, read),
		{ client: 'iRO', code: 'us', from: 'data.grf', problems: [] });
	const fallback = detectClient({ data_grf: '/c/empty.grf', official_grf: '/c/official_data.grf' }, read);
	assert.equal(fallback.client, 'kRO');
	assert.equal(fallback.from, 'official_data.grf');
	const unknown = detectClient({ data_grf: '/c/x.grf' }, () => ['data\\msgstring_zz.lub']);
	assert.equal(unknown.client, null, 'an unknown service names no client');
	assert.equal(unknown.code, 'zz');
	const broken = detectClient({ data_grf: '/c/gone.grf' }, read);
	assert.equal(broken.client, null);
	assert.match(broken.problems[0], /data\.grf: missing/);
});

test('the answer is saved for the supervisor, and described for Settings', () => {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'client-detect-'));
	assert.equal(describe(state).text, 'not detected');
	// A real file, so the stamp has a size and time; its names come from the
	// GRF reader, which this one is not, so detection finds nothing.
	const grf = path.join(state, 'data.grf');
	fs.writeFileSync(grf, 'not a grf');
	const saved = detectAndSave(state, { data_grf: grf });
	assert.equal(saved.client, null);
	assert.ok(fs.existsSync(path.join(state, 'client-detected.json')));
	// What the supervisor reads: { "client": "...", ... }.
	fs.writeFileSync(path.join(state, 'client-detected.json'), JSON.stringify({ client: 'iRO', code: 'us', from: 'data.grf', stamp: saved.stamp }));
	assert.equal(detectAndSave(state, { data_grf: grf }).client, 'iRO', 'unchanged GRFs are not read again');
	assert.equal(describe(state).text, 'iRO (from data.grf)');
});
