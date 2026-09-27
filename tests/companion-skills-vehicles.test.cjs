// Guards for two fixes: the skill-id bound, and shell vehicles/pets.
//
// FIX 1 - the bound. Both skill-id parsers used `v > 0 && v < MAX_SKILL`, where MAX_SKILL is
// the size of `status.skill[]` (1641) and NOT the ceiling of real skill ids (the pinned
// skill_db.yml reaches 10019, with 967 ids at or above 1641). So every 4th-job skill failed
// the bound, left `sid == 0`, and the caller reported "<companion> cannot use <token>".
//
// It bit twice, because the same bound is in the parser that reads the STORED preset: a
// stored 4th-job id was DROPPED on every recall, so even clicking All lost its high-id entries
// on the next login. That is the reported "enable then disable" behaviour.
//
// FIX 2 - vehicles. `pc_setriding` and `pc_setfalcon` already tolerate population shells (both
// carry `|| population_engine_is_population_pc(sd->id)`) but NOTHING called them, so no shell
// ever received a mount, falcon, warg or mado through the engine. And `pc_setmadogear` cannot
// work for a 4th job at all - it early-returns unless `(class_ & MAPID_THIRDMASK) ==
// MAPID_MECHANIC`.
//
// A compile check cannot cover either one (both were verified to still compile when reverted),
// so these assertions pin the code relationships that make the behaviour correct.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const src = fs.readFileSync(ENGINE, 'utf8');

test('no skill-id parser is bounded by MAX_SKILL', () => {
	// The bound must not be MAX_SKILL anywhere a skill ID is parsed from text.
	const bound = /if \(v > 0 && v < MAX_SKILL\)/g;
	assert.equal((src.match(bound) || []).length, 0,
		'a skill-id parse must not be bounded by MAX_SKILL (that is the array size, not the id range)');
	// The replacement bound is the uint16 field width.
	const fixed = (src.match(/if \(v > 0 && v <= 0xFFFF\)/g) || []).length;
	assert.ok(fixed >= 2,
		`both parsers must use the corrected bound (found ${fixed}; expected the stored-preset parser and the toggle)`);
});

test('the one legitimate MAX_SKILL loop is left alone', () => {
	// spawn_shell walks sd->status.skill[], which IS MAX_SKILL-sized - that use is correct and
	// removing it would break the "strip skills outside this job's tree" pass.
	assert.match(src, /for \(uint16 i = 1; i < MAX_SKILL; i\+\+\)/,
		'the status.skill[] walk must keep using MAX_SKILL');
});

test('the vehicle helper covers all four subsystems with the right gates', () => {
	const i = src.indexOf('static void population_engine_sync_shell_vehicle(map_session_data *sd)\n{');
	assert.ok(i > 0, 'the vehicle helper must be defined');
	const body = src.slice(i, i + 2600);

	// never touch a real player
	assert.match(body, /if \(!population_engine_is_population_pc\(sd->id\)\)\s*\n\s*return;/,
		'the helper must refuse non-shells');

	// riding: Peco Peco / dragon, via the already-population-aware setter
	assert.match(body, /pc_checkskill\(sd, KN_RIDING\) > 0 \|\| pc_checkskill\(sd, RK_DRAGONTRAINING\) > 0/,
		'riding is gated on KN_RIDING or RK_DRAGONTRAINING');
	assert.match(body, /pc_setriding\(sd, 1\)/, 'riding must call pc_setriding');

	// falcon
	assert.match(body, /pc_checkskill\(sd, HT_FALCON\) > 0/, 'falcon is gated on HT_FALCON');
	assert.match(body, /pc_setfalcon\(sd, 1\)/, 'falcon must call pc_setfalcon');

	// warg: no setter exists in this pin, so the option is set directly
	assert.match(body, /pc_checkskill\(sd, RA_WUGMASTERY\) > 0/, 'warg is gated on RA_WUGMASTERY');
	assert.match(body, /sd->sc\.option \| OPTION_WUG/, 'warg must set OPTION_WUG');

	// mado: pc_setmadogear cannot work for a 4th job, so the option is set directly
	assert.match(body, /pc_checkskill\(sd, NC_MADOLICENCE\) > 0/, 'mado is gated on NC_MADOLICENCE');
	assert.match(body, /sd->sc\.option \| OPTION_MADOGEAR, MADO_ROBOT/,
		'mado must set OPTION_MADOGEAR with the robot subtype (pc_setmadogear early-returns for a 4th job)');
});

test('the vehicle is applied at spawn AND after a job change', () => {
	// Both matter: a Swordsman that levels into Knight must GAIN its mount, and the spawn path
	// must cover ambient/drafted shells that never advance.
	const calls = (src.match(/population_engine_sync_shell_vehicle\(sd\);/g) || []).length;
	assert.ok(calls >= 2,
		`the vehicle sync must be called from both spawn and job-advance (found ${calls})`);

	// Compare EVERY call against its own anchor rather than using indexOf for "the" call. The
	// two call sites are in the opposite order to their anchors in the file (the job-advance
	// call is at ~2329, the spawn call at ~3977), so a single indexOf picks up the advance call
	// when you mean the spawn one - which is how the first version of this test failed on
	// correct code.
	const callIdx = [];
	{
		const re = /population_engine_sync_shell_vehicle\(sd\);/g;
		let m;
		while ((m = re.exec(src)) !== null) callIdx.push(m.index);
	}

	const spawnGrant = src.indexOf('pc_calc_skilltree(sd);');
	assert.ok(spawnGrant > 0, 'the skill-tree grant anchor must exist');
	assert.ok(callIdx.some(i => i > spawnGrant),
		'one call must come after the skill-tree grant (spawn): every gate is pc_checkskill');

	const jobchange = src.indexOf('if (!pc_jobchange(sd, next, upper))');
	assert.ok(jobchange > 0, 'the job-change anchor must exist');
	assert.ok(callIdx.some(i => i > jobchange),
		'one call must come after pc_jobchange (advance), so a new class gains its vehicle');
});

test('the helper is declared before its first use', () => {
	// The job-advance call site precedes the definition, so a forward declaration is required;
	// without it the TU fails to compile ("not declared in this scope").
	const lines = src.split('\n');
	const decl = lines.findIndex(l => l.startsWith('static void population_engine_sync_shell_vehicle(map_session_data *sd);'));
	assert.ok(decl >= 0, 'a forward declaration must exist');
	const uses = lines.map((l, i) => ({ l, i }))
		.filter(({ l }) => l.includes('population_engine_sync_shell_vehicle(sd);') && !l.startsWith('static'));
	assert.ok(uses.length >= 2, `expected both call sites, found ${uses.length}`);
	for (const { i } of uses) {
		assert.ok(i > decl, `call at line ${i + 1} precedes the declaration at ${decl + 1}`);
	}
});

test('the dump exposes the vehicle bits so the fix is verifiable by reading', () => {
	// The whole reason @companion dump exists: a vehicle is a visual claim, and the fact behind
	// it is sd->sc.option. Print the decoded bits instead of asking a human to judge a sprite.
	const i = src.indexOf('population_engine_shell_dump');
	assert.ok(i > 0, 'the dump function must exist');
	const body = src.slice(i, i + 4000);
	assert.match(body, /OPTION_RIDING/, 'the dump must decode OPTION_RIDING');
	assert.match(body, /OPTION_FALCON/, 'the dump must decode OPTION_FALCON');
	assert.match(body, /OPTION_WUG/, 'the dump must decode OPTION_WUG');
	assert.match(body, /OPTION_MADOGEAR/, 'the dump must decode OPTION_MADOGEAR');
	assert.match(body, /"@SHELL\|\%u\|%s\|%u\|%u\|%d\|%zu\|%zu\|%d\|%d\|%d\|%d\|%d\|0x%08x\|%s"/,
		'the wire line must carry the raw option value and the decoded tag');
});
