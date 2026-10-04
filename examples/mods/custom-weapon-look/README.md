# custom-weapon-look

A dagger with a look of its own: the **Jade Dagger** (`@item 50101`), drawn
for every class as the stock dagger recoloured green, with the dagger's attack
motions. The recipe is in [docs/MODDING.md](../../../docs/MODDING.md), "A new
weapon look".

| File | What it does |
|---|---|
| `db/item_db.yml` | The item, 50101. **No `View:`**, so the client takes the look from `ClassNum` |
| `System/itemInfo.lua` | Its name and description, and `ClassNum = 5001`: the look |
| `System/weapontable.lub` | Look 5001 is drawn as `_jade` and attacks like a dagger |
| `data/sprite/human/…/<class>_<sex>_jade.spr`, `.act` | The sprites. **Not in this repository**: make them, below |

## Make the sprites

The sprites are your client's own dagger sprites, recoloured, so they are made
from your copy and not shipped here. With the game running:

```
python3 scripts/mkweapon.py --type shortsword --name jade --look 5001 \
    --hue 150 --saturation 1.3 --mod examples/mods/custom-weapon-look
```

That writes one sprite pair per class and sex your client has a dagger for
(52 with the iRO 2026-09 data) and System/weapontable.lub. Then install the
folder as a mod, restart the server, and `@item 50101`.
