'use strict';
// Which client the player's GRFs come from: kRO, iRO, bRO...
//
// Mods can be written for one client's data (an iteminfo.lua made for kRO's
// item tables overwrites iRO's), so mod.json can say which clients a mod is
// for (`requires.client`) and give each one a folder (`clientFolders`). The
// supervisor reads the answer from state/client-detected.json, written here
// each time the client is indexed.
//
// The service is in the file names: every client ships its message table as
// `msgstring_<service>.lub` -- msgstring_kr.lub in kRO's data.grf,
// msgstring_us.lub in iRO's. The GRF's signature can't tell them apart: iRO's
// data.grf says "Event Horizon" (GRF Editor's) and its event.grf "Master of
// Magic", the same as kRO's.

const fs = require('node:fs');
const path = require('node:path');
const { grfNames } = require('./ui-skin');

// The services whose code is known. Anything else is reported by its code,
// and refuses no mod.
const SERVICES = {
	kr: 'kRO', us: 'iRO', br: 'bRO', jp: 'jRO', tw: 'twRO', th: 'thRO',
	id: 'idRO', ph: 'pRO', ru: 'ruRO', cn: 'cRO', vn: 'vRO',
};

const MSGSTRING = /(?:^|\\)msgstring_([a-z]{2,4})\.lub$/i;

/** The service codes a GRF's file names point to, most common first. */
function serviceCodes(names) {
	const counts = new Map();
	for (const name of names) {
		const m = MSGSTRING.exec(name);
		if (m) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) || 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

/**
 * The client, from the GRFs in the order the client reads them: data.grf
 * decides, then the others if it says nothing. `read(file)` lists a GRF's
 * names (grfNames; a parameter for the tests).
 */
function detectClient(paths, read = grfNames) {
	const order = [['data.grf', paths.data_grf], ['rdata.grf', paths.rdata_grf], ['official_data.grf', paths.official_grf]];
	const problems = [];
	for (const [label, file] of order) {
		if (!file) continue;
		let names;
		try { names = read(file); } catch (e) { problems.push(`${label}: ${e.message}`); continue; }
		const [code] = serviceCodes(names);
		if (code) return { client: SERVICES[code] || null, code, from: label, problems };
	}
	return { client: null, code: null, from: null, problems };
}

/**
 * Detect, and record it for the supervisor and Settings. Skipped when the
 * GRFs are the ones already detected (same paths, sizes and times): reading a
 * data.grf's table takes a moment, and this runs on every start.
 */
function detectAndSave(stateDir, paths, log = () => {}) {
	const file = path.join(stateDir, 'client-detected.json');
	const stamp = ['data_grf', 'rdata_grf', 'official_grf'].map(k => {
		if (!paths[k]) return `${k}:`;
		try { const st = fs.statSync(paths[k]); return `${k}:${paths[k]}:${st.size}:${st.mtimeMs}`; } catch { return `${k}:${paths[k]}:missing`; }
	}).join('|');
	try {
		const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (saved.stamp === stamp) return saved;
	} catch { /* none yet */ }
	const found = detectClient(paths);
	const out = { client: found.client, code: found.code, from: found.from, stamp };
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
	log(found.client
		? `client: ${found.client} (msgstring_${found.code}.lub in ${found.from})`
		: found.code
			? `client: unknown service "${found.code}" (msgstring_${found.code}.lub in ${found.from}); mods for one client are not refused`
			: `client: could not tell which client this is${found.problems.length ? ` (${found.problems.join('; ')})` : ''}; mods for one client are not refused`);
	return out;
}

/** What Settings and the diagnostics show. */
function describe(stateDir) {
	try {
		const d = JSON.parse(fs.readFileSync(path.join(stateDir, 'client-detected.json'), 'utf8'));
		if (d.client) return { client: d.client, code: d.code, from: d.from, text: `${d.client} (from ${d.from})` };
		if (d.code) return { client: null, code: d.code, from: d.from, text: `unknown service "${d.code}" (from ${d.from})` };
	} catch { /* not detected yet */ }
	return { client: null, code: null, from: null, text: 'not detected' };
}

module.exports = { detectClient, detectAndSave, describe, serviceCodes, SERVICES };
