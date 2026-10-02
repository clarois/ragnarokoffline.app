// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for #242: drafting a 3rd or 4th class companion was refused with
// "job 4057 has no population profile to inherit", because
// population_engine_companion_draft() looks the job up in the Main population
// database and only 1st/2nd/trans classes had a profile there. The same lookup
// is what a grown companion spends its points from and re-gears from after a
// job change, so every class the job line can advance into needs one too.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PE = path.join(ROOT, 'third-party', 'population-engine');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const engineYml = read(path.join(PE, 'files', 'db', 'population_engine.yml'));
const gearYml = read(path.join(PE, 'files', 'db', 'population_gear_sets.yml'));
const spawnYml = read(path.join(PE, 'files', 'db', 'population_spawn.yml'));
const config = read(path.join(PE, 'files', 'src', 'map', 'population_engine', 'config', 'population_config.cpp'));
const engine = read(path.join(PE, 'files', 'src', 'map', 'population_engine.cpp'));
const panel = read(path.join(ROOT, 'patches', 'CompanionPanel.js'));

// Profile name -> { jobs: {JobName: GearSet}, body }
const profiles = {};
for (const blk of engineYml.split(/^ {2}- Profile: /m).slice(1)) {
	const name = blk.split(/\s/)[0];
	const m = blk.match(/^ {4}Jobs:\n((?: {6}\w+\s*:\s*\S+\n)+)/m);
	const jobs = {};
	if (m) for (const [, job, gs] of m[1].matchAll(/^ {6}(\w+)\s*:\s*(\S+)/gm)) jobs[job] = gs;
	profiles[name] = { jobs, body: blk };
}
const owner = {};
for (const [name, p] of Object.entries(profiles)) for (const job of Object.keys(p.jobs)) owner[job] = name;

const gearSets = new Set([...gearYml.matchAll(/^ {2}- GearSetName: (\S+)/gm)].map((m) => m[1]));
const jobIds = Object.fromEntries([...config.matchAll(/\{ "(\w+)",\s*(\d+)\s*\}/g)].map((m) => [m[1], Number(m[2])]));
const idToName = Object.fromEntries(Object.entries(jobIds).map(([n, id]) => [id, n]));

const range = (body, key) => {
	const m = body.match(new RegExp(`^ {4}${key}: \\[(\\d+), (\\d+)\\]`, 'm'));
	return m ? [Number(m[1]), Number(m[2])] : null;
};

const tiers = Object.fromEntries([...panel.match(/const JOB_TIERS = \[([\s\S]*?)\n\];/)[1]
	.matchAll(/\['(\w+)', \[([^\]]*)\]\]/g)].map((m) => [m[1], [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1])]));

test('every class the Summon tab offers has a profile to draft from', () => {
	const offered = Object.values(tiers).flat();
	assert.ok(offered.includes('ArchBishop') && offered.includes('Cardinal'), 'parsed the panel job list');
	for (const job of offered) {
		assert.ok(jobIds[job] !== undefined, `${job} must resolve through kJobNameMap`);
		assert.ok(owner[job], `${job} is offered for drafting but no profile in population_engine.yml lists it`);
		assert.ok(gearSets.has(profiles[owner[job]].jobs[job]),
			`${job}'s gear set ${profiles[owner[job]].jobs[job]} must exist in population_gear_sets.yml`);
	}
});

test('every class a companion can advance into has a profile to grow from', () => {
	const table = engine.match(/kPopJobAdvanceTable\[\] = \{([\s\S]*?)\n\};/)[1];
	const targets = new Set();
	for (const m of table.matchAll(/\{\s*(\d+),\s*(\d+),\s*(\d+),/g)) {
		targets.add(Number(m[2]));
		if (Number(m[3])) targets.add(Number(m[3]));
	}
	assert.ok(targets.has(4057) && targets.has(4256), 'parsed the advance table');
	for (const id of targets) {
		const name = idToName[id];
		assert.ok(name, `advance target ${id} has no kJobNameMap name, so no profile can list it`);
		assert.ok(owner[name], `a companion can advance into ${name} (${id}) but no profile lists it`);
	}
});

test('3rd and 4th class bands match the gates they are advanced into at', () => {
	// A companion advances trans -> 3rd at base 99 and 3rd -> 4th at base 200 and
	// re-gears on the spot; gear is chosen against the profile's band, so the
	// band has to start no later than the gate.
	for (const [tier, gate, cap] of [['3rd', 99, 200], ['4th', 200, 275]]) {
		for (const job of tiers[tier]) {
			const p = profiles[owner[job]];
			const base = range(p.body, 'BaseLevel');
			assert.ok(base, `${owner[job]} must declare a BaseLevel`);
			assert.ok(base[0] <= gate && base[1] <= cap, `${owner[job]} BaseLevel ${base} vs gate ${gate}`);
			for (const stat of ['Str', 'Agi', 'Vit', 'Int', 'Dex', 'Luk']) {
				const r = range(p.body, stat);
				assert.ok(r && r[1] <= 130, `${owner[job]} ${stat} must be declared and within 130`);
			}
		}
	}
	for (const job of tiers['4th']) {
		const p = profiles[owner[job]];
		const traits = ['Pow', 'Sta', 'Wis', 'Spl', 'Con', 'Crt'].map((t) => range(p.body, t)).filter(Boolean);
		assert.ok(traits.length > 0, `${owner[job]} must declare trait targets for a 4th class to spend into`);
		for (const r of traits) assert.ok(r[1] <= 110, `${owner[job]} trait ranges must stay within 110`);
	}
});

test('the companion-only profiles do not spawn ambiently', () => {
	for (const name of Object.keys(profiles).filter((n) => n.startsWith('companion_'))) {
		assert.doesNotMatch(spawnYml, new RegExp(`Profile: ${name}\\b`),
			`${name} is for drafted companions; population_spawn.yml must not place it on maps`);
	}
});
