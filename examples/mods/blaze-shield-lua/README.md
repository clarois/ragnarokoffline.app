# blaze-shield-lua

Blaze Shield — the Ninja's ring of fire pillars — honours HP/SP drain
bonuses and Hylozoist Card on every pillar hit.

Stock rAthena applies both to weapon attacks only, so a Ninja channelling
Blaze Shield with a Moonlight Dagger or a Hylozoist Card never sees either.
Fixing that used to be two changes to the server's C++
([rathena#5](https://github.com/Flux159/rathena/pull/5),
[rathena#6](https://github.com/Flux159/rathena/pull/6)). Here it is one
`on_hit` hook, in [`lua/blaze_shield.lua`](lua/blaze_shield.lua).

**Look at first:** the `on_hit` function. `c:drain()` and `c:polymorph()`
are actions the server applies after the hit lands; `c.caster.classchange`
is the card's bonus, read off the player.

The three settings under **Settings → Mods** switch each half on or off, and
`log_hits` writes every hit to the map server's log, which is how to see it
working. From the test run (a level-10 Ninja with `bSPDrainValue,5` — SP climbs
by 5 a pillar):

```
[Info]: Lua: blaze-shield-lua: AgentOne hit Poring for 13 SP 7 classchange 4000
[Info]: Lua: blaze-shield-lua: AgentOne hit Poring for 13 SP 12 classchange 4000
```

See [docs/MODDING.md → lua/](../../docs/MODDING.md#lua--changing-how-a-skill-works)
for the hooks, what `c` holds, and what needs a server change instead.
