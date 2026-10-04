# prontera-vendors

A living player market on Prontera's main road, for a world with few or no
other players. Fake players run vending stalls on the inner sidewalks and
buying stores on the outer ones. They price things like a real server's
market, undercut each other, sell out, pack up and make room for others, so
the street keeps changing while you play.

Every vendor is a population-engine shell: a real character with a real
MC_VENDING stall or buying store, not an NPC dressed as one. You click it,
browse and trade exactly as you would with a player.

## What it needs

- **The population engine switched on:** Settings → Population → Fake
  players. Its vending economy (`population_engine_vending_enable`) must be
  on, which is the default.
- **App 1.4.5 or later.** The mod uses mod vendor markets, buying stores, the
  `population_vendor_*` script commands and `@vendorinfo` from that build. On
  an older build no stall appears, and the server log names what it doesn't
  know.

## Where

| Sidewalk | What stands there |
|---|---|
| Inner, x=147 and x=164 (y=136–173, and y=52–111) | Sell stalls |
| Outer, x=140 and x=171 (y=136–172) | Buying stores |
| West of the fountain, rows y=110 and y=125 (x=104–135) | Buying stores |

The engine's own Prontera vendors keep spawning exactly as they would
without the mod; these are extra.

## Settings (Settings → Mods)

| Setting | Default | What it does |
|---|---|---|
| Sell shops | on | Off removes every sell stall. |
| Sell stalls | 20 | How many sell stalls stand on the inner sidewalks. |
| Buy shops | on | Off removes every buying store. |
| Buy stalls | 20 | How many buying stores stand on the outer sidewalks. |
| Minutes before a stall changes | 240 | How long a vendor stays before packing up. Each varies by up to half either way, and stalls are checked once a minute, so short values run long (2 means roughly 1–5 minutes). 0 keeps them until the server restarts. |
| Price level (%) | 100 | Every price × this / 100, for sell stalls and buyers alike. Nothing goes below what an NPC pays. |
| Vendors respect the population limit | on | Off: stalls spawn even when the fake-player limit is reached (they still count toward it). |
| Vendors shout their wares | on | Stalls call out a real item and price now and then ("S> Elunium 13K", "B> Oridecon 9500"). |
| Seconds between a stall's shouts | 180 | Average per stall (each waits ½× to 1½×); no two stalls shout within 6 seconds of each other. |

Settings take effect when the server starts.

## Sell stalls

115 themes. Each time a spot gets a stall (at server start, after a rotation
or after a sell-out) it rolls a theme, so over a session the whole range
comes through:

- **Staples, always up:** general goods, potions, forge supplies, healing
  items, common cards and rare cards (at least one each, at most two).
- **Goods:** slim potions, gemstones, Ygg/Ori/Elu, skill supplies, ammo,
  magic scrolls, dyes, taming items, elemental converters, Undershirt +
  Pantie, Bloody Branches, OBB/OPB, OCA/MCA.
- **Cards:** besides the two staples, binders by slot (weapon, armor,
  headgear, garment and shoes, shield, accessory) and a cheap-cards stall.
  Never MVP cards. Card stalls are twice as likely as other themes.
- **By class:** Knight, Crusader, Wizard, Sage, Hunter, Bard/Dancer, Priest,
  Monk, Assassin, Rogue, Blacksmith, Alchemist, Taekwon/SG/SL, Ninja,
  Gunslinger, Super Novice, Doram: gear that class wears and few others can.
- **By weapon type:** daggers, swords, two-handers, spears, axes, maces,
  staves, bows, books, knuckles, instruments and whips, guns, huuma.
- **By armor slot:** garments, footgear, shields, body armor, slotted gear,
  headgear, accessories, costumes.
- **Pets:** pet eggs with incubators and food, and pet equipment. An egg
  bought from a stall arrives as a real, hatchable egg: the server creates
  it for you at the moment you buy it.
- **Specials:** starter gear, low- and mid-level weapons, katars, elemental
  daggers (forged Fire/Water/Earth/Wind, some "Very Strong"), crimson
  weapons, shadow gear, a stall that sells nothing but an Ice Pick, rare
  collectibles, a "hunter's haul" of popular drops.
- **Refined:** weapons from their safe limit to three past it, armor +4 to
  +7, priced by what it costs to make, including failed attempts past the
  safe limit.
- **Loot:** one stall per dungeon (Byalan, Geffenia, Kiel, Payon Cave, Orc
  Dungeon, Ant Hell, Sphinx, Pyramids, Sunken Ship, Clock Tower, Glast Heim,
  Turtle Island, Toy Factory, Niflheim, Magma, Ice Cave, Abyss Lake,
  Thanatos, Odin, Juperos, Bio Lab, Comodo, Amatsu, the Culverts, the Guild
  Dungeon), loot by monster level (1–20 up to 81–99), mini-boss loot and MVP
  items. Each loot stall skips what dozens of monsters drop, so it shows its
  own place.
- **Random:** five stalls that each sample a broad pool: monster loot,
  consumables, equipment, cheap junk ("Cart Clearance") and a mixed bag.

Every other theme stands at most once at a time. Shop signs mix theme names
with the vague titles real stalls use ("Stuff", "SALE", "Happy hunting!",
"..."), taken from a sample of 500 iRO shops, and two stalls never show the
same sign (a repeat gets a number: "ores n more 2").

A stall that sells out packs up within a minute, as a player would, and
another takes the spot.

## Buying stores

17 themes. As on any real server, the common materials always have buyers:

- **Always there:** two buyers of upgrade ores (Elunium, Oridecon, Rough
  Elunium, Rough Oridecon, Emveretarcon), and one each for crafting
  materials (Steel, Iron, Iron Ore, Coal, Star Crumb), elemental stones and
  converters, herbs (Green, Red, Yellow, White, Blue) and alchemy materials
  (Empty Bottle, Poison Spore, Medicine Bowl, Detrimindexta,
  Karvodailnirol and more).
- **The rest rotate:** common and rare cards, OCA/MCA/OBB/OPB and branches,
  Ygg items, potions, other consumables, gemstones, popular quest
  materials, loot by monster level (three bands), and a random buyer.

- A store wants 2–5 kinds of item (rAthena's limit) and only items rAthena
  allows in buying stores, so never equipment.
- It pays 60–85 % of the low end of the item's sell price, never less than
  an NPC pays.
- It wants lots of cheap loot and a few of anything valuable.
- It packs up when it has bought everything or spent its zeny.
- Anyone can open a buying store, so buyers wear any class's sprite and gear.

## Prices

Prices follow kRO's player market, which is cheaper and steadier than old
iRO's (Elunium ~13k rather than ~263k) and suits a solo world better. Where
each price comes from, in order:

1. **kro:** the 90-day median asking price on kRO's official servers, from
   RagMAYA (ragmaya.kr), where at least 3 listings back it.
2. **ragnastats:** iRO's average from ragnastats.com, converted to kRO's
   scale with a factor per kind of item, learned from items both price.
3. **npc:** an NPC's price, for gear an NPC sells. A stall never asks more
   than an NPC does for the same item.
4. **sibling:** a same-named item's price (Knife → Knife [3]).
5. **estimate:** a model's ballpark from what the item is, which monsters
   drop it, how rarely, and its level and stats. Typically within ×2.5
   either way, so worth checking.

Items none of these can price have no price and are never sold.

Each item has a `[min, max]` range, and every stall rolls inside it. Half the
time an item is listed 1–5 % under the cheapest rival stall on the map, but
never below its range. Nothing goes below what an NPC pays for it, so
nothing can be flipped for profit, except the rare "fat-finger": 1 in 5000
per item, a price with a digit missing.

### Changing prices

`db/population_vendor_prices/prontera-vendors.csv` is the price list: one row
per tradeable item, `Id,Name,Min,Max,Source`. Open it in Excel or any
editor, change what you like and restart the server; it wins over the prices
in the YAML, for sell stalls and buyers. The Id decides; the Name is there to
find things, and `;` works as the separator too. `0,0` means "no price yet".

Refined, forged and carded lines keep the price in `population_vendors.yml`,
since a +9 isn't priced like a plain one. The file only prices this mod's
vendors.

## For GMs

- `@vendorinfo` lists every mod stall on your map: owner, place, theme, sign,
  item count and minutes to rotation.
- `@vendorinfo <theme or market>` shows a theme's stock and price ranges, or a
  market's themes and how many of each are up. The last part of a key is
  enough: `@vendorinfo byalan`, `@vendorinfo refine`, `@vendorinfo sidewalks`.

## Pre-renewal

A pre-renewal server gets its own set from `pre-re/db/` (`"prerenewalFolder"`
in mod.json lays it over `db/`): the same themes where the items exist,
without the renewal-only ones (costumes, shadow gear, Doram), with its own
price list.

## How it's built

`db/population_vendors.yml`, `db/population_vendor_pop.yml`, the price list
and the pre-renewal set are **generated** from rAthena's item, monster, pet
and spawn databases and two price caches. The tools live outside the mod in
[`registry/tools/prontera-vendors/`](../../tools/prontera-vendors/), so
players don't download them:

```
python3 registry/tools/prontera-vendors/build_vendors.py                   # rebuild from the caches
python3 registry/tools/prontera-vendors/build_vendors.py --era pre-re      # the pre-renewal set
python3 registry/tools/prontera-vendors/build_vendors.py --refresh-prices  # fetch iRO prices the cache lacks
python3 registry/tools/prontera-vendors/build_vendors.py --reprice         # rebuild the price list from the data
python3 registry/tools/prontera-vendors/scrape_ragmaya.py --workers 12     # refresh kRO prices (resumable)
```

Themes are defined at the top of `build_vendors.py`: a hand list, a rule over
the item database, or "what these dungeons' monsters drop". A re-run keeps
rows of the price list you changed by hand (marked `manual`); everything else
follows the data. The YAML can be edited by hand for a quick test, but a
re-run overwrites it.

How the YAML works:

- **The first two entries are the markets.** Each has `Spawns` (map, areas,
  Count) and `Themes` (each with `Weight`, `Min`, `Max`).
- **The settings override some of it.** The Sell stalls and Buy stalls
  settings replace each market's Count.
- **Each theme is a `Type: Pool` vendor.** Its fields are `PickCount`,
  `MaxSlots`, `TitleFromPool` (`{name}` is the vendor's name), rotation,
  `PriceMistakeOneIn`, `Undercut` and `Callouts`. Buyers have
  `Buying: true`.
- **Each Pool line** has `Amount` and `Price: [min, max]`, and optionally
  `Refine`, `Element`, `Stars` and `Cards`.

## Known gaps

- Vendors use the engine's generated names, not player-style handles.
- When a stall rotates or sells out, a new vendor takes the spot rather than
  the same one restocking.

## Files

```
registry/mods/prontera-vendors/
├── mod.json                         settings
├── README.md
├── images/                          icon and screenshot
├── npc/
│   ├── prontera-vendors.txt         hands the settings to the engine
│   └── prontera-vendors-newer.txt   the settings that need app 1.4.5
├── db/
│   ├── population_vendors.yml       markets + themes (generated)
│   ├── population_vendor_pop.yml    one vendor profile per theme (generated)
│   └── population_vendor_prices/
│       └── prontera-vendors.csv     the price list; edit freely
└── pre-re/db/                       the pre-renewal set, same layout

registry/tools/prontera-vendors/     the generator, kept out of the mod
├── build_vendors.py
├── estimate.py                      the estimate model
├── scrape_ragmaya.py                kRO price fetcher
├── prices_kro.json                  kRO price cache (RagMAYA)
├── prices.json                      iRO price cache (ragnastats)
└── table_generated*.json            what it last wrote, to spot hand edits
```
