'use strict';
// The Control panel's character drawing (#230): which files a character is
// drawn from, and the anchor points that put its head on its body. The paths
// must be the ones roBrowser asks for (src/DB/DBManager.js), or the asset
// server has nothing to answer with.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
	const context = { window: {}, fetch: () => { throw new Error('no fetch here'); } };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'tools', 'control-panel', 'sprite.js'), 'utf8'), context);
	return context.window.PlayerSprite;
}

const tables = {
	classes: { 0: '초보자', 4008: '로드나이트', 4218: '도람족', 4252: 'dragon_knight', 4335: '코스튬검사' },
	palettes: { 4008: '로드나이트' },
	hair: [[2, 2, 4, 7, 1], [2, 2, 1, 7, 5], [0, 1, 2], [0, 1, 2]],
	hats: { 17: '_리본', 18: '_서클릿' },
	robes: { 1: '천사날개' },
	costume: [4331, 4350],
};
const look = extra => ({ class: '4008', sex: 'F', hair: '3', hair_color: '2', clothes_color: '1', body: '0', head_top: '17', head_mid: '0', head_bottom: '0', robe: '0', ...extra });

test('a character is drawn from the files roBrowser would ask for', () => {
	const { parts } = load();
	const got = parts(look({ robe: '1', head_mid: '18' }), tables);
	assert.deepEqual(JSON.parse(JSON.stringify(got)), [
		{ part: 'garment', main: true, spr: 'data/sprite/로브/천사날개/여/로드나이트_여', fallback: 'data/sprite/로브/천사날개/천사날개' },
		{ part: 'body', main: true, spr: 'data/sprite/인간족/몸통/여/로드나이트_여', pal: 'data/palette/몸/로드나이트_여_1.pal' },
		// HairIndexTable[female][3] is 7.
		{ part: 'head', spr: 'data/sprite/인간족/머리통/여/7_여', pal: 'data/palette/머리/머리7_여_2.pal' },
		{ part: 'middle headgear', spr: 'data/sprite/악세사리/여/여_서클릿' },
		{ part: 'top headgear', spr: 'data/sprite/악세사리/여/여_리본' },
	]);
});

test('the folder names are the CP949 ones in DBManager.js, decoded', () => {
	// The literals as roBrowser writes them, so a typo in the Korean above
	// cannot pass by agreeing with itself.
	const source = fs.existsSync(path.join(__dirname, '..', 'vendor', 'roBrowserLegacy', 'src', 'DB', 'DBManager.js'))
		? fs.readFileSync(path.join(__dirname, '..', 'vendor', 'roBrowserLegacy', 'src', 'DB', 'DBManager.js'), 'latin1')
		: null;
	const korean = escaped => new TextDecoder('euc-kr').decode(Buffer.from(escaped.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'));
	const literals = {
		'인간족/몸통': '\\xc0\\xce\\xb0\\xa3\\xc1\\xb7/\\xb8\\xf6\\xc5\\xeb',
		'인간족/머리통': '\\xc0\\xce\\xb0\\xa3\\xc1\\xb7/\\xb8\\xd3\\xb8\\xae\\xc5\\xeb',
		'도람족/몸통': '\\xb5\\xb5\\xb6\\xf7\\xc1\\xb7/\\xb8\\xf6\\xc5\\xeb',
		'palette/몸': 'palette/\\xb8\\xf6',
		'palette/머리/머리': 'palette/\\xb8\\xd3\\xb8\\xae/\\xb8\\xd3\\xb8\\xae',
		'sprite/악세사리': 'sprite/\\xbe\\xc7\\xbc\\xbc\\xbb\\xe7\\xb8\\xae',
		'sprite/로브': 'sprite/\\xb7\\xce\\xba\\xea',
	};
	for (const [want, escaped] of Object.entries(literals)) {
		assert.equal(korean(escaped), want);
		if (source) assert.ok(source.toLowerCase().includes(escaped.toLowerCase()), `DBManager.js no longer says ${escaped}`);
	}
	assert.deepEqual(['\\xbf\\xa9', '\\xb3\\xb2'].map(korean), ['여', '남']);
});

test('doram, outfits and repeated headgear are drawn the way the game draws them', () => {
	const { parts } = load();
	const doram = JSON.parse(JSON.stringify(parts(look({ class: '4218', sex: 'M', hair: '2', head_top: '0' }), tables)));
	assert.equal(doram[0].spr, 'data/sprite/도람족/몸통/남/도람족_남');
	assert.equal(doram[1].spr, 'data/sprite/도람족/머리통/남/2_남');
	assert.equal(doram[1].pal, 'data/palette/도람족/머리/머리2_남_2.pal');
	// An outfit from the costume range draws from costume_1/.
	const outfit = parts(look({ body: '4335', clothes_color: '0', hair_color: '0' }), tables);
	assert.equal(outfit[0].spr, 'data/sprite/인간족/몸통/여/costume_1/코스튬검사_여_1');
	assert.equal(outfit[0].pal, null);
	assert.equal(outfit[1].pal, null);
	// The same headgear in two slots is drawn once, as the lower one.
	const same = [...parts(look({ head_top: '17', head_bottom: '17' }), tables).map(p => p.part)];
	assert.deepEqual(same, ['body', 'head', 'lower headgear']);
	// A view id the tables do not know is skipped, not guessed at.
	assert.deepEqual([...parts(look({ head_top: '99999', robe: '77' }), tables).map(p => p.part)], ['body', 'head']);
});

test('an action file\'s anchor points are read, so a head sits on its body', () => {
	const { readAct } = load();
	// ACT 2.5: one action, one frame, one layer, two anchor points.
	const parts = [];
	const u8 = n => parts.push(Buffer.from([n]));
	const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); parts.push(b); };
	const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); parts.push(b); };
	const f32 = n => { const b = Buffer.alloc(4); b.writeFloatLE(n); parts.push(b); };
	parts.push(Buffer.from('AC'));
	u8(5); u8(2); // version 2.5
	u16(1); parts.push(Buffer.alloc(10));
	i32(1); // frames
	parts.push(Buffer.alloc(32));
	i32(1); // layers
	i32(-3); i32(-40); i32(0); i32(0); // x, y, sprite, mirror
	u8(255); u8(255); u8(255); u8(255); f32(1); f32(1); i32(0); i32(0); i32(0); i32(0);
	i32(-1); // sound
	i32(2); // anchors
	i32(0); i32(1); i32(-75); i32(0);
	i32(0); i32(9); i32(9); i32(0);
	i32(0); // sounds
	f32(4); // delay
	const buf = Buffer.concat(parts);
	const act = readAct(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
	assert.equal(act.actions.length, 1);
	const frame = act.actions[0][0];
	assert.deepEqual(JSON.parse(JSON.stringify(frame.anchors)), [{ x: 1, y: -75 }, { x: 9, y: 9 }]);
	assert.equal(frame.layers[0].x, -3);
	assert.equal(frame.layers[0].y, -40);
});
