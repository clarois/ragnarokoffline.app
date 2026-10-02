'use strict';
// Unpacking a mod that arrived as an archive: a zip, or a RAR.
//
// One path for every way an archive gets here -- one the player picked in
// Settings → Mods, a UI skin or cursor pack, and a release a registry entry
// points at -- so all of them get the same checks and none can drift into
// being the lenient one.
//
// What a file is decides how it is read, not what it is called: a release
// asset named `.zip` that is really a RAR is read as a RAR, and a file that
// is neither is refused before any tool is pointed at it.
//
// The unpacking itself is the operating system's (`ditto` on macOS, `tar`
// elsewhere, and libarchive's bsdtar for a RAR everywhere): they ship with
// the OS and the app needs no archive library. What this file adds is
// everything around it, done twice on purpose:
//
//   - before anything is written, the archive's own table of contents is read
//     and refused if it names a path outside the folder, a link, or more bytes
//     or files than the caller allows -- so a bomb is refused rather than
//     unpacked and then measured. A zip's is read here, byte by byte; a RAR's
//     is bsdtar's listing, and a listing that cannot be read with certainty
//     is a refusal, never a pass;
//   - after unpacking, the tree on disk is walked with lstat and checked
//     again, because that is what will actually be copied, and a format this
//     reader does not understand (zip64) must not be a way around the first.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Refuse anything that would land outside the destination: `../`, an absolute
// path, or a drive letter. Zip-slip is the classic way an unpack becomes an
// arbitrary write.
function safeEntryName(name) {
	if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return null;
	const parts = name.split(/[\\/]/);
	if (parts.some(p => p === '..')) return null;
	return name;
}

// One folder, named for the mod. Anything else is a zip somebody built by
// selecting the files instead of the directory, and unpacking it would strew
// db/ and npc/ across the mods root.
function singleTopLevel(names) {
	const tops = new Set(names.map(n => n.split('/')[0]).filter(Boolean));
	return tops.size === 1 ? [...tops][0] : null;
}

// Finder's resource-fork litter, which is not part of anybody's mod.
const litter = name => name.split('/').some(p => p === '__MACOSX' || p.startsWith('._') || p === '.DS_Store');

/**
 * The entries a zip says it holds, read from its central directory without
 * unpacking anything. Null when the archive uses a form this reader does not
 * handle (zip64, a split archive); the walk after unpacking still applies.
 */
function zipEntries(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const size = fs.fstatSync(fd).size;
		const tail = Math.min(size, 22 + 0xffff);
		const end = Buffer.alloc(tail);
		fs.readSync(fd, end, 0, tail, size - tail);
		let at = -1;
		for (let i = tail - 22; i >= 0; i--) {
			if (end.readUInt32LE(i) === 0x06054b50) { at = i; break; }
		}
		if (at < 0) throw new Error('That file is not a zip archive.');
		const count = end.readUInt16LE(at + 10);
		const length = end.readUInt32LE(at + 12);
		const offset = end.readUInt32LE(at + 16);
		if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) return null;
		if (end.readUInt16LE(at + 4) !== 0 || offset + length > size) return null;
		const directory = Buffer.alloc(length);
		fs.readSync(fd, directory, 0, length, offset);
		const entries = [];
		let p = 0;
		for (let i = 0; i < count; i++) {
			if (p + 46 > length || directory.readUInt32LE(p) !== 0x02014b50) return null;
			const madeBy = directory.readUInt16LE(p + 4) >> 8;
			const unpacked = directory.readUInt32LE(p + 24);
			const nameLength = directory.readUInt16LE(p + 28);
			const extraLength = directory.readUInt16LE(p + 30);
			const commentLength = directory.readUInt16LE(p + 32);
			const attributes = directory.readUInt32LE(p + 38);
			if (unpacked === 0xffffffff) return null;
			const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
			// Unix permissions live in the high half of the external
			// attributes; S_IFLNK there is a link the unpacker will recreate.
			const mode = (attributes >>> 16) & 0o170000;
			entries.push({ name, size: unpacked, symlink: madeBy === 3 && mode === 0o120000,
				directory: name.endsWith('/') });
			p += 46 + nameLength + extraLength + commentLength;
		}
		return entries;
	} finally {
		fs.closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// What kind of archive a file is, from its first bytes.

const RAR4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const NOT_AN_ARCHIVE = 'That file is not a .zip or .rar archive, which are the formats a mod can be installed from.';

/** 'zip', 'rar', or null for anything else. Read from the content, never the name. */
function sniff(file) {
	const head = Buffer.alloc(8);
	const fd = fs.openSync(file, 'r');
	let got;
	try { got = fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
	const bytes = head.subarray(0, got);
	// PK\3\4 a local file header, PK\5\6 an empty zip, PK\7\8 a spanned one.
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
		&& ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8))) return 'zip';
	if (bytes.subarray(0, RAR5.length).equals(RAR5) || bytes.subarray(0, RAR4.length).equals(RAR4)) return 'rar';
	return null;
}

// ---------------------------------------------------------------------------
// RAR, through libarchive's bsdtar.
//
// bsdtar reads RAR 4 and, from libarchive 3.4, RAR 5. It ships with macOS as
// /usr/bin/tar and with Windows 10 and 11 as System32\tar.exe (3.5.2 on
// Windows 10 22H2). On Linux it is `bsdtar`, a package of its own; GNU tar
// and unzip cannot read a RAR at all, so there is no falling back to them.

const BSDTAR_MISSING = 'Install bsdtar (libarchive-tools) to open .rar mods.';

function bsdtarPath() {
	if (process.platform === 'darwin') return '/usr/bin/tar';
	// By full path, as for a zip: Git's GNU tar is often first on PATH (#174).
	if (process.platform === 'win32') return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
	return 'bsdtar';
}

/** Run bsdtar and return what it printed, as bytes. */
function runBsdtar(args, { env } = {}) {
	try {
		return execFileSync(bsdtarPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
			timeout: 5 * 60 * 1000, env: env ? { ...process.env, ...env } : process.env });
	} catch (e) {
		if (e.code === 'ENOENT') throw new Error(process.platform === 'linux' ? BSDTAR_MISSING : `${bsdtarPath()} is missing, so a .rar cannot be opened.`);
		const said = e.stderr ? e.stderr.toString('utf8').trim().split('\n').pop() : '';
		throw new Error(`Could not read the .rar (${said || e.message}).`);
	}
}

/**
 * Undo bsdtar's escaping of a listed name: `\\`, the C escapes, and `\ooo`
 * for each byte it would not print -- every non-ASCII byte, in the C locale
 * it is run under. Anything else passes through. Null for an escape bsdtar
 * does not write.
 */
function unescapeListed(raw) {
	const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };
	const bytes = Buffer.from(raw, 'latin1');
	const out = [];
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0x5c) { out.push(bytes[i]); continue; }
		const next = String.fromCharCode(bytes[i + 1]);
		if (Object.hasOwn(simple, next)) { out.push(simple[next]); i += 1; continue; }
		const octal = bytes.subarray(i + 1, i + 4).toString('latin1');
		if (!/^[0-3][0-7]{2}$/.test(octal)) return null;
		out.push(parseInt(octal, 8));
		i += 3;
	}
	return Buffer.from(out).toString('utf8');
}

// `-rw-r--r--  0 0      0     1800014 Sep 28 07:39` -- a long listing line
// up to the name. --numeric-owner, so that no owner name with a space in it
// can move a column; the date is three words in every form bsdtar prints it
// (`%b %e %H:%M`, `%b %e  %Y`, or either with the day first).
const LONG_PREFIX = /^([-dlhbcpsw?])[-rwxsStTlL]{9}[+@.]? +\d+ +\d+ +\d+ +(\S+) +\S+ +\S+ +\S+$/;

/**
 * Turn bsdtar's two listings of one archive -- `-tf` (names, one a line) and
 * `-tvf` (the same entries, long form, in the same order) -- into entries in
 * the shape zipEntries returns, plus `special` for anything that is neither a
 * file, a folder nor a link. Throws when the two do not agree line for line
 * or a line cannot be read: an archive whose listing is in doubt is not
 * unpacked.
 */
function parseRarListing(namesText, longText) {
	const lines = text => {
		// Windows' tar.exe ends its lines with CRLF. A CR in a name is
		// printed as `\r`, so a real one is only ever a line ending.
		const all = text.split('\n').map(l => l.replace(/\r$/, ''));
		if (all.length && all[all.length - 1] === '') all.pop();
		return all;
	};
	const names = lines(namesText);
	const long = lines(longText);
	const unreadable = what => new Error(`Could not read what the .rar holds (${what}), so it was not unpacked.`);
	if (!names.length) throw unreadable('it lists nothing');
	if (names.length !== long.length) throw unreadable('its two listings disagree');
	return names.map((raw, i) => {
		const line = long[i];
		const name = unescapeListed(raw);
		if (name === null) throw unreadable(`an entry listed as ${JSON.stringify(raw)}`);
		const link = { name, size: 0, symlink: true, directory: false, special: false };
		const type = line[0];
		if (type === 'l' || type === 'h') return link;
		if (!line.endsWith(` ${raw}`)) {
			// A hard link keeps its target's type and says `link to` after
			// the name; a symbolic one says `->`.
			if (line.includes(` ${raw} link to `) || line.includes(` ${raw} -> `)) return link;
			throw unreadable(`the entry ${JSON.stringify(raw)}`);
		}
		const m = LONG_PREFIX.exec(line.slice(0, line.length - raw.length - 1));
		if (!m) throw unreadable(`the entry ${JSON.stringify(raw)}`);
		if (type === 'd') return { name, size: 0, symlink: false, directory: true, special: false };
		if (type !== '-') return { name, size: 0, symlink: false, directory: false, special: true };
		if (!/^\d+$/.test(m[2])) throw unreadable(`the size of ${JSON.stringify(raw)}`);
		return { name, size: Number(m[2]), symlink: false, directory: false, special: false };
	});
}

/**
 * The entries a RAR says it holds, from bsdtar's listing, without unpacking
 * anything. `run` is bsdtar, replaceable in tests.
 */
function rarEntries(file, run = runBsdtar) {
	// The C locale, so every byte that is not plain ASCII comes out as
	// `\ooo` and what is parsed does not depend on the player's language.
	const env = { LC_ALL: 'C', LANG: 'C' };
	const names = run(['-tf', file], { env });
	const long = run(['--numeric-owner', '-tvf', file], { env });
	return parseRarListing(Buffer.from(names).toString('latin1'), Buffer.from(long).toString('latin1'));
}

function checkLimits(files, bytes, { maxBytes, maxFiles }, label) {
	if (files > maxFiles) throw new Error(`Refusing ${label}: it holds more than ${maxFiles} files.`);
	if (bytes > maxBytes) throw new Error(`Refusing ${label}: it unpacks to more than ${Math.round(maxBytes / 1048576)} MB.`);
}

function unpackWithOs(src, into, kind = 'zip') {
	if (kind === 'rar') {
		// No -P, so bsdtar itself refuses absolute paths, `..` and writing
		// through a link; the owner and permissions the archive records are
		// not applied.
		runBsdtar(['-x', '--no-same-owner', '--no-same-permissions', '-f', src, '-C', into]);
		return;
	}
	if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', src, into]);
	// On Windows, by full path: Git's GNU tar is often first on PATH, and it
	// reads `C:` as a remote host and cannot open a zip at all (#174).
	else if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', src, '-C', into]);
	else {
		// GNU tar, which is what `tar` is on most Linux systems, cannot read
		// a zip at all; libarchive's bsdtar (SteamOS has it) and Info-ZIP's
		// unzip can. Tried in that order, GNU tar last for anything else.
		const tries = [['bsdtar', ['-xf', src, '-C', into]], ['unzip', ['-q', '-o', src, '-d', into]], ['tar', ['-xf', src, '-C', into]]];
		let last;
		for (const [tool, args] of tries) {
			try { execFileSync(tool, args, { stdio: 'ignore' }); return; } catch (e) {
				last = e;
				if (e.code !== 'ENOENT') break;
			}
		}
		throw new Error(`Could not unpack the zip (${(last && last.message) || 'no unzip tool found'}).`);
	}
}

/** Every regular file under `dir`, relative and with `/`; links are refused. */
function walk(dir, label, rel = '') {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relative = rel ? `${rel}/${entry.name}` : entry.name;
		const full = path.join(dir, entry.name);
		const stat = fs.lstatSync(full);
		if (stat.isSymbolicLink()) throw new Error(`Refusing ${label}: it contains a link (${relative}).`);
		// A hard link is an ordinary file to lstat, except that it is not the
		// only name its bytes have. Nothing freshly unpacked needs one.
		if (stat.isFile() && stat.nlink > 1) throw new Error(`Refusing ${label}: it contains a link (${relative}).`);
		if (stat.isDirectory()) out.push(...walk(full, label, relative));
		else if (stat.isFile()) out.push({ path: relative, size: stat.size });
		else throw new Error(`Refusing ${label}: ${relative} is not an ordinary file.`);
	}
	return out;
}

/**
 * Unpack `src` into a new scratch directory and check what came out.
 *
 * Returns `{ dir, files }`; the caller owns `dir` and removes it. Nothing is
 * left behind when this throws.
 */
function unpack(src, { maxBytes = 2 * 1024 ** 3, maxFiles = 50000, label = src, listRar = rarEntries } = {}) {
	const kind = sniff(src);
	if (!kind) throw new Error(NOT_AN_ARCHIVE);
	// A RAR is always listed first: unlike zip64, there is no form of one
	// that goes to the unpacker unread.
	const listed = kind === 'rar' ? listRar(src) : zipEntries(src);
	if (listed) {
		const real = listed.filter(e => !litter(e.name));
		for (const e of real) {
			if (!safeEntryName(e.name.replace(/\/$/, ''))) throw new Error(`Refusing ${label}: it contains an unsafe path (${e.name}).`);
			if (e.symlink) throw new Error(`Refusing ${label}: it contains a link (${e.name}).`);
			if (e.special) throw new Error(`Refusing ${label}: ${e.name} is not an ordinary file.`);
		}
		const files = real.filter(e => !e.directory);
		checkLimits(files.length, files.reduce((sum, e) => sum + e.size, 0), { maxBytes, maxFiles }, label);
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-'));
	try {
		unpackWithOs(src, dir, kind);
		for (const name of fs.readdirSync(dir)) {
			if (litter(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
		}
		const files = walk(dir, label).filter(f => !litter(f.path));
		if (!files.length) throw new Error('That archive is empty.');
		for (const f of files) {
			if (!safeEntryName(f.path)) throw new Error(`Refusing ${label}: it contains an unsafe path (${f.path}).`);
		}
		checkLimits(files.length, files.reduce((sum, f) => sum + f.size, 0), { maxBytes, maxFiles }, label);
		return { dir, files: files.map(f => f.path) };
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw e;
	}
}

/** Copy a checked tree, leaving Finder's litter behind. */
function copyTree(from, to) {
	fs.cpSync(from, to, { recursive: true, filter: source => !litter(path.basename(source)) });
}

module.exports = { unpack, sniff, zipEntries, rarEntries, parseRarListing, unescapeListed, safeEntryName, singleTopLevel,
	copyTree, litter, BSDTAR_MISSING };
