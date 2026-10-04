'use strict';
// scripts/mkweapon.py, without the game: the recolour, the table it writes, and
// the URL it asks the app for. Fetching from a running app and drawing the
// result were checked in game (examples/mods/custom-weapon-look).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'mkweapon.py');
const py = code => execFileSync('python3', ['-B', '-c', `import importlib.util,sys\nspec=importlib.util.spec_from_file_location('mkweapon', ${JSON.stringify(SCRIPT)})\nm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n${code}`], { encoding: 'utf8' }).trim();

test('recolouring changes the palette only, and keeps colour 0 as the background', () => {
	const out = py(`
spr = bytearray(b'SP' + bytes([0, 2]) + (1).to_bytes(2,'little') + (0).to_bytes(2,'little') + (2).to_bytes(2,'little') + (1).to_bytes(2,'little') + bytes([0, 1]))
pal = bytearray(1024); pal[0:4] = bytes([255,0,255,0]); pal[4:8] = bytes([200,40,40,0])
spr += pal
new = m.recolour(bytes(spr), 120, 1.0, 1.0)
print(new[:-1024] == bytes(spr[:-1024]), list(new[-1024:-1020]), list(new[-1020:-1017]))`);
	const [pictures, background, red] = out.split(' [');
	assert.equal(pictures, 'True', 'the pictures are untouched');
	assert.equal('[' + background, '[255, 0, 255, 0]', 'colour 0 stays the background');
	assert.equal('[' + red, '[40, 200, 40]', 'red turned 120 degrees is green');
});

test('weapontable.lub gets the name and the base type, and keeps the looks already there', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkweapon-'));
	const file = path.join(dir, 'weapontable.lub');
	py(`m.write_table(${JSON.stringify(file)}, 5001, "_jade", 1); m.write_table(${JSON.stringify(file)}, 5002, "_ember", 2)`);
	const text = fs.readFileSync(file, 'utf8');
	assert.match(text, /WeaponNameTable = \{\n\t\[5001\] = "_jade",\n\t\[5002\] = "_ember",\n\}/);
	assert.match(text, /Expansion_Weapon_IDs = \{\n\t\[5001\] = 1,\n\t\[5002\] = 2,\n\}/);
});

test('a Korean client path becomes the URL the app serves it at', () => {
	assert.equal(py(`print(m.client_path("data/sprite/인간족/로그/로그_여_단검.spr"))`),
		'data/sprite/%C3%80%C3%8E%C2%B0%C2%A3%C3%81%C2%B7/%C2%B7%C3%8E%C2%B1%C3%97/%C2%B7%C3%8E%C2%B1%C3%97_%C2%BF%C2%A9_%C2%B4%C3%9C%C2%B0%C3%8B.spr');
});
