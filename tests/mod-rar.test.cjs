'use strict';
// Mods that arrive as a RAR, and telling a RAR from a zip by its content.
//
// The listing parser is tested on bsdtar's output written out by hand, so
// every refusal is checked on every platform. The fixtures in fixtures/rar/
// go through the real bsdtar where there is one -- /usr/bin/tar on macOS,
// System32\tar.exe on Windows, `bsdtar` on Linux -- and are skipped where
// there is not. They were made with RAR 7.20 (`rar a -r`, plus `-ol -oh` to
// store links as links):
//
//   arpg-equipments-layout.zip  igueradx/ARPG-Equipments-Mod v1.2.0's layout,
//                               every file a stub, and named .zip like the
//                               release asset it stands for
//   names.rar                   `my mod/npc/名前 ünï.txt`
//   links.rar                   a symbolic link and a hard link
//   hardlink.rar                a hard link alone
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const modZip = require('../electron/mod-zip');
const source = require('../electron/mod-source');

const FIXTURES = path.join(__dirname, 'fixtures', 'rar');
const fixture = name => path.join(FIXTURES, name);
const tempDir = tag => fs.mkdtempSync(path.join(os.tmpdir(), `ro-rar-${tag}-`));

// The bsdtar mod-zip.js would run, and whether it reads RAR 5 here.
const bsdtar = process.platform === 'darwin' ? '/usr/bin/tar'
  : process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
const haveBsdtar = (() => {
  try { execFileSync(bsdtar, ['-tf', fixture('names.rar')], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const real = { skip: haveBsdtar ? false : `no bsdtar that reads RAR 5 (${bsdtar})` };

const RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);

/** A file that sniffs as a RAR and is not one: any attempt to unpack it fails loudly. */
function fakeRar() {
  const file = path.join(tempDir('fake'), 'mod.zip');
  fs.writeFileSync(file, Buffer.concat([RAR5, Buffer.from('not really a rar')]));
  return file;
}

const entry = (name, extra = {}) => ({ name, size: 1, symlink: false, directory: false, special: false, ...extra });

// ---------------------------------------------------------------------------

test('an archive is known by its first bytes, not its name', () => {
  const dir = tempDir('sniff');
  const write = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
  assert.strictEqual(modZip.sniff(write('a.rar', Buffer.from('PK\x03\x04rest', 'latin1'))), 'zip');
  assert.strictEqual(modZip.sniff(write('empty.zip', Buffer.from('PK\x05\x06', 'latin1'))), 'zip');
  assert.strictEqual(modZip.sniff(write('b.zip', Buffer.concat([RAR5, Buffer.from('x')]))), 'rar');
  assert.strictEqual(modZip.sniff(write('c.zip', Buffer.concat([RAR4, Buffer.from('xx')]))), 'rar');
  assert.strictEqual(modZip.sniff(write('d.zip', Buffer.from([0x1f, 0x8b, 8, 0]))), null);
  assert.strictEqual(modZip.sniff(write('e.zip', Buffer.from('Rar!'))), null);
  assert.strictEqual(modZip.sniff(write('f.zip', Buffer.alloc(0))), null);
  assert.strictEqual(modZip.sniff(write('g.7z', Buffer.from('7z\xbc\xaf\x27\x1c', 'latin1'))), null);
  // Refused before any tool sees it, naming what would have been accepted.
  assert.throws(() => modZip.unpack(path.join(dir, 'd.zip')), /not a \.zip or \.rar archive/);
});

test('bsdtar\'s escaped names read back as they were', () => {
  assert.strictEqual(modZip.unescapeListed('my mod/npc/\\345\\220\\215\\345\\211\\215 u\\314\\210.txt'), 'my mod/npc/名前 u\u0308.txt');
  assert.strictEqual(modZip.unescapeListed('a\\\\b\\nc\\td'), 'a\\b\nc\td');
  // Printed as they are, in a UTF-8 locale: the bytes pass through.
  assert.strictEqual(modZip.unescapeListed(Buffer.from('名前.txt').toString('latin1')), '名前.txt');
  assert.strictEqual(modZip.unescapeListed('bad\\q'), null);
  assert.strictEqual(modZip.unescapeListed('bad\\9'), null);
});

test('a listing is read into the shape the zip reader gives', () => {
  const names = [
    'arpg-equipments/mod.json',
    'arpg-equipments/Patch Notes.txt',
    'my mod/npc/\\345\\220\\215\\345\\211\\215 u\\314\\210.txt',
    'arpg-equipments/a -> b.txt',
    'arpg-equipments/x link to y.txt',
    'arpg-equipments',
  ].join('\n') + '\n';
  const long = [
    '-rw-r--r--  0 0      0        1854 Oct  1 01:54 arpg-equipments/mod.json',
    // Windows: zero-padded day; and a year in place of the time.
    '-rw-r--r--  0 0      0        5616 Oct 01  2025 arpg-equipments/Patch Notes.txt',
    // Day first, as bsdtar prints it in some locales.
    '-rw-r--r--+ 0 1000   1000        2  1 Oct 14:24 my mod/npc/\\345\\220\\215\\345\\211\\215 u\\314\\210.txt',
    '-rw-r--r--  0 0      0           3 Oct  1 14:24 arpg-equipments/a -> b.txt',
    '-rw-r--r--  0 0      0           4 Oct  1 14:24 arpg-equipments/x link to y.txt',
    'drwxr-xr-x  0 0      0           0 Oct  1 14:24 arpg-equipments',
  ].join('\r\n') + '\r\n';
  assert.deepStrictEqual(modZip.parseRarListing(names, long), [
    entry('arpg-equipments/mod.json', { size: 1854 }),
    entry('arpg-equipments/Patch Notes.txt', { size: 5616 }),
    entry('my mod/npc/名前 u\u0308.txt', { size: 2 }),
    // Names that merely contain the words bsdtar uses for links.
    entry('arpg-equipments/a -> b.txt', { size: 3 }),
    entry('arpg-equipments/x link to y.txt', { size: 4 }),
    entry('arpg-equipments', { size: 0, directory: true }),
  ]);
});

test('links and devices in a listing are seen for what they are', () => {
  const parse = (names, long) => modZip.parseRarListing(names.join('\n'), long.join('\n'));
  const [sym, hard, hardTyped, dev, fifo] = parse(
    ['m/link', 'm/same.txt', 'm/h', 'm/chr', 'm/fifo'],
    ['lrwxr-xr-x  0 0      0           0 Oct  1 14:19 m/link -> /etc/passwd',
     // RAR 5's hard link keeps the file's type; only `link to` gives it away.
     '-rw-r--r--  0 0      0           0 Oct  1 14:19 m/same.txt link to m/hard.txt',
     'hrw-r--r--  0 0      0           0 Oct  1 14:19 m/h link to m/a',
     'crw-r--r--  0 0      0         1,3 Oct  1 14:19 m/chr',
     'prw-r--r--  0 0      0           0 Oct  1 14:19 m/fifo']);
  assert.ok(sym.symlink && hard.symlink && hardTyped.symlink);
  assert.ok(dev.special && fifo.special && !dev.symlink);
});

test('a listing that cannot be read with certainty is a refusal', () => {
  const parse = (names, long) => () => modZip.parseRarListing(names.join('\n'), long.join('\n'));
  const line = name => `-rw-r--r--  0 0      0           1 Oct  1 14:19 ${name}`;
  assert.throws(parse(['a', 'b'], [line('a')]), /listings disagree/);
  assert.throws(parse([], []), /lists nothing/);
  assert.throws(parse(['a'], [line('b')]), /could not read|Could not read/);
  // A hard link whose target ends in its own name must not pass as a file:
  // the words between the date and the name give it away.
  assert.throws(parse(['b'], ['-rw-r--r--  0 0      0           0 Oct  1 14:19 b link to x b']), /Could not read/);
  // An owner that is not a number (no --numeric-owner) moves the columns.
  assert.throws(parse(['a'], ['-rw-r--r--  0 some one  staff  1 Oct  1 14:19 a']), /Could not read/);
  assert.throws(parse(['a'], ['-rw-r--r--  0 0      0          1x Oct  1 14:19 a']), /Could not read/);
  assert.throws(parse(['bad\\q'], [line('bad\\q')]), /Could not read/);
});

test('the listing asks bsdtar for both forms, in the C locale', () => {
  const calls = [];
  const run = (args, { env }) => {
    calls.push({ args, env });
    return Buffer.from(args.includes('-tvf') ? '-rw-r--r--  0 0      0           7 Oct  1 14:19 m/a b.txt\n' : 'm/a b.txt\n');
  };
  assert.deepStrictEqual(modZip.rarEntries('/x/mod.rar', run), [entry('m/a b.txt', { size: 7 })]);
  assert.deepStrictEqual(calls.map(c => c.args), [['-tf', '/x/mod.rar'], ['--numeric-owner', '-tvf', '/x/mod.rar']]);
  assert.ok(calls.every(c => c.env.LC_ALL === 'C'));
});

test('a RAR is refused on its listing, before anything is unpacked', () => {
  // fakeRar() cannot be unpacked, so a refusal that names the problem proves
  // the check ran first; a bsdtar error would say "Could not read the .rar".
  const refuse = (entries, opts, pattern) =>
    assert.throws(() => modZip.unpack(fakeRar(), { label: 'the mod', listRar: () => entries, ...opts }), pattern);
  refuse([entry('m/../../x')], {}, /unsafe path \(m\/\.\.\/\.\.\/x\)/);
  refuse([entry('/etc/x')], {}, /unsafe path/);
  refuse([entry('C:/Windows/x')], {}, /unsafe path/);
  refuse([entry('m\\..\\x')], {}, /unsafe path/);
  refuse([entry('m/link', { symlink: true })], {}, /contains a link \(m\/link\)/);
  refuse([entry('m/dev', { special: true })], {}, /m\/dev is not an ordinary file/);
  refuse([entry('m/a'), entry('m/b'), entry('m/c'), entry('m', { directory: true })], { maxFiles: 2 }, /more than 2 files/);
  refuse([entry('m/a', { size: 3 * 1048576 })], { maxBytes: 2 * 1048576 }, /unpacks to more than 2 MB/);
  // A listing that throws is a refusal too, with its own reason.
  assert.throws(() => modZip.unpack(fakeRar(), { listRar: () => { throw new Error('Could not read what the .rar holds (x)'); } }),
    /Could not read what the \.rar holds/);
});

test('a registry entry may name a .rar asset', () => {
  assert.deepStrictEqual(source.readSource({ github: 'a/b', asset: 'mod-*.rar' }), { github: 'a/b', asset: 'mod-*.rar' });
  assert.deepStrictEqual(source.readSource({ github: 'a/b', asset: 'mod-*.zip' }), { github: 'a/b', asset: 'mod-*.zip' });
  assert.strictEqual(source.readSource({ github: 'a/b', asset: 'mod.7z' }), null);
});

// ---------------------------------------------------------------------------
// Through the real bsdtar.

test('the ARPG Equipments layout, a RAR named .zip, unpacks as a mod', real, () => {
  const file = fixture('arpg-equipments-layout.zip');
  assert.strictEqual(modZip.sniff(file), 'rar');
  const { dir, files } = modZip.unpack(file, { label: 'the arpg-equipments release' });
  try {
    assert.strictEqual(files.length, 28);
    assert.strictEqual(modZip.singleTopLevel(files), 'arpg-equipments');
    for (const f of ['mod.json', 'Patch Notes.txt', 'npc/when/chest_6/chest_6.txt', 'System/itemInfo-extract-essence.lua', 'settings/index.html']) {
      assert.ok(files.includes(`arpg-equipments/${f}`), f);
    }
    assert.match(fs.readFileSync(path.join(dir, 'arpg-equipments', 'mod.json'), 'utf8'), /"version": "1.2.0"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a release that is a RAR is staged like a zip', real, async () => {
  const modsDir = tempDir('stage');
  const staged = await source.stage('arpg-equipments', fs.readFileSync(fixture('arpg-equipments-layout.zip')),
    { modsDir, appVersion: '1.4.3' });
  try {
    assert.strictEqual(staged.version, '1.2.0');
    assert.deepStrictEqual(staged.contents, { serverScripts: true, clientCode: false, commands: false, tables: true });
    assert.ok(fs.existsSync(path.join(staged.staging, 'npc', 'when', 'chest_1', 'chest_1.txt')));
  } finally { source.discard(staged); }
});

test('names with spaces and non-ASCII survive the listing and the unpack', real, () => {
  const listed = modZip.rarEntries(fixture('names.rar'));
  // Windows' tar.exe lists non-ASCII through the console code page, so those
  // characters come back as '?'. The vetting only relies on '/', '..' and ':'
  // (which survive), and the walk after unpacking re-checks the real names, so
  // on Windows the listing need only keep the shape: the folder, the space, the
  // size.
  const wanted = process.platform === 'win32'
    ? e => e.name.startsWith('my mod/npc/') && e.name.endsWith('.txt') && e.size === 2
    : e => e.name.normalize('NFC') === 'my mod/npc/名前 ünï.txt' && e.size === 2;
  assert.ok(listed.some(wanted), JSON.stringify(listed));
  const { dir, files } = modZip.unpack(fixture('names.rar'));
  try {
    assert.strictEqual(modZip.singleTopLevel(files), 'my mod');
    assert.ok(files.length === 2, JSON.stringify(files));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a RAR holding links is refused', real, () => {
  const listed = modZip.rarEntries(fixture('links.rar'));
  assert.deepStrictEqual(listed.filter(e => e.symlink).map(e => e.name).sort(), ['mod/a.txt', 'mod/link']);
  assert.throws(() => modZip.unpack(fixture('links.rar'), { label: 'links' }), /Refusing links: it contains a link/);
  assert.throws(() => modZip.unpack(fixture('hardlink.rar'), { label: 'hard' }), /Refusing hard: it contains a link \(mod\/a\.txt\)/);
});

test('a hard link the listing missed is still caught on disk', real, () => {
  // As if the listing had passed it: the walk after unpacking is the second line.
  const clean = () => [entry('mod/a.txt'), entry('mod/b.txt'), entry('mod', { directory: true })];
  assert.throws(() => modZip.unpack(fixture('hardlink.rar'), { label: 'hard', listRar: clean }), /Refusing hard: it contains a link/);
});
