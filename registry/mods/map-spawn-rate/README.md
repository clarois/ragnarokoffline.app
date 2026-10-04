# map-spawn-rate

Change how many monsters spawn on the maps you choose, and leave the rest of
the world stock.

Open **Settings → Mods → map-spawn-rate → Settings…**, search for a map by its
name (`prt_fild08`) or by a monster on it (`Poring`), and give it a rate:

| Rate | What it does |
|---|---|
| empty or 100% | stock |
| 200% | twice the monsters |
| 50% | half the monsters |

The window shows what spawns on each map and how many there will be at the
new rate. **Save and restart server** applies it.

## What changes and what does not

- Every spawn line on the map is scaled from what it asks for: a line of 40
  Porings at 150% becomes 60.
- **A line of a single monster stays single.** That covers bosses, MVPs and
  the one-off special monsters, so doubling a field does not double its boss.
  rAthena's own server-wide monster count works the same way.
- The rate multiplies with the server-wide monster count in **Settings →
  Rates**: 200% there and 150% here is three times stock on that map.
- The highest rate is 1000%.
- A map that is not in the list, such as one another mod adds, can still be
  given a rate: type its exact name in the filter and choose **Set a rate
  for "…"**.

## How it works

The server does the scaling, through the rAthena fork's
`map_mob_count_rate` extension, which this mod switches on in
`db/extension_db.yml`. At start-up, `npc/map_spawn_rate.txt` reads the rates
and calls `setmapmobcountrate "<map>",<rate>` for each map, and the server's
log says what it changed:

```
[Debug]: map-spawn-rate: prt_fild08 at 200% (5 spawn lines)
```

The settings window stores the rates as `map=percent` pairs, split across the
settings `rates_1` … `rates_10` because one setting holds 200 characters. That
is room for about 130 maps.

`settings/maps.json` is only the list the window shows. It is generated from
rAthena's spawn scripts by `registry/tools/map-spawn-rate/generate.py`.

## Requirements

An app whose pinned rAthena fork has the `map_mob_count_rate` extension. On an
older one, the mod's script cannot load, because `setmapmobcountrate` does not
exist there.
