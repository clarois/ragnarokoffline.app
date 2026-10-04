#!/usr/bin/env node
'use strict';
// A stand-in for docker-slim with just enough of a `ragnarok-db` container
// behind it for `ragnarok-stack db` (tests/db-browser-transport.test.cjs).
//
// The database is rAthena's `char` table (tests/fixtures/rathena-char-table.sql)
// with the rows in $FAKE_DB, answering the statements stack/src/database.rs
// builds. Two ways in, as on the real thing:
//
//   exec -i ragnarok-db mariadb ...          the answer on exec's stdout, put
//                                            through docker-slim's demux as it
//                                            is at the pinned commit: framed by
//                                            the daemon, read back 8 KiB at a
//                                            time, a frame that straddles two
//                                            reads dropped
//   exec -i ragnarok-db sh -c '... > /backups/x 2> /backups/y'
//                                            the answer in a file under
//                                            $FAKE_STATE/backups, which is
//                                            where /backups is mounted
//
// With a `cp` object in $FAKE_DB it is also the database behind
// `ragnarok-stack cp` (tests/control-panel-transport.test.cjs): rows of
// login, char, guild, party, inventory and the rest by column name, answering
// the statements stack/src/control_panel.rs builds. Every write it runs is
// kept in `cp.log`, and a statement containing `cp.failOn` fails the way
// mariadb fails, so a rollback can be tested.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const dbFile = process.env.FAKE_DB;
const backups = path.join(state, 'backups');
// The container's own /tmp, where backups are dumped before `docker cp` brings them out.
const containerTmp = path.join(state, 'container-tmp');
fs.mkdirSync(containerTmp, { recursive: true });
const inContainer = file => (file.startsWith('/tmp/') ? path.join(containerTmp, path.basename(file)) : path.join(backups, path.basename(file)));
const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const unhex = h => Buffer.from(h, 'hex').toString('utf8');

function columns() {
	const sql = fs.readFileSync(path.join(__dirname, 'rathena-char-table.sql'), 'utf8');
	return sql.split('\n').filter(l => l.startsWith('  `')).map(line => {
		const [, name, rest] = line.match(/^ {2}`([^`]+)` (.*)$/);
		const lower = rest.toLowerCase();
		const typeWord = lower.split(/\s+/)[0];
		const def = rest.match(/default '([^']*)'/i);
		return {
			name,
			type: lower.includes(' unsigned') ? `${typeWord} unsigned` : typeWord,
			dataType: typeWord.split('(')[0],
			nullable: !lower.includes('not null'),
			default: def ? `'${def[1]}'` : (lower.includes('default null') ? 'NULL' : null),
			extra: lower.includes('auto_increment') ? 'auto_increment' : '',
		};
	});
}

function cell(v) { return v === null ? 'NULL' : hex(v); }

function answer(sql) {
	const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
	const cols = columns();
	const out = [];
	const lines = sql.split('\n');
	for (const [n, line] of lines.entries()) {
		let m;
		const cp = db.cp && cpStatement(line, db.cp);
		if (cp && cp.error) {
			// mariadb stops at the first error and names its line. A script is
			// not undone: what ran before it stays written, as on MyISAM.
			fs.writeFileSync(dbFile, JSON.stringify(db));
			return { out: '', error: `ERROR 1146 (42S02) at line ${n + 1}: ${cp.error}` };
		}
		if (cp) { out.push(...cp); continue; }
		if (/information_schema\.TABLES/.test(line)) {
			for (const [name, rows] of [['char', db.rows.length], ['inventory', 0], ['login', 2]]) out.push(`t\t${hex(name)}\t${rows}\t${hex('MyISAM')}`);
		} else if (/information_schema\.STATISTICS/.test(line) && /SELECT 'k', HEX\(TABLE_NAME\)/.test(line)) {
			out.push(`k\t${hex('char')}\t${hex('char_id')}`, `k\t${hex('inventory')}\t${hex('id')}`, `k\t${hex('login')}\t${hex('account_id')}`);
		} else if ((m = line.match(/information_schema\.COLUMNS .*TABLE_NAME = X'([0-9A-F]*)'/))) {
			if (unhex(m[1]) === 'char') {
				for (const c of cols) out.push(['c', hex(c.name), hex(c.type), hex(c.dataType), c.nullable ? 'YES' : 'NO', c.default === null ? 'NULL' : hex(c.default), hex(c.extra)].join('\t'));
			}
		} else if ((m = line.match(/information_schema\.STATISTICS .*TABLE_NAME = X'([0-9A-F]*)'/))) {
			if (unhex(m[1]) === 'char') out.push(`k\t${hex('char_id')}`);
		} else if (/^SELECT 'c', COUNT\(\*\) FROM `char`;$/.test(line)) {
			out.push(`c\t${db.rows.length}`);
		} else if ((m = line.match(/^SELECT 'r', .* FROM `char` ORDER BY `char_id` LIMIT (\d+) OFFSET (\d+);$/))) {
			const rows = [...db.rows].sort((a, b) => Number(a[0]) - Number(b[0])).slice(Number(m[2]), Number(m[2]) + Number(m[1]));
			for (const r of rows) out.push(['r', ...r.map(cell)].join('\t'));
		} else if ((m = line.match(/^SELECT (\d+), x\.\* FROM \(SELECT 1 FROM `char` WHERE `char_id` = (\d+) LIMIT 2\) AS x;$/))) {
			if (db.rows.some(r => r[0] === m[2])) out.push(`${m[1]}\t1`);
		} else if ((m = line.match(/^DELETE FROM `char` WHERE `char_id` = (\d+) LIMIT 1;$/))) {
			db.rows = db.rows.filter(r => r[0] !== m[1]);
			fs.writeFileSync(dbFile, JSON.stringify(db));
		} else if ((m = line.match(/^SELECT '([a-z-]+)';$/))) {
			out.push(m[1]);
		}
	}
	if (db.cp) fs.writeFileSync(dbFile, JSON.stringify(db));
	return { out: out.length ? out.join('\n') + '\n' : '', error: '' };
}

// ---- The control panel's statements

const PLAYER = a => a.sex !== 'S' && Number(a.account_id) >= 2000000
	&& !(Number(a.group_id) === 20 && /^aiagent[0-9]?$/.test(a.userid));
const TABLE_OF = { c: 'char', l: 'login', g: 'guild', p: 'party', i: 'inventory' };

// The columns a SELECT asks for, by alias: HEX(c.`name`), HEX(CAST(c.`zeny` AS CHAR)).
function selected(line) {
	return [...line.matchAll(/HEX\((?:CAST\()?([a-z])\.`([a-z_0-9]+)`/g)].map(m => [m[1], m[2]]);
}

function joinedChars(cp) {
	return cp.char.map(c => {
		const l = cp.login.find(a => a.account_id === c.account_id);
		return { c, l, g: cp.guild.find(g => g.guild_id === c.guild_id) || null, p: cp.party.find(p => p.party_id === c.party_id) || null };
	}).filter(r => r.l && PLAYER(r.l));
}

function value(row, column) {
	if (!row) return null;
	const v = row[column];
	return v === undefined || v === null ? null : String(v);
}

// One statement of a control panel script. Returns the lines it answers, or
// an error string; null when the line is not one of these.
function cpStatement(line, cp) {
	let m;
	const hexRow = (tag, cols, rows) => rows.map(r => [tag, ...cols.map(([alias, col]) => cell(value(r[alias], col)))].join('\t'));
	if (/^SELECT 'a', /.test(line)) {
		return hexRow('a', selected(line), cp.login.filter(PLAYER).map(l => ({ l })));
	}
	if (/^SELECT 'c', /.test(line)) {
		const only = line.match(/c\.`char_id` = (\d+) AND/);
		return hexRow('c', selected(line), joinedChars(cp).filter(r => !only || String(r.c.char_id) === only[1]));
	}
	if ((m = line.match(/^SELECT 'e', .* i\.`char_id` = (\d+) AND i\.`equip` <> 0/))) {
		return hexRow('e', selected(line), cp.inventory.filter(i => String(i.char_id) === m[1] && Number(i.equip)).map(i => ({ i })));
	}
	if ((m = line.match(/^SELECT 'n', \(SELECT COUNT\(\*\) FROM `inventory` WHERE `char_id` = (\d+)\)/))) {
		const c = cp.char.find(x => String(x.char_id) === m[1]);
		const count = (table, key, v) => (cp[table] || []).filter(r => String(r[key]) === String(v)).length;
		return [`n\t${count('inventory', 'char_id', m[1])}\t${count('cart_inventory', 'char_id', m[1])}\t${c ? count('storage', 'account_id', c.account_id) : 0}`];
	}
	if ((m = line.match(/^SELECT 'o', COUNT\(\*\) FROM `char` WHERE `account_id` = (\d+) AND `online` <> 0;$/))) {
		return [`o\t${cp.char.filter(c => String(c.account_id) === m[1] && Number(c.online)).length}`];
	}
	if ((m = line.match(/^SELECT 'g', COUNT\(\*\) FROM `guild` WHERE `char_id` = (\d+);$/))) {
		return [`g\t${cp.guild.filter(g => String(g.char_id) === m[1]).length}`];
	}
	if ((m = line.match(/^UPDATE `char` AS c LEFT JOIN `char` AS o .* SET (.*), c\.`last_instanceid` = 0 WHERE c\.`char_id` = (\d+) AND c\.`online` = 0 AND o\.`char_id` IS NULL;$/))) {
		cp.log.push(line);
		const c = cp.char.find(x => String(x.char_id) === m[2]);
		const busy = c && cp.char.some(o => o.account_id === c.account_id && Number(o.online));
		cp.rowCount = 0;
		if (c && !Number(c.online) && !busy) {
			const point = m[1].match(/c\.`last_map` = X'([0-9A-F]*)', c\.`last_x` = (\d+), c\.`last_y` = (\d+)/);
			const [map, x, y] = point ? [unhex(point[1]), Number(point[2]), Number(point[3])] : [c.save_map, c.save_x, c.save_y];
			if (c.last_map !== map || c.last_x !== x || c.last_y !== y || c.last_instanceid) cp.rowCount = 1;
			Object.assign(c, { last_map: map, last_x: x, last_y: y, last_instanceid: 0 });
		}
		return [];
	}
	if (/^SELECT 'n', ROW_COUNT\(\);$/.test(line)) return [`n\t${cp.rowCount || 0}`];
	if (/^(DELETE|UPDATE|INSERT) /.test(line)) {
		if (cp.failOn && line.includes(cp.failOn)) return { error: `Table 'ragnarok.${cp.failOn}' doesn't exist` };
		cp.log.push(line);
		// What the tests look at afterwards: rows keyed by char_id go.
		if ((m = line.match(/^DELETE FROM `([a-z_]+)` WHERE `char_id` = (\d+);$/)) && cp[m[1]]) {
			cp[m[1]] = cp[m[1]].filter(r => String(r.char_id) !== m[2]);
		}
		return [];
	}
	if (/^(SET SESSION|START TRANSACTION;|COMMIT;|ROLLBACK;)/.test(line)) return [];
	return null;
}

// slimd frames each read of the process's stdout; slim-client reads its
// socket 8 KiB at a time and demultiplexes every read on its own
// (slim-client/src/http.rs demux_stdcopy).
function throughSlimExec(text) {
	const bytes = Buffer.from(text, 'utf8');
	const frames = [];
	for (let i = 0; i < bytes.length; i += 4096) {
		const payload = bytes.subarray(i, i + 4096);
		const head = Buffer.alloc(8);
		head[0] = 1;
		head.writeUInt32BE(payload.length, 4);
		frames.push(head, payload);
	}
	const wire = Buffer.concat(frames);
	const out = [];
	for (let r = 0; r < wire.length; r += 8192) {
		const read = wire.subarray(r, r + 8192);
		let i = 0;
		while (i + 8 <= read.length) {
			const stream = read[i];
			const len = read.readUInt32BE(i + 4);
			i += 8;
			if (i + len > read.length) break;
			if (stream !== 2) out.push(read.subarray(i, i + len));
			i += len;
		}
	}
	return Buffer.concat(out);
}

const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const [verb] = args;

if (verb === 'capabilities') { process.stdout.write('exec-stdin-eof-v1\n'); process.exit(0); }
if (verb === 'inspect') {
	const name = args[args.length - 1];
	if (name !== 'ragnarok-db') { process.stderr.write(`No such container: ${name}\n`); process.exit(1); }
	if (args.includes('-f')) { process.stdout.write('running\n'); process.exit(0); }
	process.stdout.write(JSON.stringify([{ State: { Status: 'running', StartedAt: '2026-10-01T00:00:00.000000000Z' },
		Mounts: [{ Destination: '/var/lib/mysql', Type: 'volume', Name: 'ragnarokmac-db' }] }]));
	process.exit(0);
}
if (verb === 'exec') {
	const rest = args.slice(1).filter(a => a !== '-i');
	const [container, program, ...more] = rest;
	if (container !== 'ragnarok-db') process.exit(1);
	if (program === 'mariadb') { process.stdout.write(throughSlimExec(answer(stdin()).out)); process.exit(0); }
	if (program === 'rm') {
		for (const f of more.filter(a => a.startsWith('/backups/') || a.startsWith('/tmp/'))) fs.rmSync(inContainer(f), { force: true });
		process.exit(0);
	}
	if (program === 'sh' && more[0] === '-c') {
		const command = more[1];
		// load_dump streams the backup into the container's /tmp on stdin,
		// checks its size, then feeds it to `mariadb ragnarok < /tmp/...`.
		const write = command.match(/cat > '(\/tmp\/[A-Za-z0-9._-]+)'$/);
		if (write) { fs.writeFileSync(inContainer(write[1]), fs.readFileSync(0)); process.exit(0); }
		const size = command.match(/^wc -c < '(\/tmp\/[A-Za-z0-9._-]+)'$/);
		if (size) {
			if (!fs.existsSync(inContainer(size[1]))) { process.stderr.write('sh: no such file\n'); process.exit(1); }
			process.stdout.write(`${fs.statSync(inContainer(size[1])).size}\n`);
			process.exit(0);
		}
		const restore = command.match(/< (\/(?:backups|tmp)\/[A-Za-z0-9._-]+)$/);
		if (restore) {
			// The dump's own first line, and the app's version stamp, are
			// comments the real database skips.
			const dump = fs.readFileSync(inContainer(restore[1]), 'utf8').replace(/^-- Ragnarok Offline backup: .*\n/m, '');
			fs.writeFileSync(dbFile, dump.slice(dump.indexOf('\n') + 1));
			process.exit(0);
		}
		const target = command.match(/> (\/(?:backups|tmp)\/[A-Za-z0-9._-]+)/);
		if (!target) process.exit(2);
		if (/mariadb-dump /.test(command)) {
			fs.writeFileSync(inContainer(target[1]), '-- fake dump of `char`\n' + fs.readFileSync(dbFile, 'utf8'));
			process.exit(0);
		}
		const errors = command.match(/2> \/backups\/([A-Za-z0-9._-]+)/);
		const result = answer(stdin());
		fs.writeFileSync(inContainer(target[1]), result.out);
		if (errors) fs.writeFileSync(path.join(backups, errors[1]), result.error ? result.error + '\n' : '');
		process.exit(result.error ? 1 : 0);
	}
	process.exit(1);
}
// docker cp ragnarok-db:/tmp/<dump> <name>, run from the destination folder.
if (verb === 'cp' && args[1] && args[1].startsWith('ragnarok-db:')) {
	const from = inContainer(args[1].slice('ragnarok-db:'.length));
	if (!fs.existsSync(from)) process.exit(1);
	fs.copyFileSync(from, path.resolve(process.cwd(), args[2]));
	process.exit(0);
}
// ps, stop, start, logs: nothing is running but the database.
process.exit(0);
