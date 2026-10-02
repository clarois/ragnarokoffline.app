// bounty-hunt (client) -- turn "use the Bounty Marker" into "click a monster".
//
// Using the item makes the client send its use-item packet; the app's Client
// API turns that into an `item:use` event. For our item we raise the native
// target cursor (api.targeting.pick -- the same selection taming items use) and,
// when the player clicks a monster, hand its class id to the server with an
// @bounty command, which npc/bounty.txt answers with the drop picker.
//
// Everything the player sees is server-driven: the drop list and the kill
// counter live in the NPC script, so this file only carries the click across.
// On an app too old to have the picker it bows out, and the server side (the
// Bounty Broker and the @bounty command) still works on its own.

const BOUNTY_MARKER_ID = 50071;

export default function init(parameters, api) {
	if (!api || typeof api.on !== 'function' ||
		typeof api.targeting?.pick !== 'function' ||
		typeof api.server?.command !== 'function') {
		// This app predates the target picker; nothing to hook. Returning false
		// reports the plugin as inactive rather than pretending it loaded.
		return false;
	}

	// One selection at a time: ignore further uses while a pick is open, so
	// spamming the item cannot stack cursors or fire stray @bounty commands.
	let picking = false;
	api.on('item:use', async ({ itemId }) => {
		if (itemId !== BOUNTY_MARKER_ID || picking) return;
		picking = true;
		try {
			const monster = await api.targeting.pick({ label: 'Bounty: click a monster' });
			if (monster && Number.isInteger(monster.classId) && monster.classId > 0) {
				api.server.command('@bounty ' + monster.classId);
			}
		} catch (error) {
			// A failed pick must never wedge the next one.
			console.error('[bounty-hunt]', error);
		} finally {
			picking = false;
		}
	});
	// api.on unsubscribes itself when the plugin is disposed, so there is
	// nothing else to clean up here.
}
