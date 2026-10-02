'use strict';
// Ragnarok Offline's adapter for the database browser (#200).
//
// db-browser.html is generic: a grid, filters, staged edits and a review, for
// any database that can answer four calls. This file is the only part that
// knows where the database is. Another app supplies its own adapter with the
// same shape:
//
//   tables()                 -> { database, tables: [{ name, rows, engine, primaryKey: [..] }] }
//   describe(table)          -> { table, columns: [{ name, type, dataType, nullable, default,
//                                 autoIncrement, numeric, primary }], primaryKey: [..] }
//   rows(table, query)       -> { total, rows: [[cell, ..], ..] }   cells in column order
//        query: { filters: [{ column, op, value }], where, orderBy, desc, limit, offset }
//        op: = != < <= > >= contains starts ends null notnull
//   apply(changes)           -> { applied, backup }
//        changes: { table, key, set, old } | { table, insert } | { table, key, delete: true }
//
// A cell is null, a string, or { hex } for bytes that are not text. Numbers
// are strings, so a 64-bit id is never rounded.
//
// Here each call is a POST to the app, which runs `ragnarok-stack db <call>`
// (electron/db-bridge.js, stack/src/database.rs).

(function () {
	async function call(name, body) {
		const res = await fetch(`api/${name}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body || {}),
		});
		let answer;
		try { answer = await res.json(); } catch { answer = { error: `The app answered ${res.status}` }; }
		if (!res.ok || answer.error) throw new Error(answer.error || `The app answered ${res.status}`);
		return answer;
	}

	window.DbAdapter = {
		title: 'Database',
		tables: () => call('tables'),
		describe: table => call('describe', { table }),
		rows: (table, query) => call('rows', { table, ...query }),
		apply: changes => call('apply', { changes }),
		notes: {
			notRunning: 'The database is inside the game server. Press Play in Ragnarok Offline, then try again.',
			editWarning:
				'Changes are staged, not written, until you press Save. Saving stops the game for a few seconds and ' +
				'disconnects anyone playing, because rAthena keeps characters, inventories, pets and homunculi in memory ' +
				'and would write its own copy over yours. A backup of the whole database is taken first.\n\n' +
				'The server trusts what is in its tables. A value it does not expect (an item id that does not exist, a ' +
				'character on a map that is not loaded) can make it refuse the character or crash. Change what you understand, ' +
				'and keep the backup.',
			saveWarning: 'Saving stops the game for a few seconds; anyone playing is disconnected. A backup is taken first.',
			// Deleting a row here deletes that row and nothing else. rAthena's
			// own character delete (char_delete in src/char/char.cpp) also
			// clears a dozen other tables and leaves the party, guild and
			// marriage; none of that happens here.
			deleteWarnings: {
				char:
					'This deletes the character row only. Its items (inventory, cart_inventory), skills, hotkeys, ' +
					'quests, achievements, memos, variables (char_reg_num, char_reg_str), friends, mail, pets and ' +
					'homunculus stay behind as orphans, and its party, guild and marriage are not left. To remove a ' +
					'character cleanly, delete it from the character select screen in the game, or with Tools → Control panel.',
			},
		},
	};
})();
