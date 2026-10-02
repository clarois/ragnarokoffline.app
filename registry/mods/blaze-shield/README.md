# blaze-shield

Three changes to Ninja's Blaze Shield (`NJ_KAENSIN`), each with its own
checkbox under **Settings → Mods → blaze-shield**. Tick the ones you want and
press **Apply**; the server restarts with them.

| Option | Default | What it does | Where |
|---|---|---|---|
| Drain on every pillar hit | on | HP/SP drain bonuses fire on each pillar hit | [`lua/when/drain/`](lua/when/drain/drain.lua) |
| Hylozoist Card on every pillar hit | on | Hylozoist Card's polymorph rolls on each pillar hit | [`lua/when/classchange/`](lua/when/classchange/classchange.lua) |
| Pillars hold monsters | off | a pillar hits on entry and holds the monster until it burns out | [`db/when/pin/`](db/when/pin/extension_db.yml) |

The first two were the `blaze-shield-drain` and `blaze-shield-classchange`
mods, and the third is by BlaXun (ragnarokoffline.app#244). They are one mod
now, so one install gives all three and Settings switches them.

## Drain on every pillar hit

Stock rAthena only runs the drain family on weapon attacks, so a Ninja
channelling Blaze Shield with Moonlight Dagger never gains SP from a pillar.
With this on, `c:drain()` runs on each pillar hit, the same action the
weapon-attack path does, so every drain bonus follows along:
`bSPDrainValue` (Moonlight Dagger, 3 SP a hit), `bHPDrainValue`, their race
and class variants, and the drain-rate bonuses.

**Check it:** equip Moonlight Dagger and cast Blaze Shield on a group of
Porings. Off, SP only goes down. On, it ticks up by 3 on each pillar hit.

## Hylozoist Card on every pillar hit

Stock rAthena only rolls `bClassChange` on weapon attacks, so a Ninja
carrying Hylozoist Card never sees it from Blaze Shield. With this on, each
pillar hit rolls the card's rate and calls `c:polymorph()`, which picks from
the Dead Branch list and leaves bosses and status-immune monsters alone.

**Check it:** slot Hylozoist Card (`@item 4321`) and cast on Porings. About 1
pillar hit in 100 turns the Poring into something else.

## Pillars hold monsters

Stock pillars only deal damage on the server's 100 ms skill-unit timer, so a
monster fast enough to cross a cell between ticks skips it, and most pillars
in the ring never touch it. With this on:

- **Entry hit.** Stepping onto a pillar fires its hit right then, so no cell
  on the monster's path is skipped, whatever its speed.
- **Held in place.** After that hit the monster is held for the pillar's
  remaining burn time, takes the rest of its hits, and only then walks on to
  the next pillar.
- **Escape hatch.** Monsters under Endure, and boss/status-immune monsters,
  still take the entry hit but keep walking, as with Fire Wall.

This turns on the server extension `blaze_shield_knockback` (Flux159/rathena#21),
which ships with the app from 1.4.3. **Check it:** cast Blaze Shield in a
corridor and walk a Poring through. Off, it often crosses with one or two
hits. On, it stops on the first pillar, takes the full stack, then the next.

## Requires

App 1.4.3 or newer: the version that can switch Lua hooks and server
extensions on one at a time, and that has the `blaze_shield_knockback`
extension. How the options are built is in
[docs/MODDING.md → Several hooks in one mod](../../../docs/MODDING.md#several-hooks-in-one-mod-each-with-its-own-checkbox).
