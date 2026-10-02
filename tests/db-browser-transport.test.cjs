'use strict';
// The database browser end to end, through the real `ragnarok-stack db`
// against a fake docker client with rAthena's `char` table behind it
// (tests/fixtures/fake-docker-db.cjs).
//
// The bug this is for: picking `char` -- 80 columns, 38 rows -- showed "The
// database answered in a form this tool does not read" over an empty grid,
// typically right after saving a delete. Its answer is ~23 KiB, and the answer
// came back over `docker exec`'s stdout, which docker-slim cuts short past
// 8 KiB. The fake reproduces that cut; the fix reads the answer from a file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const skip = !process.env.STACK_BIN ? 'needs STACK_BIN' : process.platform === 'win32' ? 'the fake docker is a #! script' : false;

function charRows() {
	const sql = fs.readFileSync(path.join(__dirname, 'fixtures', 'rathena-char-table.sql'), 'utf8');
	const cols = sql.split('\n').filter(l => l.startsWith('  `')).map(l => l.match(/^ {2}`([^`]+)`/)[1]);
	const names = ['Agent', '포링마스터', 'ACompanionWithALongName', '[PE] Aria the Archer', 'Tab\tIn\\Name', 'x'];
	const rows = [];
	for (let i = 0; i < 38; i++) {
		rows.push(cols.map(c => {
			switch (c) {
				case 'char_id': return String(150000 + i);
				case 'account_id': return String(2000000 + Math.floor(i / 3));
				case 'name': return `${names[i % names.length]}${i}`;
				case 'base_exp': case 'job_exp': return i === 7 ? '18446744073709551615' : String(i * 37 % 1000);
				case 'zeny': return '4294967295';
				case 'last_map': case 'save_map': return 'prontera';
				case 'sex': return i % 2 ? 'F' : 'M';
				case 'last_login': return [null, '0000-00-00 00:00:00', '2026-09-30 21:14:05'][i % 3];
				default: return String(i * 37 % 1000);
			}
		}));
	}
	return { cols, rows };
}

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-db-transport-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const state = path.join(dir, 'state');
	fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
	const fake = path.join(dir, 'docker');
	fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-docker-db.cjs'), fake);
	fs.copyFileSync(path.join(__dirname, 'fixtures', 'rathena-char-table.sql'), path.join(dir, 'rathena-char-table.sql'));
	fs.chmodSync(fake, 0o755);
	const db = path.join(dir, 'db.json');
	const { cols, rows } = charRows();
	fs.writeFileSync(db, JSON.stringify({ rows }));
	const run = (args, input = '') => {
		const r = spawnSync(process.env.STACK_BIN, ['db', ...args], {
			input, encoding: 'utf8', timeout: 30000,
			env: { ...process.env, RAGNAROK_OFFLINE_ROOT: dir, RAGNAROKMAC_STATE: state, NEBULA_HOME: path.join(dir, 'nebula'),
				NEBULA_BIN: fake, RAGNAROKMAC_DOCKER: fake, FAKE_STATE: state, FAKE_DB: db },
		});
		if (r.status !== 0) return { error: (r.stderr || '').trim() || `exit ${r.status}` };
		return JSON.parse(r.stdout);
	};
	return { state, db, cols, rows, run };
}

test('a page of the char table is read whole', { skip }, t => {
	const { cols, rows, run, state } = fixture(t);
	const tables = run(['tables']);
	assert.equal(tables.error, undefined, tables.error);
	assert.equal(tables.tables.find(x => x.name === 'char').rows, 38);
	const schema = run(['describe', 'char']);
	assert.equal(schema.columns.length, 80);
	const page = run(['rows'], JSON.stringify({ table: 'char', limit: 100, offset: 0 }));
	assert.equal(page.error, undefined, page.error);
	assert.equal(page.total, 38);
	assert.equal(page.rows.length, 38);
	assert.deepEqual(page.rows, rows);
	assert.equal(page.rows[7][cols.indexOf('base_exp')], '18446744073709551615');
	// Nothing left behind in the backups folder.
	assert.deepEqual(fs.readdirSync(path.join(state, 'backups')), []);
});

test('deleting a character saves, backs up, and reads back without it', { skip }, t => {
	const { cols, run, state, db } = fixture(t);
	const before = run(['rows'], JSON.stringify({ table: 'char' }));
	assert.equal(before.total, 38, before.error);
	const victim = before.rows[12][cols.indexOf('char_id')];
	const saved = run(['apply'], JSON.stringify({ changes: [{ table: 'char', key: { char_id: victim }, delete: true }] }));
	assert.equal(saved.error, undefined, saved.error);
	assert.equal(saved.applied, 1);
	assert.ok(fs.existsSync(saved.backup), saved.backup);
	assert.match(fs.readFileSync(saved.backup, 'utf8'), new RegExp(`"${victim}"`));
	assert.equal(JSON.parse(fs.readFileSync(db, 'utf8')).rows.length, 37);
	const after = run(['rows'], JSON.stringify({ table: 'char' }));
	assert.equal(after.error, undefined, after.error);
	assert.equal(after.total, 37);
	assert.ok(!after.rows.some(r => r[0] === victim));
	assert.equal(run(['tables']).tables.find(x => x.name === 'char').rows, 37);
	// Deleting it again is refused before anything stops, and says so.
	const again = run(['apply'], JSON.stringify({ changes: [{ table: 'char', key: { char_id: victim }, delete: true }] }));
	assert.match(again.error, /Nothing was saved: delete char \(char_id=\d+\) is no longer there/);
	assert.deepEqual(fs.readdirSync(path.join(state, 'backups')).filter(f => !f.startsWith('before-db-browser-')), []);
});
