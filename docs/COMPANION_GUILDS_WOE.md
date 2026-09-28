# Companion-filled guilds + a War of Emperium castle event

Plan owner: user (clarois fork of `ragnarokoffline.app`)
Target repo: `~/repos/ragnarokoffline.app` (WSL Ubuntu-22.04, user `msi`) — this is the ONLY
canonical clone. `D:\Game\Ragnarok\ragnarokoffline.app` is not a git repo and must not be edited.
Pin: `config/VENDOR_PINS` → rathena `94919f5a0c309d5fbd1e32897f07644faedf3a30`.

---

## Goal

Let a player's persistent companions join the player's guild and keep that membership across
restarts, so that during a War of Emperium event the companions fight as a guild on a castle map
and can break the castle's Emperium to put that guild on the castle.

---

## Current context / assumptions (all verified against the pinned tree, with file:line)

Everything below was read out of `~/ro/rathena` at pin `94919f5` and
`~/repos/ragnarokoffline.app` at `1ae1b25`. Do not re-derive from memory.

**Population shells**
- A shell is an in-memory `map_session_data` created with `pc_setnewpc(sd, account_id, char_id, 0,
  tick, sex, 0)` — the last argument is `fd`, so **a shell's `fd` is 0**
  (`third-party/population-engine/files/src/map/population_engine.cpp:3483`).
- Shell ids live in a reserved range: `POPULATION_ENGINE_ACCOUNT_ID_BASE`/`_CHAR_ID_BASE` = 95000000,
  `IS_POPULATION_ENGINE_ACCOUNT_ID()` in `src/common/mmo.hpp` (added by patch 0001).
- `map_addiddb()` puts every BL_PC into `pc_db` (`src/map/map.cpp:2174-2179`), so
  `mapit_getallusers()` — and therefore `guild_check_member()` — **does see shells**.
- `session_isActive(0)` is false (`fd > 0` fails in `session_isValid`, `src/common/socket.cpp:1628`),
  so `clif_send()` for `SELF`/`GUILD`/`GUILD_SAMEMAP` silently skips a shell. Shells never receive
  packets and never crash the packet path by existing.

**Guilds are char-server state, and the char server joins the `char` table**
- `src/char/int_guild.cpp:413-414` loads members with
  `... FROM guild_member m INNER JOIN char c ON c.char_id = m.char_id WHERE m.guild_id = ?`.
  A population shell has **no row in `char`**, so that INNER JOIN drops it: **a shell can never be
  loaded as a guild member from SQL.** This is the exact class of bug that broke companion party
  membership (see `tests/companion-party.test.cjs`); the fix shape is the same one — map-local
  membership plus our own persistence table.
- `mapif_parse_CreateGuild` (`src/char/int_guild.cpp:1185-1260`) sets `max_member = 16` and
  `guild_lv = 1` with `skill_point` unset (0).
- `mapif_parse_GuildBasicInfoChange` GBI_GUILDLVL (`:1479-1498`) does
  `guild_lv += n; skill_point += n;` — guild skill points only ever come from levels.
- `guild_castledatasave()` → `intif_guild_castle_datasave()` → char server
  `mapif_parse_GuildCastleDataSave` → `inter_guildcastle_tosql` (`REPLACE INTO guild_castle`)
  persists castle ownership. **Castle ownership persistence is stock and needs no work.**

**Guild combat on a castle map is stock behaviour that keys off `status.guild_id`**
- `src/map/battle.cpp:7870+` `battle_check_target()`: on a `mapdata_flag_gvg()` map the guild
  rivalry block compares `status_get_guild_id(s_bl)` with `status_get_guild_id(t_bl)` —
  same guild → `BCT_GUILD`, different → `BCT_ENEMY`.
- `src/map/battle.cpp:8090`: `if( !sd->status.guild_id && t_bl->type == BL_MOB && mob_id ==
  MOBID_EMPERIUM && mapdata_flag_gvg(mapdata)) return 0;` — **a shell with no guild cannot even
  target the Emperium.** With a guild it can.
- `status_get_guild_id()` for a mob with `guardian_data` returns the *castle owner's* guild
  (`src/map/status.cpp:9184-9189`), so the defending guild's Emperium and guardians read as enemy
  to every other guild automatically.
- `mapdata_flag_gvg()` (`src/map/map.hpp:961-963`) counts `MF_GVG_CASTLE` **only while
  `agit_flag` (or `agit2_flag`) is set** — outside WoE a castle map is not a vs-map. Event gating
  is therefore free.
- `aldeg_cas01`..`prtg_cas05` carry `gvg_castle` from `npc/mapflag/gvg.txt:30-45`, which is loaded
  via `npc/scripts_mapflags.conf:5` → `npc/re/scripts_main.conf:30`. `aldeg_cas01` is a real
  First-Edition castle, Emperium room `(216,23)`, castle warp `(212,175)`
  (`db/re/castle_db.yml:44-51`, `npc/guild/agit_main.txt:72`).
- `src/map/battle.cpp:2146-2173` `battle_can_hit_gvg_target()`: to damage the Emperium the
  attacker's guild needs `guild_checkskill(g->guild, GD_APPROVAL) > 0` (`:2160`).
  `GD_APPROVAL` = 10000 (`src/common/mmo.hpp:872`), `MaxLevel: 1`
  (`db/re/guild_skill_tree.yml:39-40`), and it costs 1 guild skill point.
- The Emperium (mob 1288) has `IgnoreMelee/IgnoreMagic/IgnoreRanged/IgnoreMisc`
  (`db/re/mob_db.yml:13882-13886`) → `is_infinite_defense()` is true (`src/map/battle.cpp:2891-2911`)
  → `battle_calc_attack_plant()` (`:4952`) → **1 damage per hit** (100 HP → 100 hits), with
  element fix and GvG damage rates applied on top. Breaking it is meant to take a while.

**The two traps that decide whether this works at all**
1. `guild_recv_info()` (`src/map/guild.cpp:822`) does
   `memcpy(&g->guild, &sg, sizeof(struct mmo_guild))` — it **overwrites the whole map-side guild
   struct from the char server's copy**, wiping any member row we injected. Worse,
   `guild_check_member()` (`:783-804`, called at `:837` when the guild is new to map memory)
   iterates all online PCs and **zeroes `status.guild_id` for any PC not in the char server's member
   list — i.e. every shell.** This is the same shape as the party rebuild that
   `population_engine_reassert_companions()` exists to repair, and it needs the same repair hook.
2. `mob_dead()` dispatches the mob's `npc_event` to the **killer**
   (`src/map/mob.cpp:3600-3611`, and `battle_config.mob_npc_event_type` is `1` in
   `conf/battle/monster.conf:266`). But `npc_event_sub()` **refuses to run any script for a shell**
   (`src/map/npc.cpp:1749-1751`, added by patch 0001 to stop roaming shells firing OnTouch).
   Therefore **a companion that lands the killing blow on the Emperium runs nothing: `OnAgitBreak`
   never fires, the castle never changes hands, and the Emperium never respawns.** This is the one
   place where "companions fight for the guild" cannot be done by data alone.

**A shell pointer must not survive in a guild member slot** (same class as the
`party_send_xy_timer` SIGSEGV this project already hit):
- `guild_send_xy_timer_sub()` (`src/map/guild.cpp:656-671`) walks
  `g->guild.member[i].sd`, guards only with `sd != nullptr && sd->fd`, then dereferences
  `sd->guild_x`. A freed pointer passes a null check and dies on `sd->fd`.
- It runs every 5 s (`GUILD_SEND_XY_INTERVAL`, `src/map/guild.cpp:49`) for every guild in memory.
- `clif_send(..., GUILD)` walks the same array (`src/map/clif.cpp:646-660`).
So releasing a shell MUST scrub its `member[].sd` slot, and that invariant belongs inside the
release helper, not at a call site.

**Conventions this project already settled (do not re-litigate)**
- Engine C++ under `third-party/population-engine/files/` is copied **verbatim** by
  `scripts/apply-server-mods.sh`; only files under `src/custom/` (and rathena TUs) need patch hunks.
  So new engine functions need **no** patch, but `guild.cpp`/`mob.cpp` hooks do.
- `atcommands.yml` is only an alias table for commands that already exist in the `ACMD_DEF` array —
  `AtcommandAliasDatabase::parseBodyNode` rejects a `Command:` that `get_atcommandinfo_byname()`
  cannot find (`src/map/atcommand.cpp:126-140`). Adding a **sub-verb to the existing `@companion`
  command needs no `atcommands.yml` change and no new `ACMD_DEF`.** The app's account is group 99,
  which has `all_commands: true` = `PC_PERM_USE_ALL_COMMANDS` (`src/map/pc_groups.hpp:77`), so new
  verbs are usable the moment they compile.
- The `@companion` branch's `param` is 23 bytes (`char param[NAME_LENGTH]` via
  `sscanf(message, "%31s %23[^\n]", cmd, param)`) — one short command per click, never a list.
- Companion identity/ownership: `pop.companion_owner_account` is the durable owner predicate.
  **Never key a companion path on `party_id`** — a party rebuild destroys it.

### What the companion AI does and does not know about WoE (measured, not assumed)

`grep -rniE "emperium|EMPELIUM|agit|castle|guardian|gvg|MOBID_EMPERIUM"` across every engine TU
(`population_engine.cpp`, `runtime/*.cpp`, `config/*.cpp`, `core/*.hpp`) returns **nothing**. The
engine has no objective model, no concept of a castle, and no notion of the Emperium as a goal.
So the companions do **not** "know WoE", and no amount of guild membership will teach them.

What actually makes them fight is that **the WoE logic lives in `battle_check_target()`, not in the
AI**. Their loop is "ask `population_shell_check_target()` what is an enemy, attack the nearest
one" — on a castle map during WoE the server redefines that enemy set. Same loop as a dungeon,
different targets. That is the whole trick, and it is why this feature needs no new AI.

| WoE job | Does the AI do it? | Mechanism |
|---|---|---|
| attack rival players | yes, free | guild branch → `BCT_ENEMY`, `battle.cpp:8180-8189` |
| attack the Emperium | yes, once guilded | `battle.cpp:8090` requires a `guild_id` to target it |
| retaliate when hit | yes | `sd->pop.last_attacker_id`, `population_engine.cpp:1721` |
| assist the owner's target | yes | `owner_target`, `population_engine.cpp:1712` |
| come back after dying | yes | `population_engine_respawn_shell_timer`, "respawning beside owner (kept in party)" |
| hold ground instead of roaming | **only if configured** | `PopulationBehavior::Guard` → return-to-post (`runtime/population_engine_combat.cpp:1644-1658`) |
| prioritise the Emperium over a nearby player | **no** | no objective model at all |
| regroup / retreat / push as a squad | **no** | no squad logic |
| stay inside the castle rather than chasing | **only if configured** | `Guard`; otherwise they roam and chase |

`Guard` is the only defensive primitive and it is config-only: when a shell has no target and is not
walking it walks back to `sd->pop.spawn_x`/`spawn_y` (`population_engine_combat.cpp:1644-1658`).
Behaviours are chosen per map kind in `db/population_engine.yml`
(`TownBehavior`/`FieldBehavior`/`DungeonBehavior`: `wander | guard | combat | idle`), and a castle
map is a Field map. A companion's `spawn_x/spawn_y` is wherever it was summoned, so the owner must
**summon at the Emperium** for `guard` to anchor defenders there. Expect skirmishing, not a battle
plan: two guilds of companions will fight and the castle mechanics will resolve correctly, but
nobody will play the objective.

### The blocker for companion-vs-companion: all shells on a map are one party

`population_engine.cpp:4283` gives **every** shell the same fake party id at spawn:
`sd->status.party_id = 0x70000000 | map_id`, deliberately — the comment says "so shells on the same
map are treated as party members by `battle_check_target`(BCT_PARTY) ... lets party-only skills cast
between shells without creating real party structs". A companion only takes the owner's *real*
party id if the owner has one (`:5090`/`:5213` bail out when
`party_id <= 0 || >= 0x70000000`).

On a vs-map, `battle.cpp:8175` sets `BCT_PARTY` for party-mates **unless the map has
`MF_GVG_NOPARTY`**, and the guild branch then sets `BCT_ENEMY` for a rival guild. But the final
normalisation at `battle.cpp:8232` clears `BCT_ENEMY` whenever `BCT_PARTY` is also set:

```cpp
else if( state&BCT_ENEMY && strip_enemy && state&(BCT_SELF|BCT_PARTY|BCT_GUILD) )
	state&=~BCT_ENEMY;
```

So **two rival companion guilds on a plain castle map are mutual party-mates whose enemy flag is
stripped: they cannot damage each other.** Setting `gvg_noparty` on the castle makes line 8175's
condition false, the party branch falls through to `BCT_ENEMY`, no `BCT_PARTY` is ever set, and
nothing strips the enemy flag — they become hostile. That is exactly why the dedicated GvG maps
(`guild_vs1`-`guild_vs5`) carry the flag.

**`gvg_noparty` is therefore REQUIRED for companion-vs-companion WoE, not optional.** It is a
one-line mapflag, no C++ (Phase 4, T4.3). The engine's own authors hit this same class of bug in the
arena and left the note at `battle.cpp:8151-8158`: the arena relation hook "must run BEFORE the
party/guild rivalry block so it can override an unrelated `party_id` match (e.g. two team-1 shells
happen to share a fake party id)". For WoE the clean fix is the mapflag, not another hook.

---

## Architecture / proposed approach

Companion guild membership is **map-local, exactly like companion party membership**: a new engine
helper writes a shell into the map's own `MapGuild::guild.member[]`, sets
`shell->status.guild_id` and `shell->guild`, and the engine records the `(owner_account, shell_index,
guild_id)` triple in a new `cp_companion_guild` table. Whenever the char server pushes guild info
(`guild_recv_info`, which wipes and re-zeroes), a new re-assert hook re-injects every persisted
companion of that guild, and the release path scrubs the slot so no freed pointer is ever walked by
the 5 s guild timer. Because stock `battle_check_target()` already resolves guild rivalry and the
Emperium's ownership from `status.guild_id`, giving shells a guild id makes them fight as a guild
on a `gvg_castle` map during WoE with **no new combat code**; the only rathena code change needed
for the event is handing the Emperium's break event from a shell to that shell's owner.

---

## Phase 0 — orient the workspace (5 min, no code)

Every later step assumes these paths. Do them in a WSL login shell.

**T0.1** Confirm the fork and its HEAD.

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/repos/ragnarokoffline.app && git log --oneline -1 && git status --short | head'
```
Expected: one commit line (`1ae1b25 Stop ambient shells from taking a persisted companion's index`
or a later child) and only untracked scratch `*.json` files. If tracked files show as modified,
stop and `git stash` before continuing.

**T0.2** Confirm the compile bench is at the pin.

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/ro/rathena && git rev-parse HEAD && grep -c RAGNAROKMAC src/map/population_engine.cpp'
```
Expected: `94919f5a0c309d5fbd1e32897f07644faedf3a30`, then a number `> 0`. A `0` for RAGNAROKMAC
means the bench has no engine files — re-clone per
`references/population-engine-patches.md §WSL verification recipe`.

**T0.3** Verify the guest is up (needed from Phase 6 onward).

```bash
curl -s -m 5 "http://127.0.0.1:7462/docker/v1.44/containers/json?all=false" | head -c 300
```
Expected: JSON array with a `ragnarok-map` entry. Empty/refused means the app is closed; that is
fine for Phases 1-5, and Phase 6 will say so where it matters.

---

## Phase 1 — the persistence table (TDD)

Own the schema first: everything else needs somewhere to remember membership.

**T1.1 — write the failing test.**
Create `tests/companion-guild.test.cjs`:

```js
// Guild membership for population companions: map-local injection + own persistence.
//
// Same class of bug the party fix exists for (tests/companion-party.test.cjs): the char
// server persists guild membership as a JOIN against the `char` table, and a population
// shell has no row there, so a shell can never be loaded back as a guild member. The fix
// is map-local membership plus our own table, re-asserted whenever guild info is rebuilt.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const HPP = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.hpp');
const CMDS = path.join(ROOT, 'stack', 'src', 'cmds.rs');
const SQLDOC = path.join(ROOT, 'third-party', 'population-engine', 'files', 'sql-files', 'population_engine', 'cp_companion_guild.sql');

const src = fs.readFileSync(ENGINE, 'utf8');

test('the boot provisioner creates cp_companion_guild', () => {
	const cmds = fs.readFileSync(CMDS, 'utf8');
	assert.match(cmds, /CREATE TABLE IF NOT EXISTS `cp_companion_guild`/, 'boot DDL is missing');
	for (const column of ['owner_account_id', 'shell_index', 'guild_id', 'position']) {
		assert.ok(cmds.includes('`' + column + '`'), `cp_companion_guild has no ${column} column`);
	}
});

test('the documentation copy of the schema matches the provisioner byte for byte', () => {
	const cmds = fs.readFileSync(CMDS, 'utf8');
	const doc = fs.readFileSync(SQLDOC, 'utf8');
	// The DDL string lives inline in cmds.rs; take it from CREATE to the closing backtick-semicolon.
	const start = cmds.indexOf('CREATE TABLE IF NOT EXISTS `cp_companion_guild`');
	assert.ok(start > 0, 'DDL not found in cmds.rs');
	const end = cmds.indexOf('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;', start);
	const fromRust = cmds.slice(start, end + 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;'.length);
	const normalise = (s) => s.replace(/\s+/g, ' ').trim();
	assert.strictEqual(normalise(doc), normalise(fromRust), 'cp_companion_guild.sql drifted from cmds.rs');
});

test('the engine declares and defines the guild membership surface', () => {
	const hpp = fs.readFileSync(HPP, 'utf8');
	for (const symbol of [
		'population_engine_companion_join_guild',
		'population_engine_companion_leave_guild',
		'population_engine_companion_owner_of',
		'population_engine_reassert_guild_companions',
		'population_engine_restore_guild_companions',
		'population_engine_guild_scrub_shell',
	]) {
		assert.ok(hpp.includes(symbol), `${symbol} is not declared in population_engine.hpp`);
	}
	for (const symbol of [
		'pop_companion_register_local_guild',
		'population_engine_companion_join_guild',
		'population_engine_reassert_guild_companions',
		'population_engine_restore_guild_companions',
		'population_engine_guild_scrub_shell',
		'population_engine_companion_owner_of',
	]) {
		assert.ok(src.includes(symbol), `${symbol} is not defined in population_engine.cpp`);
	}
});

test('membership is registered map-locally, never through the char server', () => {
	const body = src.slice(src.indexOf('static bool pop_companion_register_local_guild'));
	assert.ok(body.length > 0, 'local guild registration helper is missing');
	const chunk = body.slice(0, 4000);
	assert.ok(!/intif_guild_addmember/.test(chunk),
		'guild join must not route through the char server: it cannot persist a shell membership');
	assert.ok(/shell->status\.guild_id = guild_id/.test(chunk), 'the shell is never given the guild id');
	assert.ok(/g->guild\.member\[i\]\.sd = shell/.test(chunk), 'the shell is never put in the member slot');
});

test('recall restores guild membership, and the release path scrubs the slot', () => {
	const recall = src.slice(src.indexOf('int population_engine_recall_companions'));
	assert.ok(recall.length > 0, 'recall not found');
	assert.ok(/population_engine_restore_guild_companions\(owner\)/.test(recall.slice(0, 12000)),
		'recall must re-join persisted companions to their guild');

	const release = src.slice(src.indexOf('void population_engine_shell_release'));
	assert.ok(release.length > 0, 'shell_release not found');
	assert.ok(/population_engine_guild_scrub_shell\(sd\)/.test(release.slice(0, 6000)),
		'releasing a shell must scrub its guild member slot: guild_send_xy_timer dereferences it every 5s');
});
```

**T1.2 — run it and watch it fail.**

```bash
cd "//wsl.localhost/Ubuntu-22.04/home/msi/repos/ragnarokoffline.app" && node tests/companion-guild.test.cjs
```
(Run it with **Windows** node against the UNC path — WSL has no node binary. `node --test` cannot
resolve a UNC path, so invoke the file directly; it prints the same TAP output.)
Expected: 5 failing tests, `# fail 5`.

**T1.3 — add the boot DDL to `stack/src/cmds.rs`.**
Find the block that creates `cp_companion_persistence` (search for
`CREATE TABLE IF NOT EXISTS \`cp_companion_persistence\``) and insert this immediately **after**
that `let _ = dk.exec_sql( ... );` call:

```rust
    // Companion guild membership: one row per companion that has joined a guild.
    // A map-local guild row cannot be persisted through the char server (its member
    // loader is an INNER JOIN against `char`, and a population shell has no row
    // there), so membership is remembered here and re-asserted into the map's own
    // guild struct whenever guild info is rebuilt from the char server.
    let _ = dk.exec_sql(
        "CREATE TABLE IF NOT EXISTS `cp_companion_guild` (
           `owner_account_id` INT UNSIGNED      NOT NULL,
           `shell_index`      INT UNSIGNED      NOT NULL,
           `guild_id`         INT UNSIGNED      NOT NULL,
           `position`         TINYINT UNSIGNED  NOT NULL DEFAULT 19,
           `joined_at`        TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (`shell_index`),
           KEY `idx_owner` (`owner_account_id`),
           KEY `idx_guild` (`guild_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
    );
```

**T1.4 — write the documentation copy, byte-identical.**
Create `third-party/population-engine/files/sql-files/population_engine/cp_companion_guild.sql` with
exactly the same DDL text plus a header comment. The whitespace-normalised DDL must equal the Rust
string (the test in T1.1 checks this):

```sql
-- Companion guild membership (v1). This file is the documentation copy of the schema
-- `stack/src/cmds.rs` provisions at boot -- keep them byte-identical.
--
-- Why it exists: the char server loads guild members with
--   FROM guild_member m INNER JOIN char c ON c.char_id = m.char_id
-- and a population shell has no row in `char`, so a companion can never be loaded back as
-- a guild member from SQL. Membership is therefore injected into the map's own guild struct
-- at join/recall time and re-asserted after every guild_recv_info() rebuild.
CREATE TABLE IF NOT EXISTS `cp_companion_guild` (
           `owner_account_id` INT UNSIGNED      NOT NULL,
           `shell_index`      INT UNSIGNED      NOT NULL,
           `guild_id`         INT UNSIGNED      NOT NULL,
           `position`         TINYINT UNSIGNED  NOT NULL DEFAULT 19,
           `joined_at`        TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (`shell_index`),
           KEY `idx_owner` (`owner_account_id`),
           KEY `idx_guild` (`guild_id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**T1.5 — the Rust side must still compile.**

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/repos/ragnarokoffline.app/stack && touch src/cmds.rs && cargo check 2>&1 | tail -5'
```
Expected: `Finished ... target(s)` with no `error`. A `Finished in 0.00s` means nothing was
re-checked — the `touch` is what makes this a real check.

**T1.6 — commit.** `git add stack/src/cmds.rs third-party/population-engine/files/sql-files/population_engine/cp_companion_guild.sql tests/companion-guild.test.cjs && git commit -m "Companion guilds: provision cp_companion_guild and pin its schema"`.
(The engine functions land in Phase 2; the test is allowed to be red for one commit only if you
commit the DDL separately. Prefer finishing Phase 2 before this commit if you want every commit
green.)

---

## Phase 2 — engine: join, leave, and map-local membership

All work is in `third-party/population-engine/files/src/map/population_engine.cpp` and
`population_engine.hpp`. **No patch file is involved** — these files are copied verbatim.

**T2.1 — declare the surface in `population_engine.hpp`.**
Insert next to the other companion declarations (the block holding
`population_engine_persist_companion_row`, `population_engine_recall_companions`,
`population_engine_companion_list_raw`):

```cpp
// --- Companion guilds -------------------------------------------------------
// Map-local guild membership for recruited companions, with the membership
// remembered in cp_companion_guild. The char server cannot persist a shell's
// membership (its member loader INNER JOINs the `char` table), so these are the
// only way a companion is ever a guild member.
bool population_engine_companion_join_guild(map_session_data *owner, const char *name,
    char *reply, size_t reply_len);
bool population_engine_companion_leave_guild(map_session_data *owner, const char *name,
    char *reply, size_t reply_len);
void population_engine_guild_status(map_session_data *owner, int fd);
/// The real player who owns this shell and is standing on the same map, or nullptr.
/// Ownership is by account (pop.companion_owner_account) -- never by party_id, which a
/// party rebuild destroys.
map_session_data *population_engine_companion_owner_of(map_session_data *shell);
/// Re-inject every persisted companion of this guild. Called from guild_recv_info()
/// (see patch 0009), which memcpy-overwrites the map's guild struct with the char
/// server's copy and zeroes the guild_id of any shell missing from it.
void population_engine_reassert_guild_companions(int32 guild_id);
/// Re-join this owner's summoned companions to their persisted guild. Called at the end
/// of population_engine_recall_companions() so a login or @companion summon restores it.
void population_engine_restore_guild_companions(map_session_data *owner);
/// Remove this shell from every guild's member[] before it is freed. A stale pointer
/// there is dereferenced by guild_send_xy_timer every 5s.
void population_engine_guild_scrub_shell(map_session_data *shell);
```

**T2.2 — implement in `population_engine.cpp`.**
Place the block **after** `population_engine_persist_companion_row()` (ends ~line 4622 and is a
non-static public function, i.e. outside the anonymous namespace that the config TUs are included
into — putting these next to it is what guarantees external linkage). `population_engine.cpp`
already includes `party.hpp`; add `#include "guild.hpp"` to the include block (lines 37-56) so
`guild_search`, `MapGuild`, `GS_MEMBER_MODIFIED` and `NAME_LENGTH` resolve.

```cpp
// ---------------------------------------------------------------------------
// Companion guilds
// ---------------------------------------------------------------------------

/// The real player this shell belongs to, if they are online on the same map.
/// Deliberately NOT pop_companion_owner(): that one also demands a party_id match,
/// and a party rebuild (which replays the char server's member list, where shells
/// cannot appear) wipes that field. Ownership by account is the durable link.
map_session_data *population_engine_companion_owner_of(map_session_data *shell)
{
    if (!shell || shell->pop.companion_owner_account == 0)
        return nullptr;
    map_session_data *owner = map_id2sd(shell->pop.companion_owner_account);
    if (!owner || !owner->state.active || owner->prev == nullptr)
        return nullptr;
    if (population_engine_is_population_pc(owner->id))
        return nullptr;
    if (owner->m != shell->m)
        return nullptr;
    return owner;
}

/// Put this shell into the map-side guild struct, and give it the guild id that
/// battle_check_target() reads. Mirrors guild_makemember() field for field so the row
/// is identical to one a real member would have.
///
/// Returns false when the guild is not in map memory yet; the caller is expected to
/// give up for now -- guild_request_info()'s reply runs guild_recv_info(), whose
/// re-assert hook will inject every persisted companion of that guild anyway.
static bool pop_companion_register_local_guild(map_session_data *shell, int32 guild_id)
{
    if (!shell || guild_id <= 0)
        return false;

    auto g = guild_search(guild_id);
    if (g == nullptr) {
        guild_request_info(guild_id);
        return false;
    }

    // The char server's max_member is the capacity the guild window advertises, so
    // stay inside it rather than growing the struct.
    if (g->guild.max_member <= 0 || g->guild.max_member > MAX_GUILD)
        g->guild.max_member = MAX_GUILD;

    int32 i;
    ARR_FIND(0, g->guild.max_member, i,
        g->guild.member[i].account_id == shell->status.account_id &&
        g->guild.member[i].char_id == shell->status.char_id);

    if (i >= g->guild.max_member) {
        ARR_FIND(0, g->guild.max_member, i, g->guild.member[i].account_id == 0);
        if (i >= g->guild.max_member) {
            ShowWarning("population_engine: guild %d is full; companion %s cannot join.\n",
                guild_id, shell->status.name);
            return false;
        }
        struct guild_member &m = g->guild.member[i];
        memset(&m, 0, sizeof(m));
        m.account_id = shell->status.account_id;
        m.char_id    = shell->status.char_id;
        m.hair       = shell->status.hair;
        m.hair_color = shell->status.hair_color;
        m.gender     = shell->status.sex;
        m.class_     = shell->status.class_;
        m.lv         = shell->status.base_level;
        m.exp        = 0;
        m.online     = 1;
        // One rank above Newbie, so the master (position 0) is untouched.
        m.position   = MAX_GUILDPOSITION - 2;
        safestrncpy(m.name, shell->status.name, NAME_LENGTH);
        m.last_login = static_cast<decltype(m.last_login)>(time(nullptr));
        m.modified   = GS_MEMBER_MODIFIED;
        // NOTE: g->guild.connect_member is deliberately NOT touched. The char server
        // recomputes it from its own member list on every login, so counting shells
        // here would make the guild window's "online" number flap.
    }

    g->guild.member[i].sd = shell;
    shell->status.guild_id = guild_id;
    shell->guild = g;
    shell->guild_emblem_id = g->guild.emblem_id;
    clif_name_area(shell); // draw the guild name under the character name
    return true;
}

/// Remember (or refresh) this companion's guild, and join it now if it is summoned.
static bool pop_companion_persist_guild(uint32_t owner_account, uint32_t index_, uint32_t guild_id)
{
    if (mmysql_handle == nullptr)
        return false;
    // 256 is the whole statement including two 10-digit ids; see the buffer-sizing
    // rule -- an undersized snprintf truncates silently mid-statement.
    char q[256];
    snprintf(q, sizeof(q),
        "REPLACE INTO `cp_companion_guild` (owner_account_id, shell_index, guild_id, position)"
        " VALUES (%u, %u, %u, %d)",
        owner_account, index_, guild_id, MAX_GUILDPOSITION - 2);
    if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
        Sql_ShowDebug(mmysql_handle);
        ShowError("population_engine: failed to persist guild %u for companion %u (owner %u)\n",
            guild_id, index_, owner_account);
        return false;
    }
    return true;
}

/// Drop this companion's remembered guild.
static void pop_companion_forget_guild(uint32_t owner_account, uint32_t index_)
{
    if (mmysql_handle == nullptr)
        return;
    char q[256];
    snprintf(q, sizeof(q),
        "DELETE FROM `cp_companion_guild` WHERE owner_account_id=%u AND shell_index=%u",
        owner_account, index_);
    if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS)
        Sql_ShowDebug(mmysql_handle);
}

/// The live shell for this persisted companion, if it is summoned on any map.
static map_session_data *pop_companion_live_shell(uint32_t index_)
{
    for (map_session_data *sd : g_population_engine_pcs) {
        if (!sd || !sd->state.active)
            continue;
        if (sd->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
            continue;
        if (sd->pop.companion_owner_account == 0)
            continue;
        return sd;
    }
    return nullptr;
}

bool population_engine_companion_join_guild(map_session_data *owner, const char *name,
    char *reply, size_t reply_len)
{
    if (!owner || !owner->state.active || name == nullptr || name[0] == '\0')
        return false;
    if (owner->status.guild_id <= 0) {
        safesnprintf(reply, reply_len,
            "You are not in a guild. Create one first with @guild <name>.");
        return false;
    }

    uint32_t index_ = 0;
    bool active = false;
    if (!population_engine_companion_find(owner->status.account_id, name, &index_, &active)) {
        safesnprintf(reply, reply_len, "Companion '%s' not found in your saved list.", name);
        return false;
    }

    const int32 guild_id = owner->status.guild_id;
    if (!pop_companion_persist_guild(owner->status.account_id, index_, static_cast<uint32_t>(guild_id))) {
        safesnprintf(reply, reply_len, "Could not save that membership - see the map-server console.");
        return false;
    }

    map_session_data *shell = pop_companion_live_shell(index_);
    if (shell == nullptr) {
        safesnprintf(reply, reply_len,
            "'%s' will join the guild the next time it is summoned.", name);
        return true;
    }
    if (!pop_companion_register_local_guild(shell, guild_id)) {
        safesnprintf(reply, reply_len,
            "'%s' is saved as a member of guild %d; it will be registered once the guild data loads.",
            name, guild_id);
        return true;
    }
    safesnprintf(reply, reply_len, "'%s' joined your guild.", name);
    return true;
}

bool population_engine_companion_leave_guild(map_session_data *owner, const char *name,
    char *reply, size_t reply_len)
{
    if (!owner || !owner->state.active || name == nullptr || name[0] == '\0')
        return false;

    uint32_t index_ = 0;
    bool active = false;
    if (!population_engine_companion_find(owner->status.account_id, name, &index_, &active)) {
        safesnprintf(reply, reply_len, "Companion '%s' not found in your saved list.", name);
        return false;
    }

    pop_companion_forget_guild(owner->status.account_id, index_);

    map_session_data *shell = pop_companion_live_shell(index_);
    if (shell != nullptr)
        population_engine_guild_scrub_shell(shell);

    safesnprintf(reply, reply_len, "'%s' left the guild.", name);
    return true;
}

void population_engine_reassert_guild_companions(int32 guild_id)
{
    if (guild_id <= 0 || mmysql_handle == nullptr)
        return;

    char q[256];
    snprintf(q, sizeof(q),
        "SELECT shell_index FROM `cp_companion_guild` WHERE guild_id=%d", guild_id);
    if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
        Sql_ShowDebug(mmysql_handle);
        return;
    }

    std::vector<uint32_t> indices;
    char *data = nullptr;
    while (SQL_SUCCESS == Sql_NextRow(mmysql_handle))
        if (Sql_GetData(mmysql_handle, 0, &data, nullptr), data != nullptr)
            indices.push_back(static_cast<uint32_t>(atoi(data)));
    Sql_FreeResult(mmysql_handle);

    int reasserted = 0;
    for (uint32_t index_ : indices) {
        map_session_data *shell = pop_companion_live_shell(index_);
        if (shell == nullptr)
            continue;
        // Ownership, not party_id: the owning account is what survives a rebuild.
        if (population_engine_companion_owner_of(shell) == nullptr)
            continue;
        if (pop_companion_register_local_guild(shell, guild_id))
            ++reasserted;
    }
    if (reasserted > 0)
        ShowInfo("Population engine: re-asserted %d companion(s) in guild %d.\n",
            reasserted, guild_id);
}

void population_engine_restore_guild_companions(map_session_data *owner)
{
    if (!owner || !owner->state.active || mmysql_handle == nullptr)
        return;

    char q[256];
    snprintf(q, sizeof(q),
        "SELECT shell_index, guild_id FROM `cp_companion_guild` WHERE owner_account_id=%u",
        owner->status.account_id);
    if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
        Sql_ShowDebug(mmysql_handle);
        return;
    }

    std::vector<std::pair<uint32_t, int32>> rows;
    char *data = nullptr;
    while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
        uint32_t index_ = 0;
        int32 gid = 0;
        Sql_GetData(mmysql_handle, 0, &data, nullptr); index_ = static_cast<uint32_t>(atoi(data));
        Sql_GetData(mmysql_handle, 1, &data, nullptr); gid = atoi(data);
        if (index_ != 0 && gid > 0)
            rows.emplace_back(index_, gid);
    }
    Sql_FreeResult(mmysql_handle);

    for (const auto &row : rows) {
        map_session_data *shell = pop_companion_live_shell(row.first);
        if (shell == nullptr)
            continue;
        if (!pop_companion_register_local_guild(shell, row.second))
            continue; // guild not in memory yet; guild_recv_info's hook will retry
    }
}

void population_engine_guild_scrub_shell(map_session_data *shell)
{
    if (!shell)
        return;
    // Walk every guild in memory, not just the one this shell thinks it is in: a
    // shell can have been moved between guilds (or lost its guild_id to a
    // guild_check_member sweep) while a stale slot still points at it, and
    // guild_send_xy_timer() dereferences every non-null slot every 5 seconds.
    for (auto &entry : guild_db) {
        if (!entry.second)
            continue;
        struct mmo_guild &g = entry.second->guild;
        for (int32 i = 0; i < MAX_GUILD; ++i) {
            if (g.member[i].sd != shell)
                continue;
            g.member[i].sd = nullptr;
            g.member[i].online = 0;
            g.member[i].modified = GS_MEMBER_MODIFIED;
        }
    }
    shell->status.guild_id = 0;
    shell->guild = nullptr;
    shell->guild_emblem_id = 0;
}

void population_engine_guild_status(map_session_data *owner, int fd)
{
    if (!owner || fd <= 0)
        return;

    char line[CHAT_SIZE_MAX];
    if (owner->status.guild_id <= 0) {
        clif_displaymessage(fd, "You are not in a guild.");
        return;
    }
    auto g = guild_search(owner->status.guild_id);
    safesnprintf(line, sizeof(line), "Guild: %s (id %d)%s",
        g ? g->guild.name : "?", owner->status.guild_id,
        g ? "" : " - data not loaded yet, try again in a moment");
    clif_displaymessage(fd, line);

    if (mmysql_handle == nullptr)
        return;
    char q[256];
    snprintf(q, sizeof(q),
        "SELECT shell_index FROM `cp_companion_guild` WHERE guild_id=%d ORDER BY shell_index",
        owner->status.guild_id);
    if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
        Sql_ShowDebug(mmysql_handle);
        return;
    }
    int members = 0, live = 0;
    char *data = nullptr;
    while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
        Sql_GetData(mmysql_handle, 0, &data, nullptr);
        const uint32_t index_ = static_cast<uint32_t>(atoi(data));
        ++members;
        if (pop_companion_live_shell(index_) != nullptr)
            ++live;
    }
    Sql_FreeResult(mmysql_handle);
    safesnprintf(line, sizeof(line), "Companions in this guild: %d (%d summoned).", members, live);
    clif_displaymessage(fd, line);
}
```

Two details that are easy to get wrong and are deliberate:
- `MAX_GUILDPOSITION - 2` = position 18, i.e. one rank above the default `Newbie`
  (`MAX_GUILDPOSITION - 1`). Never position 0 — that is the master's slot.
- `pop_companion_persist_guild` uses **REPLACE**, the only verb that creates a row. Calling the
  recurring-helpers style UPDATE here would affect zero rows and report no error.

**T2.3 — call the restore from recall.**
In `population_engine_recall_companions()` (the batch function that ends with
`population_engine_push_companion_list(owner)` and the party re-sync, ~line 5640-5660), add as the
last statement before `return recalled;`:

```cpp
    // Guild membership is map-local like party membership, so it has to be
    // re-established on every recall (login, @companion summon, self-heal).
    population_engine_restore_guild_companions(owner);
```

**T2.4 — scrub on release.**
In `population_engine_shell_release()` (line ~628), next to the existing party-slot scrub and
before `population_engine_combat_shell_teardown(sd)`, add:

```cpp
    // RAGNAROKMAC (companion guilds): a freed shell must not survive in any guild's
    // member[] either. guild_send_xy_timer() runs every 5s, guards each slot with a
    // null check and then dereferences sd->fd -- a dangling pointer passes that guard.
    population_engine_guild_scrub_shell(sd);
```

Note the ordering: `population_engine_guild_scrub_shell` touches `shell->status.guild_id` and
`guild_db`, so it must run **before** the `sd->~map_session_data(); aFree(sd);` at the end of the
function and after the `map_id2bl(sd->id) != sd` early-return guards.

**T2.5 — verify the compile in a fresh tree (never in the bench).**

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'rm -rf ~/fresh_guild && git clone --no-hardlinks ~/ro/rathena ~/fresh_guild && cd ~/repos/ragnarokoffline.app && bash scripts/apply-server-mods.sh ~/fresh_guild 2>&1 | tail -8'
```
Expected: the copy lines, `==> population engine: patches`, then `patch -p1 --forward` output with
no `FAILED` and no `Reversed or previously applied`.

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/fresh_guild && g++ -std=c++17 -fsyntax-only -I . -I src -I src/common -I src/map -I 3rdparty/rapidyaml/src -I 3rdparty/rapidyaml/ext/c4core/src -I 3rdparty/yaml-cpp/include -I 3rdparty/libconfig -I /home/msi/ro-build/mp/usr/include/mariadb src/map/population_engine.cpp && echo SYNTAX_OK'
```
Expected: `SYNTAX_OK` and no diagnostics.

**T2.6 — prove the cross-TU symbols have external linkage** (this is the check that catches the
failure only CI would otherwise see):

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/fresh_guild && g++ -c -std=c++17 -I . -I src -I src/common -I src/map -I 3rdparty/rapidyaml/src -I 3rdparty/rapidyaml/ext/c4core/src -I 3rdparty/yaml-cpp/include -I 3rdparty/libconfig -I /home/msi/ro-build/mp/usr/include/mariadb src/map/population_engine.cpp -o /tmp/pe.o && nm -C /tmp/pe.o | grep -E "population_engine_guild_scrub_shell|population_engine_reassert_guild_companions|population_engine_companion_owner_of|population_engine_restore_guild_companions|population_engine_companion_join_guild"'
```
Expected: five lines, each starting with an uppercase `T`. A lowercase `t` means the symbol has
internal linkage (the function landed inside the anonymous namespace that the `config/` TUs are
included into) — move it next to `population_engine_persist_companion_row`.

**T2.7 — run the test, watch it go green.**

```bash
cd "//wsl.localhost/Ubuntu-22.04/home/msi/repos/ragnarokoffline.app" && node tests/companion-guild.test.cjs
```
Expected: the schema and engine-surface tests pass; the recall/release tests pass once T2.3 and
T2.4 are in. `# fail 0`.

**T2.8 — commit.** Message: `Companion guilds: map-local guild membership + cp_companion_guild persistence`.

---

## Phase 3 — the re-assert hook and the atcommand surface (patch 0009)

**T3.1 — write the failing test for the patch.** Append to `tests/companion-guild.test.cjs`:

```js
const PATCH = path.join(ROOT, 'third-party', 'population-engine', 'patches', '0009-companion-guilds.patch');

test('the patch re-asserts companions after the char server rebuilds guild info', () => {
	const patch = fs.readFileSync(PATCH, 'utf8');
	assert.match(patch, /diff --git a\/src\/map\/guild\.cpp/, 'guild.cpp is not in the patch');
	// The hook must sit AFTER the memcpy that overwrites the guild struct, or it is
	// repairing nothing.
	const guild = patch.slice(patch.indexOf('a/src/map/guild.cpp'));
	const memcpyAt = guild.indexOf('memcpy(&g->guild, &sg, sizeof(struct mmo_guild));');
	const hookAt = guild.indexOf('population_engine_reassert_guild_companions(sg.guild_id)');
	assert.ok(memcpyAt > -1, 'the memcpy anchor is not in the patch context');
	assert.ok(hookAt > memcpyAt, 'the re-assert call must come after the guild struct is overwritten');
});

test('the patch hands an Emperium break from a shell to its owner', () => {
	const patch = fs.readFileSync(PATCH, 'utf8');
	const mob = patch.slice(patch.indexOf('a/src/map/mob.cpp'));
	assert.match(mob, /population_engine_companion_owner_of/, 'the owner substitution is missing');
	assert.match(mob, /IS_POPULATION_ENGINE_ACCOUNT_ID/,
		'the substitution must be gated on the killer actually being a shell');
	// It has to be inside the npc_event dispatch: that is the only place that matters.
	const eventAt = mob.indexOf('md->npc_event[0] && !md->state.npc_killmonster');
	assert.ok(eventAt > -1, 'the npc_event dispatch block is not in the patch');
});

test('the patch adds the @companion guild verbs', () => {
	const patch = fs.readFileSync(PATCH, 'utf8');
	const atc = patch.slice(patch.indexOf('a/src/custom/atcommand.inc'));
	assert.match(atc, /strcmpi\(cmd, "guild"\)/, 'the guild verb branch is missing');
	assert.match(atc, /population_engine_companion_join_guild/, 'join is not wired');
	assert.match(atc, /population_engine_companion_leave_guild/, 'leave is not wired');
});
```

**T3.2 — run and watch it fail.**

```bash
cd "//wsl.localhost/Ubuntu-22.04/home/msi/repos/ragnarokoffline.app" && node tests/companion-guild.test.cjs
```
Expected: `ENOENT ... 0009-companion-guilds.patch` → 3 failing tests.

**T3.3 — build the patch from a real diff, not by hand.**
Hand-spliced hunks fail fresh application (wrong ±counts, duplicated context). The recipe, per
`references/patch-delta-isolation.md`:

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'rm -rf ~/gpre && git clone --no-hardlinks ~/ro/rathena ~/gpre && cd ~/repos/ragnarokoffline.app && bash scripts/apply-server-mods.sh ~/gpre 2>&1 | tail -3 && cp -r ~/gpre ~/gpost'
```
`~/gpre` is now pristine + patches 0001..0008 (the correct BASE for a new 0009 — a tree that
already contains 0009 would make `diff` omit the hunks that are identical on both sides).

Edit these three files **in `~/gpost` only**:

1. `~/gpost/src/map/guild.cpp` — inside `guild_recv_info()`, immediately after the
   `memcpy(&g->guild, &sg, sizeof(struct mmo_guild));` line and before the `if(g->guild.max_member >
   MAX_GUILD)` block, insert:

```cpp
	// RAGNAROKMAC (companion guilds): the memcpy above replaced the map's guild struct
	// with the char server's copy, and guild_check_member() (called above when this
	// guild was new to map memory) zeroes the guild_id of any online PC the char
	// server does not list as a member. Population shells have no `char` row, so the
	// char server's loader -- an INNER JOIN against `char` -- can never return them and
	// without this every companion silently loses its guild on each guild refresh.
	population_engine_reassert_guild_companions(sg.guild_id);
```

Add `#include "population_engine.hpp"` to guild.cpp's include block if it is not already there (it
is not).

2. `~/gpost/src/map/mob.cpp` — inside `mob_dead()`, in the `md->npc_event[0]` dispatch
(the block reading `if( sd && battle_config.mob_npc_event_type )`), substitute the killer:

```cpp
		if( md->npc_event[0] && !md->state.npc_killmonster ) {
			// RAGNAROKMAC (companion guilds): npc_event_sub() refuses to run a script
			// for a population shell, so a companion that lands the killing blow on an
			// Emperium would fire nothing -- OnAgitBreak would never run, the castle
			// would never change hands and the Emperium would never respawn. Hand the
			// event to the shell's OWNER instead: the owner's guild is the guild the
			// companion belongs to, so the script's getcharid(2) is the attacker either
			// way. Shells still never trigger OnTouch/OnTouch_ -- that guard is
			// untouched.
			if (sd != nullptr && IS_POPULATION_ENGINE_ACCOUNT_ID(sd->status.account_id)) {
				map_session_data *shell_owner = population_engine_companion_owner_of(sd);
				if (shell_owner != nullptr)
					sd = shell_owner;
			}
			if( sd && battle_config.mob_npc_event_type ) {
```

`mob.cpp` already includes `population_engine.hpp` (line 41) — verify, do not re-add.

3. `~/gpost/src/custom/atcommand.inc` — inside `ACMD_FUNC(companion)`, insert this branch
immediately after the `heal` block and before the final usage `clif_displaymessage`:

```cpp
	// RAGNAROKMAC (companion guilds): put a saved companion into the player's guild.
	// Membership is injected into the map's guild struct and remembered in
	// cp_companion_guild, because the char server cannot persist a shell's membership.
	if (strcmpi(cmd, "guild") == 0) {
		if (!param[0]) {
			clif_displaymessage(fd, "Usage: @companion guild <add|leave|status> [name]");
			return -1;
		}
		char verb[16] = {0}, gname[NAME_LENGTH] = {0};
		const int scanned = sscanf(param, "%15s %23[^\n]", verb, gname);
		if (scanned < 1) {
			clif_displaymessage(fd, "Usage: @companion guild <add|leave|status> [name]");
			return -1;
		}
		if (strcmpi(verb, "status") == 0) {
			population_engine_guild_status(sd, fd);
			return 0;
		}
		char reply[256];
		if (strcmpi(verb, "add") == 0 || strcmpi(verb, "join") == 0) {
			if (!gname[0]) {
				clif_displaymessage(fd, "Usage: @companion guild add <name>");
				return -1;
			}
			population_engine_companion_join_guild(sd, gname, reply, sizeof(reply));
			clif_displaymessage(fd, reply);
			return 0;
		}
		if (strcmpi(verb, "leave") == 0 || strcmpi(verb, "remove") == 0) {
			if (!gname[0]) {
				clif_displaymessage(fd, "Usage: @companion guild leave <name>");
				return -1;
			}
			population_engine_companion_leave_guild(sd, gname, reply, sizeof(reply));
			clif_displaymessage(fd, reply);
			return 0;
		}
		clif_displaymessage(fd, "Usage: @companion guild <add|leave|status> [name]");
		return -1;
	}
```

Also extend the final usage line in the same function to mention the new verb:
`... | gear <name> [slots] | guild <add|leave|status> [name] | heal <a%> <b%>`.

4. `~/gpost/npc/scripts_custom.conf` — add the WoE NPC line (Phase 5 creates the file; do this
last so the patch and the file land together):

```
npc: npc/custom/population/woe_event.txt
```

**T3.4 — produce and validate the patch.**

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~ && diff -u --recursive --new-file gpre/src/map/guild.cpp gpost/src/map/guild.cpp | sed -e "s|^--- gpre/|--- a/|" -e "s|^+++ gpost/|+++ b/|" > /tmp/g.patch; diff -u --recursive --new-file gpre/src/map/mob.cpp gpost/src/map/mob.cpp | sed -e "s|^--- gpre/|--- a/|" -e "s|^+++ gpost/|+++ b/|" >> /tmp/g.patch; diff -u --recursive --new-file gpre/src/custom/atcommand.inc gpost/src/custom/atcommand.inc | sed -e "s|^--- gpre/|--- a/|" -e "s|^+++ gpost/|+++ b/|" >> /tmp/g.patch; diff -u --recursive --new-file gpre/npc/scripts_custom.conf gpost/npc/scripts_custom.conf | sed -e "s|^--- gpre/|--- a/|" -e "s|^+++ gpost/|+++ b/|" >> /tmp/g.patch; wc -l /tmp/g.patch'
```
Expected: a non-zero line count. Then convert to the repo's convention (numbered patch with a
`Subject:` header, CRLF line endings, `diff --git a/... b/...` lines) and place it as
`third-party/population-engine/patches/0009-companion-guilds.patch`. The reliable way to get the
CRLF + header shape right is to copy the structure of `0008-companion-skill-selector.patch`
(header block, then one `diff --git` section per file) and paste the diff bodies generated above.

**T3.5 — run the hunk-count checker (mandatory).**

```bash
python3 "C:/Users/diena/AppData/Local/hermes/skills/ragnarok-offline-client-modding/scripts/check_patch_hunks.py" "//wsl.localhost/Ubuntu-22.04/home/msi/repos/ragnarokoffline.app/third-party/population-engine/patches/0009-companion-guilds.patch"
```
Expected: `0 mismatches`. Any mismatch → the patch applies silently truncated on a FRESH apply
(which is what CI does) while your dev tree keeps the full content.

**T3.6 — apply the full set to a pristine tree and prove the code landed, then compile.**

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'rm -rf ~/gfresh && git clone --no-hardlinks ~/ro/rathena ~/gfresh && cd ~/repos/ragnarokoffline.app && bash scripts/apply-server-mods.sh ~/gfresh 2>&1 | grep -Ei "fail|reversed|error" ; grep -c population_engine_reassert_guild_companions ~/gfresh/src/map/guild.cpp; grep -c population_engine_companion_owner_of ~/gfresh/src/map/mob.cpp; grep -c "companion guild" ~/gfresh/src/custom/atcommand.inc'
```
Expected: no `fail`/`reversed`/`error` lines, then `1`, `1`, and `1`.
Then compile the patched TUs:

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/gfresh && for f in src/map/guild.cpp src/map/mob.cpp src/map/atcommand.cpp; do g++ -std=c++17 -fsyntax-only -I . -I src -I src/common -I src/map -I 3rdparty/rapidyaml/src -I 3rdparty/rapidyaml/ext/c4core/src -I 3rdparty/yaml-cpp/include -I 3rdparty/libconfig -I /home/msi/ro-build/mp/usr/include/mariadb $f || echo "FAILED $f"; done; echo DONE'
```
Expected: `DONE` with no `FAILED`.

**T3.7 — prove the call sites bind** (cross-TU, the only local check that catches a link error):

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/gfresh && g++ -c -std=c++17 -I . -I src -I src/common -I src/map -I 3rdparty/rapidyaml/src -I 3rdparty/rapidyaml/ext/c4core/src -I 3rdparty/yaml-cpp/include -I 3rdparty/libconfig -I /home/msi/ro-build/mp/usr/include/mariadb src/map/guild.cpp -o /tmp/gu.o && g++ -c -std=c++17 -I . -I src -I src/common -I src/map -I 3rdparty/rapidyaml/src -I 3rdparty/rapidyaml/ext/c4core/src -I 3rdparty/yaml-cpp/include -I 3rdparty/libconfig -I /home/msi/ro-build/mp/usr/include/mariadb src/map/mob.cpp -o /tmp/mo.o && nm -C /tmp/gu.o | grep reassert_guild && nm -C /tmp/mo.o | grep companion_owner_of'
```
Expected: an uppercase `U population_engine_reassert_guild_companions(...)` from `guild.o`, and an
uppercase `U population_engine_companion_owner_of(...)` from `mob.o`.

**T3.8 — negative control.** In `~/gfresh`, delete the declaration of
`population_engine_reassert_guild_companions` from `src/map/population_engine.hpp`, re-run the
T3.7 compile of `guild.cpp`, and confirm you now get
`error: 'population_engine_reassert_guild_companions' was not declared in this scope`. Restore the
declaration and confirm clean again. Without this, a clean compile proves the TU did not exercise
the call.

**T3.9 — run the test, watch it go green, commit.**
```bash
cd "//wsl.localhost/Ubuntu-22.04/home/msi/repos/ragnarokoffline.app" && node tests/companion-guild.test.cjs
```
Expected `# fail 0`. Commit: `Companion guilds: re-assert after guild info rebuild, owner-substitute the Emperium break, @companion guild verbs`.

**T3.10 — calibration (house rule).** The new tests must FAIL on the parent commit. The safe shape
is a scratch worktree, not stashing:

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/repos/ragnarokoffline.app && git worktree add /home/msi/cal_parent HEAD~1 2>&1 | tail -2 && cp tests/companion-guild.test.cjs /home/msi/cal_parent/tests/ && echo COPIED'
```
Then run the copy with Windows node against the UNC path and require failure:
```bash
node "//wsl.localhost/Ubuntu-22.04/home/msi/cal_parent/tests/companion-guild.test.cjs"
```
Expected on the parent: every new assertion failing (`ENOENT` for the patch, missing symbols in the
engine). Report "N of M failing on the parent commit" in the commit message. Assertions that ALSO
pass there are weak probes — tighten them. Clean up with
`git worktree remove --force /home/msi/cal_parent`.

---

## Phase 4 — the guild steward NPC (data only, no patch beyond one conf line)

**T4.1** Create `third-party/population-engine/files/npc/custom/population/woe_event.txt`.
It has exactly three jobs: tell the player whose castle it is, raise the guild's level (skill points
come only from guild levels), and grant `GD_APPROVAL` — without which nothing can damage the
Emperium at all.

```
//===== Companion guilds: War of Emperium steward =====================
//= Sits in the castle lobby of the First-Edition castle (aldeg_cas01).
//= Raising the guild level is the ONLY source of guild skill points, and
//= GD_APPROVAL is required to damage an Emperium at all
//= (battle_can_hit_gvg_target(), src/map/battle.cpp). A guild that never
//= learns it will watch its companions stand in front of the Emperium
//= forever without scratching it.
//=====================================================================
aldeg_cas01,148,32,4	script	Castle Steward	4_F_08,{
	mes "^336699[Castle Steward]^000000";
	mes "Castle: ^FF6600" + getcastlename("aldeg_cas01") + "^000000";
	.@owner = GetCastleData("aldeg_cas01", CD_GUILD_ID);
	if (.@owner <= 0)
		mes "This castle is currently ^FF0000unoccupied^000000.";
	else
		mes "Held by the guild ^0000FF" + GetGuildName(.@owner) + "^000000 (id " + .@owner + ").";
	next;
	switch(select(
		"Hear the rules:Companion guilds",
		"Raise my guild's level",
		"Learn Guild Approval",
		"Nothing")) {
	case 1:
		mes "^336699[Castle Steward]^000000";
		mes "Your companions can hold this castle with you.";
		mes " ";
		mes "1. Create a guild with ^FF6600@guild <name>^000000. You are its master.";
		mes "2. Add companions with ^FF6600@companion guild add <name>^000000.";
		mes "3. Raise the guild level here until you have a skill point.";
		mes "4. Learn Guild Approval here. Without it no attack of yours";
		mes "   or your companions' can damage an Emperium.";
		mes "5. Bring them here during War of Emperium and break the Emperium.";
		close;
	case 2:
		if (getcharid(2) <= 0) {
			mes "You have no guild of your own. Create one with @guild <name> first.";
			close;
		}
		// +10 guild levels also grants +10 guild skill points
		// (mapif_parse_GuildBasicInfoChange, GBI_GUILDLVL).
		atcommand "@guildlvup 10";
		mes "Your guild has been raised. Check the guild window for the new level.";
		close;
	case 3:
		if (getcharid(2) <= 0) {
			mes "You have no guild of your own.";
			close;
		}
		if (getgdskilllv(getcharid(2), GD_APPROVAL) > 0) {
			mes "Your guild already holds Guild Approval.";
			close;
		}
		if (getcharid(2) != GetCastleData("aldeg_cas01", CD_GUILD_ID) && getcharid(2) != getcharid(2)) {
			// no-op guard kept explicit: approval is not tied to castle ownership
		}
		guildskill GD_APPROVAL,1;
		mes "^336699[Castle Steward]^000000";
		mes "Guild Approval granted. Your guild can now damage an Emperium.";
		close;
	case 4:
		close;
	}
	end;
}
```

Two scripting constraints from this build, both already learned the hard way: no `showinfo`, no
`OnNPCTalk` label, no `sd->`, and use bare `script` bodies — a top-level block with `mes`/`next`/
`switch(select(...))` and colon-delimited options is what renders clickable rows in this client.

**T4.2 — verify the script parses and the Approval path works.** Bring the stack up and read the
map log:

```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'echo ok'
```
Then from Windows bash:
```bash
cd "C:/Users/diena/AppData/Roaming/Ragnarok Offline" && powershell.exe -NoProfile -Command "& '.\runtime\bin\ragnarok-stack.exe' down" ; powershell.exe -NoProfile -Command "& '.\runtime\bin\ragnarok-stack.exe' up" ; sleep 20 ; powershell.exe -NoProfile -Command "& '.\runtime\bin\ragnarok-stack.exe' logs map 3000" | grep -iE "woe_event|parse error|script error"
```
Expected: no `parse error` line naming `woe_event.txt`. (A file with any parse error is skipped
entirely, so the NPC would render and do nothing.) Note `down`/`up` recreate containers from the
image — that is what makes a `files/` change visible, and it also discards any in-container edit.

**T4.3 — the mapflag that makes the GvG simulation possible (NOT optional).**
Without this, two rival companion guilds cannot damage each other (see "The blocker for
companion-vs-companion" above: all shells on a map share the fake party id `0x70000000 | map_id`,
`battle.cpp:8175` makes them `BCT_PARTY`, and `battle.cpp:8232` strips their `BCT_ENEMY`).
Create `third-party/population-engine/files/npc/custom/population/woe_mapflags.txt`:

```
//===== Companion guilds: War of Emperium mapflags ====================
//= gvg_noparty is REQUIRED for companion-vs-companion sieges. Every
//= population shell on a map is given the same fake party id at spawn
//= (population_engine.cpp:4283), so without this flag battle_check_target
//= classifies two rival companion guilds as BCT_PARTY, and the final
//= normalisation at battle.cpp:8232 strips their BCT_ENEMY -- they would
//= be unable to damage each other. The dedicated GvG maps guild_vs1-5
//= carry this flag for the same reason.
//=====================================================================
aldeg_cas01	mapflag	gvg_noparty
```

and register it next to the WoE NPC in `~/gpost/npc/scripts_custom.conf` (the same patch hunk as
T3.3 step 4, so one `npc:` line each):

```
npc: npc/custom/population/woe_event.txt
npc: npc/custom/population/woe_mapflags.txt
```

Verify with T5.5 — if two companion guilds stand next to each other and neither attacks, this
mapflag is missing or the file is not loaded.

---

## Phase 5 — end-to-end WoE validation (the actual deliverable)

Run this after Phase 6 deploys. Keep the map-server log open: `ragnarok-stack.exe logs map 4000`.

**T5.1 Setup, in game as the group-99 account.**
1. `@guild Stewards` (or any name). Expect a guild-created confirmation; the `@guild` atcommand
   clears `guild_emperium_check`, so no Emperium item is needed.
2. `@companion list` → note a companion's exact name (the raw form is
   `@CP|name|job|base_level|active|fav|live_level|live_job`).
3. `@companion guild add <name>` → expect `'<name>' joined your guild.`
4. `@companion guild status` → expect `Companions in this guild: 1 (1 summoned).`
5. Talk to the Castle Steward → `Raise my guild's level` (twice, for 2 skill points) → then
   `Learn Guild Approval`.
6. `@companion guild add <name>` for each remaining companion (the limit is 11 by
   `settings.json`'s `population_companion_limit`; a guild holds 16, so 1 player + 11 companions fits
   with room to spare).

**T5.2 Prove membership reached the guild struct.**

```bash
curl -s -m 10 -X POST "http://127.0.0.1:7462/docker/v1.44/containers/ragnarok-map/logs?stdout=1&stderr=1&tail=200" | grep -a "re-asserted"
```
Expected, after any guild refresh (login or `@requestguildinfo`): a line
`Population engine: re-asserted N companion(s) in guild <id>.` with N = the number of summoned
companions. Zero lines here with companions added means the hook is not wired (check T3.6's greps).
Also confirm in the client's guild window (Alt+G) that the companions appear as members.

**T5.3 Persistence across a restart.** Quit the app completely, relaunch, log in, then:

```bash
cd "C:/Users/diena/AppData/Roaming/Ragnarok Offline" && "./runtime/bin/ragnarok-stack.exe" sql "SELECT cg.guild_id, cg.shell_index, cp.name FROM cp_companion_guild cg LEFT JOIN cp_companion_persistence cp ON cp.shell_index = cg.shell_index ORDER BY cg.shell_index;"
```
Expected: one row per companion that joined, with its name and the guild id. Then in game,
`@companion guild status` must report the same count without re-adding anyone — that is the
persistence requirement.

**T5.4 The WoE event.**

```bash
cd "C:/Users/diena/AppData/Roaming/Ragnarok Offline" && "./runtime/bin/ragnarok-stack.exe" sql "SELECT castle_id, guild_id FROM guild_castle WHERE castle_id = 0;"
```
Expected: `castle_id=0, guild_id=0` (unoccupied).

In game: warp to the castle with `@warp aldeg_cas01 212 175`, then start the siege with
`@agitstart`. Expected in the map log: the `Agit_Event` / `Gld_Agit_Manager` event lines and an
`Emperium` spawn in the room at (216,23). Walk to the Emperium room; the companions should follow
and attack it.

**T5.5 Confirm the guild rivalry is real (one account is enough for this).** Take the castle with
character B first (same account), in guild B, with **no companions** — guild membership is
per-character, so B's guild can hold the castle while A's companions stay in guild A. Then log in
as character A, summon the roster, and re-enter: A's companions must attack B and the castle's
Emperium and **not** each other, because `battle_check_target()` reads their rival `guild_id`. This
is the whole mechanic proven on one account. Do not try "a second character with its own
companions" — the roster is keyed on `owner_account_id` (see risk 3), so a second character summons
the *same* companions, who are already in guild A. A genuine companion-vs-companion siege is the
only thing that needs a second account. If you set `gvg_noparty` (risk 2), remember this test now
requires it, since A and B share a party.

**T5.6 Break it and confirm ownership.**

```bash
cd "C:/Users/diena/AppData/Roaming/Ragnarok Offline" && "./runtime/bin/ragnarok-stack.exe" sql "SELECT castle_id, guild_id FROM guild_castle WHERE castle_id = 0;"
```
Expected after the Emperium dies: `guild_id` = your guild's id (1 on a fresh database), and in game
the announcement `The [Neuschwanstein] castle has been conquered by the [Stewards] guild.` appears
(from `npc/guild/agit_main.txt` `OnAgitBreak`). Then `@agitend` and re-check: the value must still be
your guild id — that is stock castle persistence, and it is what makes the event meaningful.
If the Emperium takes damage but never dies, that is expected: it is 100 HP at 1 damage per hit.
If it takes **no** damage at all, `GD_APPROVAL` was not learned (T5.1 step 5).

**T5.7 Artifact-side proof comes later, in T6.4.** There is no useful check here: the running
map-server binary is stripped, so probe the **log sentence** the change emits (never a function
name, never a comment), and always pair it with an ancient `Population engine:` string as the
positive control so a wall of zeros is visibly the probe's fault.

---

## Phase 6 — deployment

Engine C++ + the new patch + the cmds.rs DDL all ship in the **server** half only. There is no
client change in this feature, so only the images bundle needs replacing.

**T6.1 — commit and push** to fork `main` (this auto-fires `images.yml`, which is harmless).
Nothing here needs a pull request; the upstream PR stays on hold.

**T6.2 — gate the installer dispatch on the images run.**
Per `references/population-engine-patches.md`:
```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'cd ~/repos/ragnarokoffline.app && git rev-parse HEAD && gh run list -R clarois/ragnarokoffline.app --workflow images.yml -L 3'
```
Wait for the run for **that exact sha** to reach `completed`, then confirm the published asset is
newer than the push:
```bash
wsl.exe -d Ubuntu-22.04 -u msi bash -lc 'gh api "repos/clarois/ragnarokoffline.app/releases/tags/images" --jq ".updated_at, (.assets[] | select(.name==\"images-x64.tar.gz\") | .updated_at)"'
```
Do **not** dispatch `build.yml` before this — an early dispatch ships the previous commit's server
code and the feature appears absent. **Ask the user before dispatching the installer build**; that
is a standing rule for this project. Then report the run id and the artifact name
(`ragnarok-offline-win-x64`) and let the user download it themselves.

**T6.3 — deploy to the running app** (the runtime bundle, not the installer payload):
1. Download the fresh `images-x64.tar.gz`.
2. Compare it against `%APPDATA%\Ragnarok Offline\runtime\dist\images.tar.gz`: gunzip the layers and
   grep for a string only the new code emits (e.g. `re-asserted %d companion(s) in guild`) and one
   only the old code does. A pair like `0 / present` versus `present / 0` is proof, not inference.
3. With the app fully quit, back up the old bundle, copy the new one over the **runtime** path, and
   delete `state/image-bundle.id` so `ensure_images()` cannot skip the load.
4. Relaunch.

**T6.4 — verify the RUNTIME, not the source.**
```bash
curl -s -m 10 -X POST "http://127.0.0.1:7462/docker/v1.44/containers/ragnarok-map/exec" -H "Content-Type: application/json" -d '{"AttachStdout":true,"Cmd":["sh","-c","grep -c \"re-asserted\" /rathena/map-server; grep -c \"Population engine:\" /rathena/map-server"]}'
```
(Function names are useless on this binary — it is stripped, and `nm` reads 0 for everything. Probe
the **log sentence** the change emits, and always include an ancient `Population engine:` string as
the positive control so a wall of zeros is visibly the probe's fault.) Expected: a non-zero count for
the new sentence. Then confirm the table exists inside the guest:
```bash
cd "C:/Users/diena/AppData/Roaming/Ragnarok Offline" && "./runtime/bin/ragnarok-stack.exe" sql "SHOW COLUMNS FROM cp_companion_guild;"
```
Expected: 5 columns (`owner_account_id`, `shell_index`, `guild_id`, `position`, `joined_at`).

---

## Tests / validation summary

**Structural tests** (`tests/companion-guild.test.cjs`, node, run with Windows node against the UNC
path — `node --test` cannot resolve UNC, so invoke the file directly):
1. the boot DDL creates `cp_companion_guild` with all five columns;
2. the `files/sql-files/.../cp_companion_guild.sql` doc copy matches `cmds.rs` after whitespace
   normalisation (this is the pair that drifted silently the last time a column was added);
3. every new engine symbol is declared in the `.hpp` and defined in the `.cpp`;
4. `pop_companion_register_local_guild` sets `status.guild_id` and `member[i].sd` and never calls
   `intif_guild_addmember`;
5. recall calls `population_engine_restore_guild_companions`;
6. `population_engine_shell_release` calls `population_engine_guild_scrub_shell`;
7. patch 0009's `guild.cpp` hook sits after the `memcpy` that overwrites the guild struct;
8. patch 0009 substitutes the shell's owner in `mob.cpp`, gated on `IS_POPULATION_ENGINE_ACCOUNT_ID`,
   inside the `npc_event` dispatch block;
9. patch 0009 wires the `@companion guild` verbs.

**Every one of those must fail on the parent commit** (calibration rule). `git show --stat <sha> |
grep -c tests` is the completeness check.

**Compile/link gates** (per task, Phase 2/3): fresh tree → `apply-server-mods.sh` → grep the new
symbol in the patched TU *before* compiling → `-fsyntax-only` on each touched TU →
`nm -C` uppercase `T` on the definition and `U` at each call site → the negative control (delete the
declaration, require a hard error). Never present a syntax check as "it works": it does not link.

**Runtime gates:** T2.5-T2.6 (engine), T3.6-T3.7 (patch), T4.2 (NPC parses),
T5.2/T5.3 (membership + persistence), T5.4/T5.6 (the event and the castle flip),
T6.4 (the deployed binary and the guest schema).

**Do not write a probe whose result you have not calibrated.** Before reporting a `0`, re-run the
same probe against something known present.

---

## Risks, tradeoffs, and open questions

1. **The Emperium-event attribution fix is the riskiest change** because it touches `mob_dead()`, a
   hot function shared by every mob death. It is gated on the killer being a shell, and shells only
   exists in this build, so the blast radius is limited to companion kills — but it must be
   reviewed as "the one place a shell is allowed to cause a script to run", and the `npc_event_sub`
   guard (which stops shells firing OnTouch while roaming) must stay exactly as it is. If the user
   prefers not to touch `mob.cpp` at all, the fallback is **the player lands the killing blow**: the
   companions clear the guardians and chew the Emperium down, and the real player's hit fires
   `OnAgitBreak` with the correct `getcharid(2)`. That fallback needs no C++ change at all and is
   worth offering as a staged first step.
2. **RESOLVED, and it is worse than "party overlap" — it is the default.** Not just an edge case
   where attacker and defender share a party: `population_engine.cpp:4283` gives **every** shell on
   a map the *same* fake party id (`0x70000000 | map_id`), so rival companion guilds are mutual
   party-mates by construction, `battle.cpp:8175` sets `BCT_PARTY`, and the normalisation at
   `battle.cpp:8232` strips their `BCT_ENEMY` — they cannot damage each other. `gvg_noparty` on the
   castle map is therefore a **required** deliverable, not an option (Phase 4, T4.3). Do not ship
   without it and do not let it be reclassified as a nice-to-have: without it the headline feature
   of this plan — a companion guild fighting a rival companion guild — silently does nothing, and
   the symptom (two groups standing next to each other, unbothered) looks like an AI bug rather
   than a mapflag.
3. **A companion roster is bound to the ACCOUNT, not the character** — so a second character does
   NOT give you a second roster. `cp_companion_persistence` is keyed on `owner_account_id`, and all
   16 roster queries in `population_engine.cpp` filter on `owner_account_id` with no `char_id`
   term, so every character on an account summons the same companions. Since a companion can be in
   only one guild at a time (one shell = one member row), **one account can only ever field one
   companion-filled guild**; a companion-vs-companion siege needs two accounts. Note what is *not*
   the constraint: a guild starts at 16 members but `int_guild.cpp:888` sets
   `max_member = 16 + GD_EXTENSION_level * 6` with `GD_EXTENSION` `MaxLevel: 10` (76 max,
   clamped in `guild.cpp:857`), and the companion ceiling of 11 is set by `MAX_PARTY` (12 minus the
   leader, per the comment on `pop_companion_limit()`), so the party — not the guild — is the
   bottleneck. One account covers the stated goal completely (see T5.4: an unoccupied castle has
   `guild_id = 0` and therefore no defender at all); two accounts are only needed to simulate an
   enemy companion guild. A cheaper contested test is in T5.5.
4. **`guild_check_member()` actively zeroes the shells' `guild_id` on every first load of a guild**,
   and the re-assert hook is what puts it back. If the hook is ever bypassed (a code path that
   rebuilds guilds without going through `guild_recv_info`), companions silently stop being guild
   members and the symptom looks like "the companions ignore the Emperium" — the same
   one-field-wrong-many-symptoms shape this project has hit repeatedly.
5. **`connect_member` is deliberately not incremented** for shells, so the guild window's "online"
   count will read 1 (the player) rather than 12. That is intentional (the char server recomputes it
   and would flap), but it is a visible inconsistency the user may report as a bug. Say so up front.
6. **Sprite/name rendering in the guild window is untested.** Companions already render correctly in
   the party window, and the guild window's member list carries the same fields
   (`clif_guild_memberlist`), so this should work — but it has not been verified, and roBrowser's
   guild UI is not guaranteed to handle a member whose `char_id` is outside the real range.
7. **Deferred deliberately (YAGNI):** a native in-game window for guild management (if the user asks
   for one, it is the `GUIComponent` recipe with the existing Companion Panel as the template — a
   separate, larger job); guild storage; guild skills beyond `GD_APPROVAL`; alliances/opposition
   between companion guilds (stock works if two real guilds exist); guardians and economy/defense
   investment (the player can do those through the castle Steward NPC); WoE:TE and Second Edition
   (the SE castles are `gvg_te_castle` and need `agit2`/`agit3`, a different flag path); companions
   founding their own guilds.
8. **Open question for the user:** should a companion keep its guild membership if it is dismissed
   (`active = 0`) and later re-summoned? This plan keeps the row and re-joins on the next summon,
   which matches how party membership behaves — but "dismissed" could reasonably mean "left the
   guild". Cheap either way; pick one and put it in the test.
9. **Open question:** should the second `@agitstart`-style trigger be a schedule (the stock
   `Agit_Event` clock at Tue/Thu 21:00 and Sat 16:00 server time in `npc/guild/agit_controller.txt`)
   or manual only? Manual (`@agitstart` / `@agitend`) is what is tested here; making it scheduled
   means editing that stock controller file, which is a separate decision.

---

## Command cheat-sheet

| purpose | command |
|---|---|
| structural tests | `node //wsl.localhost/Ubuntu-22.04/home/msi/repos/ragnarokoffline.app/tests/companion-guild.test.cjs` |
| hunk counts | `python3 …/scripts/check_patch_hunks.py <patch>` |
| fresh apply | `bash scripts/apply-server-mods.sh ~/gfresh` |
| syntax only | `g++ -std=c++17 -fsyntax-only <verified include set> <tu>` |
| link gate | `g++ -c … $tu -o /tmp/x.o && nm -C /tmp/x.o \| grep <symbol>` |
| guest schema | `ragnarok-stack.exe sql "SHOW COLUMNS FROM cp_companion_guild;"` |
| castle owner | `ragnarok-stack.exe sql "SELECT castle_id, guild_id FROM guild_castle WHERE castle_id = 0;"` |
| membership rows | `ragnarok-stack.exe sql "SELECT * FROM cp_companion_guild;"` |
| runtime probe | `grep -c "<new log sentence>" /rathena/map-server` inside the map container |
| map log | `ragnarok-stack.exe logs map 4000` |
