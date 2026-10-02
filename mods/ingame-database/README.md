# ingame-database

An in-game database window: search any item or monster without leaving the
game. Items show their description and icon; monsters show their stats and
drops, and a drop opens that item. Mods' items and monsters are included,
because it reads the same tables the game does.

Open it with the **DB** button or **Alt+D**. Off until you switch it on in
Settings → Mods.

It is also the worked example of two client API features:

- **A window of the plugin's own:** `api.ui.window({ id, title, width, height })`
  returns a frame in the game's style whose `body` the plugin fills.
- **Asking the server:** `api.server.request('moddb', 'mob Poring')` sends
  `@moddb <id> mob Poring`; [`npc/moddb.txt`](npc/moddb.txt) answers with one
  `@@reply` line through `dispbottom`, and the plugin gets its text.

See docs/MODDING.md, "Windows and server requests".
