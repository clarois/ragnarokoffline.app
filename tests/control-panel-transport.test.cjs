'use strict';
// The Control panel end to end (#230), through the real `ragnarok-stack cp`
// against a fake docker client with a small world behind it
// (tests/fixtures/fake-docker-db.cjs). The statements themselves are pinned in
// stack/src/control_panel.rs; this is about what reaches the database, what
// is refused before anything does, and what is left behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const skip = !process.env.STACK_BIN ? 'needs STACK_BIN' : process.platform === 'win32' ? 'the fake docker is a #! script' : false;

const look = { hair: 3, hair_color: 2, clothes_color: 0, body: 0, weapon: 1201, shield: 0, head_top: 17, head_mid: 0, head_bottom: 0, robe: 0 };
const char = (id, account, name, extra = {}) => ({
	char_id: id, account_id: account, char_num: 0, name, class: 4008, sex: 'F', base_level: 99, job_level: 70,
	base_exp: '18446744073709551615', job_exp: 5, zeny: 123456, str: 1, agi: 2, vit: 3, int: 4, dex: 5, luk: 6,
	hp: 10, max_hp: 20, sp: 1, max_sp: 2, status_point: 0, skill_point: 0,
	last_map: 'gef_fild10', last_x: 10, last_y: 20, last_instanceid: 3, save_map: 'prontera', save_x: 156, save_y: 191, online: 0,
	party_id: 0, guild_id: 0, homun_id: 0, pet_id: 0, elemental_id: 0, partner_id: 0, father: 0, mother: 0,
	delete_date: 0, last_login: null, ...look, ...extra,
});

function world() {
	return {
		login: [
			{ account_id: 1, userid: 's1', sex: 'S', group_id: 0, state: 0 },
			{ account_id: 2000000, userid: 'ragnarok', sex: 'M', group_id: 99, state: 0 },
			{ account_id: 2000001, userid: 'player1', sex: 'F', group_id: 0, state: 0 },
			{ account_id: 2000002, userid: 'aiagent', sex: 'M', group_id: 20, state: 0 },
		],
		char: [
			char(150000, 2000000, 'Alice'),
			char(150001, 2000000, 'Bob', { char_num: 1 }),
			char(150002, 2000001, 'Carol', { online: 1, guild_id: 1 }),
			char(150003, 2000001, 'Dave', { char_num: 1, party_id: 2 }),
			char(150004, 2000002, 'AgentA'),
		],
		guild: [{ guild_id: 1, name: 'Knights', char_id: 150002 }],
		party: [{ party_id: 2, name: 'Pals' }],
		inventory: [
			{ id: 1, char_id: 150000, nameid: 1201, amount: 1, equip: 2, refine: 7, card0: 4001, card1: 0, card2: 0, card3: 0, identify: 1, bound: 0 },
			{ id: 2, char_id: 150000, nameid: 501, amount: 5, equip: 0, refine: 0, card0: 0, card1: 0, card2: 0, card3: 0, identify: 1, bound: 0 },
			{ id: 3, char_id: 150001, nameid: 502, amount: 1, equip: 0, refine: 0, card0: 0, card1: 0, card2: 0, card3: 0, identify: 1, bound: 0 },
		],
		cart_inventory: [],
		storage: [{ account_id: 2000000, nameid: 501 }],
		skill: [{ char_id: 150000, id: 1 }, { char_id: 150001, id: 1 }],
		log: [],
	};
}

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-cp-transport-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const state = path.join(dir, 'state');
	fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
	const fake = path.join(dir, 'docker');
	fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-docker-db.cjs'), fake);
	fs.copyFileSync(path.join(__dirname, 'fixtures', 'rathena-char-table.sql'), path.join(dir, 'rathena-char-table.sql'));
	fs.chmodSync(fake, 0o755);
	const db = path.join(dir, 'db.json');
	fs.writeFileSync(db, JSON.stringify({ rows: [], cp: world() }));
	const run = request => {
		const r = spawnSync(process.env.STACK_BIN, ['cp'], {
			input: JSON.stringify(request), encoding: 'utf8', timeout: 30000,
			env: { ...process.env, RAGNAROK_OFFLINE_ROOT: dir, RAGNAROKMAC_STATE: state, NEBULA_HOME: path.join(dir, 'nebula'),
				NEBULA_BIN: fake, RAGNAROKMAC_DOCKER: fake, FAKE_STATE: state, FAKE_DB: db },
		});
		// Errors come back as JSON on stdout, like `accounts`.
		const answer = JSON.parse(r.stdout);
		assert.equal(r.status === 0, !answer.error, `${r.status} ${r.stdout} ${r.stderr}`);
		return answer;
	};
	const cp = () => JSON.parse(fs.readFileSync(db, 'utf8')).cp;
	const edit = change => { const all = JSON.parse(fs.readFileSync(db, 'utf8')); change(all.cp); fs.writeFileSync(db, JSON.stringify(all)); };
	return { state, run, cp, edit };
}

test('the list shows player accounts and their characters, and nothing of the app\'s own', { skip }, t => {
	const { run } = fixture(t);
	const answer = run({ action: 'characters' });
	assert.deepEqual(answer.accounts.map(a => a.username), ['ragnarok', 'player1'], 's1 and the AI agent are left out');
	const [alice, bob] = answer.accounts[0].characters;
	assert.equal(alice.name, 'Alice');
	assert.equal(bob.name, 'Bob');
	assert.equal(alice.base_exp, '18446744073709551615', 'a 64-bit value stays exact');
	assert.equal(alice.head_top, '17');
	assert.equal(alice.guild, null);
	const carol = answer.accounts[1].characters[0];
	assert.equal(carol.guild, 'Knights');
	assert.equal(carol.online, '1');
	assert.equal(answer.accounts[1].characters[1].party, 'Pals');
});

test('one character comes with its equipment and item counts', { skip }, t => {
	const { run } = fixture(t);
	const answer = run({ action: 'character', char_id: '150000' });
	assert.equal(answer.character.name, 'Alice');
	assert.deepEqual(answer.equipment.map(i => [i.nameid, i.equip, i.refine, i.card0]), [['1201', '2', '7', '4001']]);
	assert.deepEqual(answer.counts, { inventory: 2, cart: 0, storage: 1 });
	assert.match(run({ action: 'character', char_id: '150004' }).error, /no character 150004 on a player account/);
	assert.match(run({ action: 'character', char_id: '1 OR 1=1' }).error, /char_id/);
});

test('moving a character writes its position and nothing else, and only while its account is logged out', { skip }, t => {
	const { run, cp, state } = fixture(t);
	const moved = run({ action: 'reset-position', char_id: '150000', target: 'save' });
	assert.deepEqual(moved, { moved: true, char_id: '150000', map: 'prontera', x: 156, y: 191 });
	const alice = cp().char.find(c => c.char_id === 150000);
	assert.deepEqual([alice.last_map, alice.last_x, alice.last_y, alice.last_instanceid], ['prontera', 156, 191, 0]);
	assert.deepEqual([alice.save_map, alice.save_x, alice.save_y], ['prontera', 156, 191]);
	// Already there: nothing is written.
	const log = cp().log.length;
	assert.equal(run({ action: 'reset-position', char_id: '150000', target: 'save' }).moved, false);
	assert.equal(cp().log.length, log);

	const point = run({ action: 'reset-position', char_id: '150001', target: { map: 'prt_fild08', x: 170, y: 375 } });
	assert.equal(point.moved, true);
	assert.deepEqual(['last_map', 'last_x', 'last_y'].map(k => cp().char.find(c => c.char_id === 150001)[k]), ['prt_fild08', 170, 375]);

	// Carol is in the game; Dave is on her account.
	assert.match(run({ action: 'reset-position', char_id: '150002', target: 'save' }).error, /Carol is in the game/);
	assert.match(run({ action: 'reset-position', char_id: '150003', target: 'save' }).error, /Another character on player1's account is in the game/);
	assert.equal(cp().char.find(c => c.char_id === 150003).last_map, 'gef_fild10');
	assert.match(run({ action: 'reset-position', char_id: '150000', target: { map: "x'; DROP TABLE login", x: 1, y: 1 } }).error, /not a map name/);

	// A move never stops the game, so it takes no backup.
	assert.deepEqual(fs.readdirSync(path.join(state, 'backups')), []);
});

test('a delete is refused, before anything stops, when the game would refuse it', { skip }, t => {
	const { run, cp, state, edit } = fixture(t);
	assert.match(run({ action: 'delete-character', char_id: '150002', name: 'Carol' }).error, /Carol is in a guild/);
	assert.match(run({ action: 'delete-character', char_id: '150003', name: 'Dave' }).error, /Dave is in a party/);
	assert.match(run({ action: 'delete-character', char_id: '150001', name: 'bob' }).error, /does not match/);
	assert.match(run({ action: 'delete-character', char_id: '150004', name: 'AgentA' }).error, /no character 150004 on a player account/);
	// In the game, or another character on the account is.
	edit(world => { world.char.find(c => c.char_id === 150001).online = 1; });
	assert.match(run({ action: 'delete-character', char_id: '150001', name: 'Bob' }).error, /Bob's account is in the game/);
	assert.match(run({ action: 'delete-character', char_id: '150000', name: 'Alice' }).error, /Alice's account is in the game/);
	assert.equal(cp().char.length, 5);
	assert.deepEqual(cp().log, []);
	assert.deepEqual(fs.readdirSync(path.join(state, 'backups')), [], 'no backup, so nothing was stopped');
});

test('a delete takes a backup, runs char_delete\'s statements and leaves the rest alone', { skip }, t => {
	const { run, cp, state } = fixture(t);
	const answer = run({ action: 'delete-character', char_id: '150000', name: 'Alice' });
	assert.equal(answer.deleted, '150000');
	assert.equal(answer.name, 'Alice');
	assert.match(path.basename(answer.backup), /^before-control-panel-renewal-[0-9a-f]+\.sql$/);
	assert.ok(fs.existsSync(answer.backup));
	assert.match(fs.readFileSync(answer.backup, 'utf8'), /"Alice"/, 'the backup was taken before the delete');
	const after = cp();
	assert.deepEqual(after.char.map(c => c.name), ['Bob', 'Carol', 'Dave', 'AgentA']);
	assert.deepEqual(after.inventory.map(i => i.char_id), [150001]);
	assert.deepEqual(after.skill.map(s => s.char_id), [150001]);
	assert.equal(after.log[0], 'DELETE FROM `pet` WHERE `char_id` = 150000 AND `incubate` = 0;');
	assert.equal(after.log[after.log.length - 1], 'DELETE FROM `char` WHERE `char_id` = 150000;');
	assert.ok(after.log.some(l => l.startsWith('INSERT INTO `charlog`')));
	assert.deepEqual(fs.readdirSync(path.join(state, 'backups')).filter(f => !f.startsWith('before-control-panel-')), []);
	// It is gone from the list.
	assert.deepEqual(run({ action: 'characters' }).accounts[0].characters.map(c => c.name), ['Bob']);
});

test('a delete that fails part-way puts the backup back', { skip }, t => {
	const { run, cp, edit } = fixture(t);
	edit(world => { world.failOn = 'achievement'; });
	const answer = run({ action: 'delete-character', char_id: '150001', name: 'Bob' });
	assert.match(answer.error, /Deleting achievements failed: .*Nothing was deleted: the database was put back as it was/);
	const after = cp();
	assert.ok(after.char.some(c => c.name === 'Bob'));
	assert.ok(after.inventory.some(i => i.char_id === 150001), 'the inventory deleted before the failure is back');
	assert.deepEqual(after.log, []);
});
