'use strict';
// The Tools windows read the client's own tables, mods' included (#195 left
// them reading the base table only). These check the two readers against a
// served asset root laid out the way `link-assets` leaves it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientItemInfo, clientMonsterSprites } = require('../electron/tools.js');

function world(files) {
	const web = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-tools-'));
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(web, rel)), { recursive: true });
		fs.writeFileSync(path.join(web, rel), body);
	}
	return web;
}

const item = (id, name) => `[${id}] = { identifiedDisplayName = "${name}", identifiedResourceName = "x" },\n`;

test('item tables are joined base first, so a later mod wins as it does in game', () => {
	const web = world({
		'Config.local.js': "window.ROConfigLocal = {\n\tcustomItemInfo: ['System/itemInfo-b.lua', 'System/itemInfo-a.lua', 'System/itemInfo.lua'],\n};\n",
		'System/itemInfo.lua': 'tbl = {\n' + item(501, 'Red Potion') + item(502, 'Orange Potion') + '}',
		'System/itemInfo-a.lua': 'tbl = {\n' + item(30001, 'Islander Brew') + item(502, 'A renamed it') + '}',
		'System/itemInfo-b.lua': 'tbl = {\n' + item(502, 'B renamed it last') + '}',
	});
	const text = clientItemInfo(web).toString('utf8');
	const last = {};
	for (const m of text.matchAll(/\[(\d+)\] = \{ identifiedDisplayName = "([^"]+)"/g)) last[m[1]] = m[2];
	assert.equal(last[501], 'Red Potion');
	assert.equal(last[30001], 'Islander Brew', 'a new item from a mod is there');
	assert.equal(last[502], 'B renamed it last', 'the client takes b first, so b must parse last');
});

test('a CP949 base and a UTF-8 mod table both come out readable', () => {
	const korean = Buffer.from([0xbb, 0xa1, 0xb0, 0xa3]); // 빨간 in CP949
	const web = world({
		'Config.local.js': "customItemInfo: ['System/itemInfo-m.lua', 'System/itemInfo.lua'],\n",
		'System/itemInfo.lua': Buffer.concat([Buffer.from('[501] = { identifiedResourceName = "'), korean, Buffer.from('" },')]),
		'System/itemInfo-m.lua': '[30001] = { identifiedResourceName = "빨간포션" },',
	});
	const text = clientItemInfo(web).toString('utf8');
	assert.match(text, /\[501\] = \{ identifiedResourceName = "빨간" \}/);
	assert.match(text, /빨간포션/);
});

test('with no mod item tables, the first base table the client would read', () => {
	const web = world({ 'Config.local.js': '{}', 'System/itemInfo_true.lub': '[1] = {}', 'System/itemInfo.lub': '[2] = {}' });
	assert.equal(clientItemInfo(web).toString('utf8'), '[2] = {}');
	assert.throws(() => clientItemInfo(world({})), /Start the game once/);
});

test("mods' monster sprites come from their npcidentity/jobname pairs, later mods winning", () => {
	const web = world({
		'Config.local.js': "\tcustomLuaTables: { accessory: [['System/ids-none-accessory-a.lua', 'System/accname-a.lua']], monster: [['System/npcidentity-a.lub', 'System/jobname-a.lub'], ['System/ids-none-monster-b.lua', 'System/jobname-b.lua']] },\n",
		'System/npcidentity-a.lub': 'jobtbl.JT_MY_MOB = 31001\njobtbl.JT_OTHER = 31002\n',
		'System/jobname-a.lub': 'JobNameTable = {\n\t[jobtbl.JT_MY_MOB] = "MY_MOB",\n\t[jobtbl.JT_OTHER] = "OTHER",\n}\n',
		'System/ids-none-accessory-a.lua': '',
		'System/ids-none-monster-b.lua': '',
		'System/jobname-b.lua': 'JobNameTable = { [31002] = "B_OTHER" }',
	});
	assert.deepEqual(clientMonsterSprites(web), { 31001: 'MY_MOB', 31002: 'B_OTHER' });
	assert.deepEqual(clientMonsterSprites(world({ 'Config.local.js': '{}' })), {});
});

// ---- The Control panel (#230)

const { clientViewTable, clientItemNames, clientLookTables } = require('../electron/tools.js');

test("mods' headgear and garment sprites come from their accessory and robe tables", () => {
	const web = world({
		'Config.local.js': "\tcustomLuaTables: { accessory: [['System/accessoryid-a.lub', 'System/accname-a.lub']], robe: [['System/spriterobeid-a.lub', 'System/spriterobename-a.lub']] },\n",
		'System/accessoryid-a.lub': 'ACCESSORY_IDs = {\n\tACCESSORY_MY_HAT = 3001,\n}\n',
		'System/accname-a.lub': 'AccNameTable = {\n\t[ACCESSORY_IDs.ACCESSORY_MY_HAT] = "_my_hat",\n}\n',
		'System/spriterobeid-a.lub': 'SPRITE_ROBE_IDs = { ROBE_MY_WINGS = 401 }\n',
		'System/spriterobename-a.lub': 'RobeNameTable = { [SPRITE_ROBE_IDs.ROBE_MY_WINGS] = "my_wings" }\n',
	});
	assert.deepEqual(clientViewTable(web, 'accessory'), { 3001: '_my_hat' });
	assert.deepEqual(clientViewTable(web, 'robe'), { 401: 'my_wings' });
	assert.deepEqual(clientViewTable(web, 'monster'), {});
});

test('item names and icons, the last definition winning', () => {
	const web = world({
		'Config.local.js': "customItemInfo: ['System/itemInfo-m.lua', 'System/itemInfo.lua'],\n",
		'System/itemInfo.lua': 'tbl = {\n[1201] = { identifiedDisplayName = "Knife", identifiedResourceName = "나이프", slotCount = 3 },\n[501] = { unidentifiedDisplayName = "Potion" },\n}',
		'System/itemInfo-m.lua': '[1201] = { identifiedDisplayName = "Modded Knife", identifiedResourceName = "knife2" },',
	});
	const names = clientItemNames(web);
	assert.deepEqual(names[1201], { name: 'Modded Knife', resource: 'knife2', slots: 0 });
	assert.equal(names[501], undefined, 'an item with no identified name is left out');
});

test("roBrowser's sprite-name tables are run, not pattern-matched, and come out in Korean", () => {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-tables-'));
	const tables = path.join(runtime, 'client-tables');
	fs.mkdirSync(tables);
	// Shaped like the real files: ES modules, CRLF, CP949 bytes as \x escapes.
	const files = {
		'JobConst.js': 'export default {\r\n\tNOVICE: 0,\r\n\tKNIGHT: 7,\r\n\tCOSTUME_SECOND_JOB_START: 4331,\r\n\tCOSTUME_SECOND_JOB_END: 4350,\r\n};\r\n',
		'JobNameTable.js': "import JobId from './JobConst.js';\r\nconst JobNameTable = {};\r\nJobNameTable[JobId.NOVICE] = '\\xC3\\xCA\\xBA\\xB8\\xC0\\xDA';\r\nfunction dup(a, b) { JobNameTable[b] = JobNameTable[a]; }\r\ndup(JobId.NOVICE, JobId.KNIGHT);\r\nexport default JobNameTable;\r\n",
		'PalNameTable.js': "import JobId from './JobConst.js';\r\nimport JobNameTable from './JobNameTable.js';\r\nconst PalNameTable = {};\r\nPalNameTable[JobId.KNIGHT] = JobNameTable[JobId.NOVICE];\r\nexport default PalNameTable;\r\n",
		'HairIndexTable.js': 'export default [[2, 2], [2, 1], [0], [0]];\r\n',
		'HatTable.js': "export default {\r\n\t17: '_\\xb8\\xae\\xba\\xbb',\r\n};\r\n",
		'RobeTable.js': "export default { 1: 'wings' };\r\n",
	};
	for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(tables, name), body);
	const web = world({ 'Config.local.js': '{}' });
	const t = clientLookTables(runtime, web);
	assert.equal(t.jobs[7], 'KNIGHT');
	assert.equal(t.classes[0], '초보자');
	assert.equal(t.classes[7], '초보자', 'entries copied in code are there');
	assert.equal(t.palettes[7], '초보자');
	assert.deepEqual(JSON.parse(JSON.stringify(t.hair)), [[2, 2], [2, 1], [0], [0]]);
	assert.equal(t.hats[17], '_리본');
	assert.equal(t.robes[1], 'wings');
	assert.deepEqual(t.costume, [4331, 4350]);
	// Nothing they define leaks out of their own context.
	assert.equal(typeof globalThis.JobNameTable, 'undefined');
});

test('the shipped roBrowser tables load, when the pinned client is checked out', { skip: !fs.existsSync(path.join(__dirname, '..', 'vendor', 'roBrowserLegacy', 'src', 'DB', 'Jobs', 'JobNameTable.js')) && 'needs vendor/roBrowserLegacy' }, () => {
	const t = clientLookTables(path.join(os.tmpdir(), 'no-runtime-here'), world({ 'Config.local.js': '{}' }));
	assert.equal(t.classes[4008], '로드나이트');
	assert.equal(t.palettes[4008], '로드나이트');
	assert.ok(Object.keys(t.hats).length > 1000);
});
