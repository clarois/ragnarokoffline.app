# bounty-hunt

Attention: This mods adds the **Bounty Marker** item, but it does NOT spawn it in any way.
That is up to whoever wants to use it on their server!

Use a **Bounty Marker**, the cursor turns into the target picker, and you click
a monster. A dialog lists that monster's drops with the kills each would take;
pick one. From then on, every kill of that monster counts up, and once you hit
the goal the drop you chose is handed to you — guaranteed. The bounty then
clears completely; to start another hunt you use a fresh Bounty Marker.

**Lucky drops refresh the counter.** If the hunted item drops naturally from
the target *on a kill you dealt yourself*, the bounty stays active but progress
resets to 0 — you already got one for free, so the grind starts fresh. The
guaranteed payout is still there at the end of the new count. Party mates,
mercs, and homun stealing the kill do not trigger the refresh; the check is
strictly your own killing blow.

Your bounty and its progress are saved on your character and survive a server
restart.

**The goal scales with rarity.** A common drop is a handful of kills; a 0.02%
card is 6000 (the default cap). The tuning lives in Settings (below).

This is the worked example for the **target-picker Client API** (`api.targeting`
and `api.server`). It is the one mod here that spans every layer at once — a
`db/` item, a `System/` name, a `client/` plugin and an `npc/` script — because
the feature genuinely needs all four.

## How it works, layer by layer

The interesting part is the seam: *clicking a monster* is a client thing, while
*counting kills and forcing a drop* is a server thing, and they have to agree.

| Step | Layer | What happens |
|---|---|---|
| You use a Bounty Marker | `db/item_db.yml` | A plain `Usable` item (id 50071). Using it is consumed like any potion. |
| The cursor becomes the target picker | `client/index.js` | The plugin hears the app's `item:use` event, and for our item calls `api.targeting.pick()` — the same native target cursor taming items raise. |
| You click a monster | `client/index.js` | `pick()` resolves with the monster's **class id**; the plugin sends `@bounty <id>`. |
| A dialog lists the drops; you choose | `npc/bounty.txt` | `@bounty` (bound with `bindatcmd`) reads the drops with `getmobdrops`, works out each one's kill goal from its rate, and shows them with `select()`; your choice is stored in permanent character variables. |
| Each kill counts; the drop is granted | `npc/bounty.txt` | `OnNPCKillEvent` fires on every kill; when `killedrid` is your target it counts up, and at the goal `getitem` hands you the drop and the bounty clears — a fresh Bounty Marker starts the next hunt. |
| The hunted item drops naturally on your own kill | `npc/bounty.txt` + `db/extension_db.yml` | `OnPCDropItemEvent` fires per rolled drop — `killeddropid` names the item and `killedbyme` says whether *you* struck the killing blow. When both match, we flip a flag and the imminent `OnNPCKillEvent` refreshes the counter instead of incrementing it. The event is a rAthena feature (`pc_drop_item_event`) the mod turns on through its own `db/extension_db.yml`. |

The client never decides anything the server should: the drop list and the kill
goal come from the server's own `mob_db`, and the counter and reward are pure
rAthena script. The plugin only carries *which monster you clicked* across the
gap.

**Persistence.** `bh_target`, `bh_item`, `bh_goal`, `bh_progress` and `bh_lucky`
have no prefix, so they are permanent character variables — written to
`char_reg_num` and restored on login. Kill five Porings, restart the server,
and you are still at 5 of the goal. `bh_lucky` is the flag `OnPCDropItemEvent`
sets and `OnNPCKillEvent` clears within the same mob death.

## Checking and setting a bounty in game

- `@bounty` on its own **shows the active bounty** — the target, the item, and
  `kills done / needed (remaining)`.
- `@bounty <mob id>` **sets** one (this is what the client plugin sends after a
  click; typing it yourself is also how you test the server side without the
  client plugin).

## How the kill goal is calculated

```
goal = rate_scale / drop_rate      (drop_rate is in 0.01% units, so 0.02% = 2)
goal = clamp(goal, min_kills, max_kills)
```

At the defaults (`rate_scale` 12000, `min_kills` 10, `max_kills` 6000):

| drop rate | goal |
|---|---|
| 0.02% (card) | 6000 (capped) |
| 1% | 120 |
| 5% | 24 |
| 50%+ | 10 (floored) |

So rarity drives the grind, with a hard floor and ceiling so nothing is trivial
or impossible.

## Getting a Bounty Marker

Buy one from **Bounty Broker** in Prontera (`prontera 152 187`, 2000z), or give
yourself one with `@item Bounty_Marker`.

## Settings

**Settings → Mods → bounty-hunt** exposes three numbers, all read through
`F_ModSetting` on each server start (so **Apply** takes effect on the next
restart):

- **Rarity scale** (`rate_scale`, default 12000) — the numerator in the formula
  above. Bigger = more kills across the board.
- **Minimum kills** (`min_kills`, default 10) — the floor. Set it equal to
  **Maximum kills** for a flat, rate-independent count.
- **Maximum kills** (`max_kills`, default 6000) — the cap for the rarest drops.

## Requirements

`requires.app` is **`>=1.3.8`**. The click-to-select flow depends on the
`api.targeting` / `api.server` capabilities in the Client API, which the plugin
**feature-detects** — so on an app built without them the mod still loads and the
**server** half works (the Bounty Broker, the `@bounty` command, the scaling and
the counter); you just type `@bounty <mob id>` by hand instead of clicking, and
using the item raises no cursor. Those capabilities are compiled into the
roBrowser bundle, so the cursor appears only on an app built with `patches/client`.

**Server-side extension.** The lucky-drop refresh relies on the
`pc_drop_item_event` server extension (rAthena fork `mob-drop-item-event`
branch). The mod ships `db/extension_db.yml` that enables it — no extra setup
is needed if the server was built with the extensions framework. On a build
without the extension registered, `OnPCDropItemEvent` never fires and the
refresh is silently absent; the rest of the mod (counter, payout, one-shot
clear) still works.

## Installing

Copy this folder into your mods directory and restart the app (it has a
`client/` and a `System/` layer, so a server-only restart is not enough):

    macOS    ~/Library/Application Support/Ragnarok Offline/state/mods/
    Windows  %APPDATA%\Ragnarok Offline\state\mods\
    Linux    ~/.local/share/Ragnarok Offline/state/mods/

Then enable it under **Settings → Mods** (it ships off by default).

## Checking it loaded

- The supervisor prints `mods: bounty-hunt` (among others) on start. If it is
  not there, look for a refusal line instead.
- The map-server log's NPC count goes up by two (the Broker and the control
  NPC). A parse error names the file and line.
- In game: `@bounty 1002` should open the drop picker for Poring even without
  using the item — that isolates the server side from the client plugin.

## What to look at first

`npc/bounty.txt` is the whole feature in one screen: the `bindatcmd`, the
`getmobdrops` menu with its rate-scaled goals, and the `OnNPCKillEvent` counter
with its guaranteed `getitem` and the one-shot clear that follows it.
`client/index.js` is the ten lines that turn "used the item" into "clicked a
monster". Everything else is the item's stats (`db/`) and its name and icon
(`System/`).
