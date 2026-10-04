'use strict';
// scripts/mksprite.py turns a PNG into the .spr/.act pair the client reads.
// The example mod's sprite is its output, so regenerating it must give the same
// bytes, and those bytes must be what roBrowser's Loaders/Sprite.js and
// Action.js expect (checked in game: examples/mods/custom-npc-sprite).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples', 'mods', 'custom-npc-sprite');
const run = args => execFileSync('python3', [path.join(ROOT, 'scripts', 'mksprite.py'), ...args], { encoding: 'utf8' });

test('the example sprite is mksprite.py output, byte for byte', () => {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mksprite-')), 'ro_guide');
	run([path.join(EXAMPLE, 'art', 'ro_guide.png'), '--out', out]);
	for (const ext of ['.spr', '.act'])
		assert.ok(fs.readFileSync(out + ext).equals(fs.readFileSync(path.join(EXAMPLE, 'data', 'sprite', 'npc', 'ro_guide' + ext))), ext);
});

test('the files have the layout the client reads', () => {
	const spr = fs.readFileSync(path.join(EXAMPLE, 'data', 'sprite', 'npc', 'ro_guide.spr'));
	assert.equal(spr.toString('latin1', 0, 2), 'SP');
	assert.deepEqual([spr[2], spr[3]], [0, 2], 'version 2.0: uncompressed palette frames');
	assert.equal(spr.readUInt16LE(4), 1, 'one palette frame');
	assert.equal(spr.readUInt16LE(6), 0, 'no RGBA frames');
	const [w, h] = [spr.readUInt16LE(8), spr.readUInt16LE(10)];
	assert.equal(spr.length, 12 + w * h + 1024, 'frame then the 256-colour palette');
	const act = fs.readFileSync(path.join(EXAMPLE, 'data', 'sprite', 'npc', 'ro_guide.act'));
	assert.equal(act.toString('latin1', 0, 2), 'AC');
	assert.equal(act.readUInt16LE(4), 8, 'eight actions: standing, one per direction');
});

test('--monster writes every action a monster uses, and --delay a version 2.2 file', () => {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mksprite-')), 'mob');
	run([path.join(EXAMPLE, 'art', 'ro_guide.png'), '--monster', '--delay', '200', '--out', out]);
	const act = fs.readFileSync(out + '.act');
	assert.deepEqual([act[2], act[3]], [2, 2]);
	assert.equal(act.readUInt16LE(4), 40, 'stand, walk, attack, hurt, die x 8 directions');
	assert.equal(act.readFloatLE(act.length - 4), 8, '200 ms is 8 ticks of 25 ms');
});
