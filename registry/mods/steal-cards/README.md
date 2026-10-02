# steal-cards

The Thief's `Steal` skill can return cards, rolled independently of the
mob's other drops.

**1,260 monsters** — every non-MVP monster in rAthena's `mob_db.yml` that has
a card drop — gain a stealable card slot. Killing them still rolls the card
drop at its stock rate; Steal now rolls it too, at the card's own rate,
without having to wait for every earlier drop to fail first.

MVPs are excluded, so Baphomet's card stays untouchable — and so do
Doppelganger, Dracula, Phreeoni, Eddga, Orc Hero, Moonlight Flower and the
other 190-odd. Mini-bosses like Angeling, Deviling, Ghostring and Vagabond
Wolf are `Class: Boss` but not real MVPs (they have no `MvpDrops:` and no
`Modes.Mvp: true`), so their cards *are* stealable, which is usually the whole
reason a Thief learns Steal in the first place.

## Why the skill ignores cards to begin with

`Steal` (`TF_STEAL`) is `pc_steal_item` in `vendor/rathena/src/map/pc.cpp`. It
walks the target monster's `Drops[]` table in slot order, skips every entry
marked `steal_protected`, and gives the first one whose own roll succeeds.
rAthena's stock `db/re/mob_db.yml` and `db/pre-re/mob_db.yml` both mark
**every card drop as `StealProtected: true`**, so the eligible list is always
Jellopy and Sticky Mucus and never the card. Flipping the flag is only half
the fix: a Jellopy at 1.5x+ rates sits at 100% and still wins the roll before
any later-slot drop is even considered, so the card remains unreachable even
once it is marked stealable. That is what the Lua hook is for.

## What this mod does

Two layers, both in this folder, that only work together:

### 1. `db/mob_db.yml` — unprotect the card slot

1,260 entries of exactly this shape:

```yaml
- Id: 1002 # Poring (PORING) -- Poring_Card
  Drops:
    - Index: 7
      StealProtected: false
```

`db/import` layers over rAthena's own table — see
[docs/MODDING.md](../../../docs/MODDING.md) — and only the fields spelled here
are touched. Poring's Jellopy, Knife, Sticky Mucus and the rest of its stock
drops are exactly where they were, at the rates they were. All this file
changes is the one flag on Slot 7.

**The `Index:` matches the card's real slot in the stock table** — 7 for
Poring, 6 for Ghostring, 8 for many second-job monsters. The generator reads
the pinned `vendor/rathena/db/re/mob_db.yml` and copies the index verbatim, so
the override lands on the same drop the on-kill roll uses. Nothing is
duplicated and nothing else moves.

`Item:` and `Rate:` are deliberately **not** restated. rAthena's
`MobDatabase::parseDropNode` treats them as optional on an override that
targets an existing `Index:`, so the card name and its stock drop rate are
whatever rAthena ships them as. That matters when the vendor pin moves and
rAthena bumps a rate: the on-kill roll and the Steal roll track the new
value automatically. Spell `Rate:` on an override only when you want to pin a
specific card's drop weight — note it affects both the on-kill roll and
Steal, since both pull from the same `Drops[]` entry.

### 2. `lua/steal_cards.lua` — roll cards first, independently

Unprotecting the card is not enough: `pc_steal_item` still iterates the drop
list in slot order and stops at the first roll that succeeds, so a Jellopy at
100% always wins before the card is even rolled. The hook sidesteps that by
rolling each card drop at its own rate *before* the stock loop runs, and only
falling through to stock behaviour if every card roll fails:

```lua
skill("TF_STEAL", {
  on_steal = function(c)
    for _, drop in ipairs(c.drops) do
      if drop.is_card and c:chance(drop.rate) then
        return drop
      end
    end
  end,
})
```

`on_steal` is a fork hook added for this mod; it fires from `pc_steal_item`
after the DEX/skill-level success check and lets the hook pick which
stealable drop the thief gets. See `vendor/rathena/src/map/skill_lua.cpp`.
Returning nil (as this hook does when no card roll succeeds) runs the stock
slot-order loop, so Jellopy, Knife and Sticky Mucus still steal the way they
always did.

**What the odds really are.** The card's roll is `rnd() % 10000 < drop.rate`,
where `drop.rate` is the server-adjusted drop rate (Card drops in the server
settings scales it). On a Poring at 1x rates that is 20 out of 10000 — **0.2%
per successful steal, roughly one Poring in 500**, independent of what else
is in Poring's drop table. The skill's own DEX/level success chance still
applies on top. Raising the common-item drop rate no longer makes cards
harder to steal, and a monster with an earlier drop at 100% no longer locks
its card away.

### Why the override is this small

Until rAthena [Flux159/rathena#4](https://github.com/Flux159/rathena/pull/4),
`MobDatabase::parseDropNode` required `Item` and `Rate` on every drop entry
and rewrote every field on the target slot. An override wanting to touch only
`StealProtected` had to restate the stock `Item` and `Rate`, and would silently
drift the moment rAthena bumped the on-kill rate underneath it. With that fix
in place, an override spells only the fields it changes, and the rest of the
drop is left alone.

## Confirming it works

Install the folder, restart the server (Settings → Restart server, since only
`db/` and `lua/` changed — no app restart needed), and:

1. Look at the map server log for `Loading '1260' entries in
   'db/import/mob_db.yml'`. Fewer entries means part of the file didn't parse.
2. Look for `Lua: loaded ... 1 skill hook(s) across 1 skill(s)` and no error
   about `TF_STEAL`. A missing hook here means the vendor rAthena predates
   the `on_steal` hook — bump `config/VENDOR_PINS`.
3. Roll a Thief, learn Steal, find a Poring. `@whodrops 4001` (Poring Card)
   lists Poring at its rate.
4. Cast Steal on Porings until one gives up the card — at 1x rates, on the
   order of 500 Porings (see the odds above). To check the mod rather than
   your patience, raise **Card drops** in the server settings, or try a
   monster whose card rate is higher.

If Steal still only returns Jellopy and Apple, check the log for a YAML parse
error, check that the target monster's Id is in `db/mob_db.yml`, and check
that the Lua hook loaded.

## Renewal only

rAthena ships two mob tables, `db/re/mob_db.yml` and `db/pre-re/mob_db.yml`,
and they do **not** agree on where the card sits: of the 451 monsters with a
card in both, 97 have it in a different slot (Hornet's is 7 in renewal and 6
in pre-renewal). The override names a slot, not an item, so on a pre-renewal
server it would unprotect whatever drop happens to be in that slot and leave
the card protected. A mod cannot ship a table per era, so `mod.json` asks for
`"era": "renewal"` and the app refuses it on a pre-renewal world, saying so.

## Regenerating the table

`db/mob_db.yml` is generated, and committed: the mod works as it is, and
nothing a player installs runs Python. The generator lives outside the mod
folder, at
[`registry/tools/steal-cards/generate.py`](../../tools/steal-cards/generate.py),
and needs only the Python standard library. Run it from the repository root
when `config/VENDOR_PINS` moves rAthena, or to change the criteria:

```sh
scripts/vendor-fetch.sh rathena vendor/rathena    # the pinned commit
python3 registry/tools/steal-cards/generate.py    # rewrites db/mob_db.yml
python3 registry/tools/steal-cards/generate.py --check   # or: is it current?
```

It reads `vendor/rathena/db/re/mob_db.yml` (`--source` for another copy),
writes the rAthena commit it read into the output's header, and warns when
that is not the commit `config/VENDOR_PINS` pins. Then regenerate the index
(`python3 scripts/mod-index.py`) and raise `version` in `mod.json`.

### What the generator excludes

`is_mvp()` in `generate.py`. Two rules:

1. `MvpDrops:` field present — Baphomet, Turtle General, Ktullanux, the whole
   real-MVP list.
2. `Modes.Mvp: true` — a handful of MVPs (Bone Detale, EP18_MD_SCHULANG) that
   set the mode without an explicit MvpDrops block.

**`Class: Boss` is not enough.** 539 monsters carry `Class: Boss` without
being MVPs: mini-bosses, boss-class field monsters, event bosses. Their cards
stay in the mod. If you want a stricter version — no bosses at all, however
minor — add `or mob["class"] == "Boss"` to `is_mvp()` and rerun.

## What this mod is not

- **It does not change what `Steal` costs, how far it reaches, or its
  formula.** That is `db/skill_db.yml` and `TF_STEAL` in `src/map/skill.cpp`,
  and both are left alone. The hook fires only after `pc_steal_item`'s own
  DEX/level success check passes.
- **It does not make MVP cards stealable.** They are excluded by design. If
  you want them in too, make `is_mvp()` in `generate.py` return `False` and
  rerun — the hook already picks whatever cards are stealable on the mob.
- **It does not touch drops that are not cards.** Card equipment drops
  (Poring Hat, etc.) stay steal-protected if they were, and stealable if they
  were. Only slots whose item name ends in `_Card` are rewritten, and the
  hook filters by `drop.is_card`.
- **It does not change on-kill drop rates.** The card roll on kill is the
  mob's own stock roll, with the Card drops multiplier applied — exactly as
  before this mod existed.
- **It does not remove the client's own "cards cannot be stolen" cooldown
  string.** rAthena stopped sending that message the moment the eligible
  list contained a card, so it never appears with this mod installed. The
  client literal in `msgstringtable.txt` is left alone.

## Applying it

`db/` and `lua/` are both read when the server starts. Settings → Restart
server is enough.
