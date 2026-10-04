# gm-class-look

Draws GM accounts as their class: the job's outfit, costumes, body styles and
hairstyle, instead of the GM suit. Ships with the app, **off**. Turn it on in
**Settings → Mods → gm-class-look**.

The built-in `ragnarok` account is a GM, so this is the mod for playing on it
and still seeing your Knight look like a Knight.

## What it changes

Only how GMs look in your game window. GM commands come from the server and
are unchanged.

| Setting | Default | Off means |
|---|---|---|
| Keep the GM name style | on | A GM's name shows like anyone else's |
| Keep GM-styled chat | on | What a GM says shows like anyone else's chat |

With both off, nothing on screen tells a GM apart from another player.

## How it works

The client keeps a list of GM accounts (`adminList` in its config) and draws
them in the GM sprite. The mod calls `api.players.gmLook({ sprite, name,
chat })`, which turns each part of that look off or on for characters drawn
from then on. See [docs/MODDING.md](../../docs/MODDING.md).
