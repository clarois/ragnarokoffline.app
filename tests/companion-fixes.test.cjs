// Guards for three bugs found from the live server log after the party-membership
// fix went in. Each was reproduced from log evidence first, and each assertion
// below fails against the commit that shipped it.
//
// 1. "@companion summon <name>" called the batch recall, so summoning one companion
//    re-placed and re-broadcast EVERY companion - which visibly undid a bench the
//    player had just made ("pressing summon removed every companion").
//    Log evidence: only index 352's active flag changed, then "recalled 8".
//
// 2. Companions stood still. The placement-recovery branch reset its throttle
//    before knowing the placement succeeded, so a failing shell re-warped every
//    tick. Log evidence: "recovered off-map companion Hanazia" thirteen times in a
//    row; a shell teleported that often cannot walk.
//
// 3. The party window stayed empty at boot and filled only on a later pass. The
//    post-recall resync asked the char server (party_request_info) for a party
//    whose companion rows it does not have, so nothing came back.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const HPP = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.hpp');
const STATE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine', 'core', 'population_shell_state.hpp');
const PATCH6 = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0006-companion-gear-return.patch');

const src = fs.readFileSync(ENGINE, 'utf8');
const hpp = fs.readFileSync(HPP, 'utf8');
const state = fs.readFileSync(STATE, 'utf8');
const patch6 = fs.readFileSync(PATCH6, 'utf8');

test('recall can target a single companion index', () => {
	assert.match(hpp, /population_engine_recall_companions\(map_session_data \*owner, uint32_t only_index = 0\)/,
		'recall needs an optional only_index so one companion can be recalled alone');
	assert.match(src, /WHERE owner_account_id=%u AND active=1%s/, 'the recall query must be able to filter by shell_index');
	assert.match(src, /only_index != 0 \? " AND shell_index=" : ""/, 'the filter must be applied from only_index');
});

test('@companion summon recalls only the named companion', () => {
	// The patch ships the atcommand change, so assert on the added line there. The
	// removed line is still present in the diff as a '-' entry, which is why this
	// checks the '+' form rather than the absence of the old text.
	assert.match(patch6, /^\+\t\tconst int n = population_engine_recall_companions\(sd, index_\);/m,
		'summon must pass the resolved index, not call the batch');
	// And confirm the batch call for that site was actually replaced.
	const added = (patch6.match(/^\+\t\tconst int n = population_engine_recall_companions\(sd, index_\);/gm) || []).length;
	const removed = (patch6.match(/^-\t\tconst int n = population_engine_recall_companions\(sd\);/gm) || []).length;
	assert.strictEqual(added, 1, 'expected exactly one added summon call with the index');
	assert.strictEqual(removed, 1, 'expected the batch summon call to be removed');
});

test('the placement recovery backs off instead of re-warping every tick', () => {
	const branch = src.slice(src.indexOf('if (sd->prev == nullptr) {', src.indexOf('static bool pop_companion_follow_owner')));
	assert.ok(branch.length > 0, 'recovery branch not found');
	const head = branch.slice(0, 1800);
	// The throttle must be set inside the success path, not before the attempt.
	assert.match(head, /if \(warp_near_owner\(\)\) \{[\s\S]{0,200}?companion_follow_next = now \+ 400/,
		'the throttle must only reset when the placement succeeded');
	assert.match(head, /placement_fail_streak/, 'a failure must be counted for backoff');
	assert.match(state, /placement_fail_streak/, 'the streak needs storage on the shell');
});

test('the post-recall resync registers locally instead of asking the char server', () => {
	const recall = src.slice(src.indexOf('int population_engine_recall_companions'));
	const body = recall.slice(0, 9000);
	assert.match(body, /pop_companion_register_local_party\(shell, owner\)/,
		'the resync must register companions locally');
	assert.ok(!/party_request_info\(owner->status\.party_id/.test(body),
		'the resync must not ask the char server: companion rows do not exist there');
});
