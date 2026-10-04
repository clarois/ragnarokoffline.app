# custom-npc-sprite

An NPC drawn with a sprite of its own: **Ro the Guide**, north of Prontera's
fountain. The whole recipe is in [docs/MODDING.md](../../../docs/MODDING.md),
"A new NPC with its own sprite"; this is it working.

| File | What it does |
|---|---|
| `npc/guide.txt` | The NPC: map, cell, facing, name, and **19500** as its sprite |
| `System/jobname.lub` | Tells the client id 19500's sprite is `RO_GUIDE` |
| `data/sprite/npc/ro_guide.spr`, `.act` | The sprite, made from `art/ro_guide.png` |
| `art/ro_guide.png` | The source picture. Not read by the game |

Made with:

```
python3 scripts/mksprite.py examples/mods/custom-npc-sprite/art/ro_guide.png \
    --out examples/mods/custom-npc-sprite/data/sprite/npc/ro_guide
```

To make your own: copy this folder, rename it (and `name` in `mod.json`), draw
a PNG with a transparent background, run the line above on it, and change the
NPC's name, place and dialogue in `npc/guide.txt`. Keep 19500, or use any id
from 19000 to 19998, the same in both `npc/guide.txt` and `System/jobname.lub`.
