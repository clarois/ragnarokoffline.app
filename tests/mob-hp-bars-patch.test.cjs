// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const why = result => result.stderr || (result.error && result.error.message) || `exit code ${result.status}`;

// The clif_getareachar block the script rewrites, as rAthena ships it: the HP bar
// goes only to players in the mob's damage log.
const ANCHOR = [
  '#if PACKETVER >= 20120404',
  '\t\t\tif (battle_config.monster_hp_bars_info && !map_getmapflag(bl->m, MF_HIDEMOBHPBAR)) {',
  '\t\t\t\t// Must show hp bar to all char who already hit the mob.',
  '\t\t\t\tfor( const auto& entry : md->dmglog ){',
  '\t\t\t\t\tif( entry.id == sd->status.char_id ){',
  '\t\t\t\t\t\tclif_monster_hp_bar(md, sd->fd);',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t}',
  '#endif',
].join('\n');

test('mob HP bar hook is idempotent and fails loudly on changed anchors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mob-hp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clif = path.join(root, 'clif.cpp');
  const original = `void clif_getareachar_cell() {\n${ANCHOR}\n\tclif_name_area(md);\n}\n`;
  fs.writeFileSync(clif, original);
  const run = () => spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [path.join(__dirname, '../scripts/apply-mob-hp-bars.py'), clif], { encoding: 'utf8' });

  let result = run(); assert.equal(result.status, 0, why(result));
  const once = fs.readFileSync(clif, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(once.includes('HP before engaging'));
  assert.ok(once.includes('clif_monster_hp_bar(md, sd->fd);'));
  assert.ok(!once.includes('Must show hp bar to all char who already hit the mob'));
  // Still exactly one send, inside the same config gate.
  assert.equal(once.split('clif_monster_hp_bar(md, sd->fd);').length - 1, 1);
  assert.ok(once.includes('battle_config.monster_hp_bars_info && !map_getmapflag(bl->m, MF_HIDEMOBHPBAR)'));

  // Re-running on the patched file changes nothing.
  result = run(); assert.equal(result.status, 0, why(result));
  assert.equal(fs.readFileSync(clif, 'utf8').replace(/\r\n/g, '\n'), once);

  // rAthena moved under the anchor: refuse rather than ship a half-patched view path.
  fs.writeFileSync(clif, original.replace('dmglog', 'damage_log'));
  result = run(); assert.notEqual(result.status, 0);
  assert.match(why(result), /anchor expected exactly once/);
  assert.equal(fs.readFileSync(clif, 'utf8').replace(/\r\n/g, '\n'), original.replace('dmglog', 'damage_log'));
});
