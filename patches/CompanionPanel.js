/**
 * UI/Components/CompanionPanel/CompanionPanel.js
 *
 * Companion management window.
 *
 * This is a real roBrowser GUIComponent, so it behaves like every other window
 * in the client: it is in the UIManager list, it is draggable by its title bar,
 * it remembers its position, and the game below it does not receive clicks that
 * land on it.
 *
 * Every button here sends the SAME packet the player would send by typing the
 * command into chat (see MapEngine's onRequestTalk): this is a keyboard
 * replacement, not a second command system. The server side is unchanged - it
 * cannot tell a button from a keystroke, which is the point.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Preferences from 'Core/Preferences.js';
import Renderer from 'Renderer/Renderer.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import htmlText from './CompanionPanel.html?raw';
import cssText from './CompanionPanel.css?raw';
import 'UI/Elements/Elements.js';

const CompanionPanel = new GUIComponent('CompanionPanel', cssText);

CompanionPanel.render = () => htmlText;

/// Preferences: window position and the saved squads, per browser.
const _preferences = Preferences.get(
	'CompanionPanel',
	{
		x: 300,
		y: 120,
		// User-chosen size. 0 means "follow the content", which is the default:
		// the window is as wide as the widest tab needs, so nothing is cropped.
		width: 0,
		height: 0,
		squads: {}
	},
	1.0
);

/// The roster as last received from the server, parsed from @companion list raw.
let _roster = [];
/// Rows of the batch currently arriving; swapped into _roster at @CPEND so a
/// partial read never shows a half-built list.
let _pending = [];
/// Set when a redraw is wanted even if the data is unchanged (a manual Refresh).
let _forceRedraw = false;
/// Our own duty choices, so a row can show the badge before the server echoes.
const _duties = {};

/**
 * Jobs the Summon tab offers: the same names @companion jobs prints and the
 * engine's kJobNameMap resolves. Kept as plain data so the panel needs no
 * server round-trip to draw the list.
 */
const JOB_TIERS = [
	['1st', ['Swordsman', 'Mage', 'Archer', 'Acolyte', 'Merchant', 'Thief']],
	['2nd', ['Knight', 'Priest', 'Wizard', 'Blacksmith', 'Hunter', 'Assassin',
		'Crusader', 'Monk', 'Sage', 'Rogue', 'Alchemist', 'Bard', 'Dancer']],
	['Trans', ['LordKnight', 'HighPriest', 'HighWizard', 'Whitesmith', 'Sniper',
		'AssassinCross', 'Paladin', 'Champion', 'Professor', 'Stalker',
		'Creator', 'Clown', 'Gypsy']],
	['3rd', ['RuneKnight', 'Warlock', 'Ranger', 'ArchBishop', 'Mechanic',
		'GuillotineCross', 'RoyalGuard', 'Sorcerer', 'Minstrel', 'Wanderer',
		'Sura', 'Genetic', 'ShadowChaser']],
	['4th', ['DragonKnight', 'Meister', 'ShadowCross', 'ArchMage', 'Cardinal',
		'Windhawk', 'ImperialGuard', 'Biolo', 'AbyssChaser', 'ElementalMaster',
		'Inquisitor', 'Troubadour', 'Trouvere', 'SkyEmperor', 'SoulAscetic',
		'Shinkiro', 'Shiranui', 'NightWatch', 'HyperNovice', 'SpiritHandler']]
];

/**
 * Send a chat line exactly as typing it would.
 *
 * @param {string} text
 * @param {boolean} party - true = party channel (the channel the stance and
 *                           duty orders are read from), false = public (the
 *                           channel at-commands like @companion summon use)
 */
function talk(text, party) {
	ChatBox.onRequestTalk('', text, party ? ChatBox.TYPE.PARTY : ChatBox.TYPE.PUBLIC);
}

/**
 * Ask the server for the roster in its machine-readable form.
 * Answered through onChatMessage as @CP|... lines.
 */
/// When the last roster request went out, so a press with no answer can be told
/// apart from a press that was never wired up.
let _rosterRequestedAt = 0;
let _rosterLastCount = -1;

function refreshRoster() {
	_rosterRequestedAt = Date.now();
	_pending = [];
	// A manual refresh must visibly do something even when nothing changed.
	_forceRedraw = true;
	_renderStatus('asking the server…');
	talk('@companion list raw', false);
}

/// Put a one-line status under the Party tab heading, so pressing Refresh always
/// changes something on screen even when the list itself is unchanged.
function _renderStatus(text) {
	const page = _page('party');
	if (!page) return;
	let el = page.querySelector('.roster-status');
	if (!el) {
		el = document.createElement('div');
		el.className = 'roster-status hint';
		page.append(el);
	}
	el.textContent = text;
}

/**
 * Parse one @CP line. Format (see population_engine_companion_list_raw):
 *   @CP|name|job|base_level|active|favorite|live_level
 *   @CPEND|count
 *
 * @param {string} text
 * @return {boolean} true when the line was ours
 */
function parseRosterLine(text) {
	const idx = text.indexOf('@CP');
	if (idx < 0) {
		return false;
	}
	const body = text.slice(idx);
	if (body.startsWith('@CPEND')) {
		// The server sends these unsolicited when the roster changes, and in answer
		// to our own request. Either way this batch is authoritative: replace what
		// we had. Redraw only when something differs, so a push that changes
		// nothing does not churn the DOM or reset scroll position.
		const fresh = _pending.slice();
		const changed = fresh.length !== _roster.length ||
			fresh.some((m, i) => !_roster[i] ||
				m.name !== _roster[i].name || m.job !== _roster[i].job ||
				m.level !== _roster[i].level || m.active !== _roster[i].active ||
				m.liveLevel !== _roster[i].liveLevel);
		_roster = fresh;
		_pending = [];
		const age = _rosterRequestedAt ? Math.round((Date.now() - _rosterRequestedAt) / 1000) : 0;
		_renderStatus(`${_roster.length} companion${_roster.length === 1 ? '' : 's'}` +
			(_rosterRequestedAt ? ` — updated ${age}s ago` : ' — pushed by the server'));
		if (changed || _forceRedraw) {
			_forceRedraw = false;
			_render();
		}
		return true;
	}
	if (body.startsWith('@CPFAIL')) {
		_roster = [];
		_pending = [];
		_renderStatus('the server could not read the list (see map-server console)');
		_forceRedraw = false;
		_render();
		return true;
	}
	const parts = body.split('|');
	if (parts[0] !== '@CP' || parts.length < 7) {
		return false;
	}
	_pending.push({
		name: parts[1],
		job: parts[2],
		level: parseInt(parts[3], 10) || 0,
		active: parts[4] === '1',
		favorite: parts[5] === '1',
		liveLevel: parseInt(parts[6], 10) || 0
	});
	return true;
}

let _raf = 0;

function _render() {
	if (_raf) {
		return;
	}
	_raf = window.requestAnimationFrame(() => {
		_raf = 0;
		if (!CompanionPanel.__active) {
			return;
		}
		_drawParty();
		_drawSummon();
		_drawBattle();
		_drawGear();
	});
}

function _page(name) {
	return CompanionPanel.getRoot().querySelector(`.page[data-page="${name}"]`);
}

function _button(label, className, handler, title) {
	const b = document.createElement('button');
	b.className = className;
	b.textContent = label;
	if (title) {
		b.title = title;
	}
	b.addEventListener('mousedown', e => e.stopImmediatePropagation());
	b.addEventListener('click', e => {
		e.stopPropagation();
		handler();
	});
	return b;
}

function _row(...children) {
	const row = document.createElement('div');
	row.className = 'row';
	children.forEach(c => row.append(c));
	return row;
}

function _drawParty() {
	const page = _page('party');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const head = document.createElement('h4');
	head.textContent = `Saved companions (${_roster.length})`;
	page.append(head);

	if (!_roster.length) {
		const e = document.createElement('div');
		e.className = 'empty';
		e.textContent = 'None yet. Recruit in game, or draft one on the Summon tab.';
		page.append(e);
		page.append(_button('Refresh', 'b wide', refreshRoster));
		return;
	}

	_roster.forEach(m => {
		const nm = document.createElement('span');
		nm.className = 'nm';
		nm.textContent = (m.favorite ? '★ ' : '') + m.name;
		nm.title = `${m.name} — ${m.job}`;

		const lv = document.createElement('span');
		lv.className = 'lv';
		lv.textContent = `Lv.${m.liveLevel || m.level}`;

		const badge = document.createElement('span');
		badge.className = `badge ${_duties[m.name] || (m.active ? 'on' : '')}`;
		badge.textContent = _duties[m.name] || (m.active ? 'ON' : 'OFF');
		badge.title = m.active ? 'Summoned' : 'Not summoned';

		const duty = _button('Duty', 'b', () => {
			// none -> attacker -> tank -> support -> none, sent as party chat
			const order = [null, 'attacker', 'tank', 'support'];
			const next = order[(order.indexOf(_duties[m.name] || null) + 1) % order.length];
			if (next) {
				_duties[m.name] = next;
				talk(`${m.name} ${next}`, true);
			} else {
				delete _duties[m.name];
			}
			_render();
		}, 'Set this companion\'s duty in battle');

		const summon = _button(m.active ? 'Bench' : 'Summon', 'b', () => {
			if (m.active) {
				talk(`@companion dismiss ${m.name}`, false);
			} else {
				talk(`@companion summon ${m.name}`, false);
			}
			window.setTimeout(refreshRoster, 600);
		}, m.active ? 'Send back to the saved list' : 'Summon into the party');

		const fav = _button(m.favorite ? '★' : '☆', 'b', () => {
			talk(`@companion ${m.favorite ? 'unfavorite' : 'favorite'} ${m.name}`, false);
			window.setTimeout(refreshRoster, 600);
		}, 'Favorite (sorts first)');

		// Delete is permanent - it removes the saved row, not just the party slot -
		// so it asks first, in-window.
		const trash = _button('🗑', 'b danger', () => {
			confirmInWindow(
				`Delete ${m.name} permanently?`,
				'The saved companion, its level and its equipment are removed for good. This cannot be undone.'
			).then(ok => {
				if (!ok) return;
				talk(`@companion remove ${m.name}`, false);
				window.setTimeout(refreshRoster, 600);
			});
		}, 'Delete this saved companion permanently');

		page.append(_row(nm, lv, badge, duty, summon, fav, trash));
	});

	page.append(_button('Refresh', 'b wide', refreshRoster));
}

function _drawSummon() {
	const page = _page('summon');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Draft a new companion of any job. It joins your party at once.';
	page.append(hint);

	JOB_TIERS.forEach(([tier, jobs]) => {
		const h = document.createElement('h4');
		h.textContent = tier;
		page.append(h);

		const wrap = document.createElement('div');
		wrap.className = 'jobs';
		jobs.forEach(job => {
			wrap.append(_button(
				job.replace(/([a-z])([A-Z])/g, '$1 $2'),
				'',
				() => {
					talk(`@companion draft ${job}`, false);
					window.setTimeout(refreshRoster, 900);
				},
				`Draft a ${job}`
			));
		});
		page.append(wrap);
	});
}

function _drawBattle() {
	const page = _page('battle');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const h = document.createElement('h4');
	h.textContent = 'Stance (whole party)';
	page.append(h);

	const stances = [
		['attack', 'Free', 'Engage on sight near you'],
		['defensive', 'Standard', 'Fight what you fight'],
		['passive', 'Hold', 'Never start a fight']
	];
	const grid = document.createElement('div');
	grid.className = 'grid';
	stances.forEach(([cmd, label, tip]) => {
		grid.append(_button(label, 'b wide', () => talk(cmd, true), tip));
	});
	page.append(grid);

	const h2 = document.createElement('h4');
	h2.textContent = 'Orders';
	page.append(h2);
	const orders = document.createElement('div');
	orders.className = 'grid';
	orders.append(
		_button('Taunt / Pull', 'b wide', () => talk('taunt', true), 'Your defender grabs your target'),
		_button('Recall', 'b wide', () => talk('recall', true), 'Teleport every companion to you')
	);
	page.append(orders);

	const h3 = document.createElement('h4');
	h3.textContent = 'Healer thresholds';
	page.append(h3);
	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Support companions heal below these HP levels.';
	page.append(hint);

	const normal = document.createElement('input');
	normal.className = 'num';
	normal.type = 'number';
	normal.min = 1;
	normal.max = 99;
	normal.value = '75';
	const emergency = document.createElement('input');
	emergency.className = 'num';
	emergency.type = 'number';
	emergency.min = 1;
	emergency.max = 99;
	emergency.value = '35';

	page.append(_row(
		(() => {
			const s = document.createElement('span');
			s.className = 'nm';
			s.textContent = 'Heal below';
			return s;
		})(),
		normal,
		(() => {
			const s = document.createElement('span');
			s.className = 'lv';
			s.textContent = '% / emergency';
			return s;
		})(),
		emergency,
		_button('Set', 'b', () => {
			const a = Math.max(1, Math.min(99, Number(normal.value) || 75));
			const b = Math.max(1, Math.min(99, Number(emergency.value) || 35));
			talk(`@companion heal ${a} ${b}`, false);
		})
	));
}

function _drawGear() {
	const page = _page('gear');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Take gear back from a summoned companion. Choose a companion, then the slots.';
	page.append(hint);

	const summoned = _roster.filter(m => m.active);
	if (!summoned.length) {
		const e = document.createElement('div');
		e.className = 'empty';
		e.textContent = 'No companion is summoned right now.';
		page.append(e);
		return;
	}

	summoned.forEach(m => {
		const h = document.createElement('h4');
		h.textContent = m.name;
		page.append(h);

		const slots = ['weapon', 'shield', 'armor', 'shoes', 'garment', 'acc', 'head', 'costume', 'shadow'];
		const grid = document.createElement('div');
		grid.className = 'grid';
		grid.append(_button('All', 'b', () => {
			talk(`@companion gear ${m.name}`, false);
		}, 'Take everything'));
		slots.forEach(slot => {
			grid.append(_button(slot, 'b', () => {
				talk(`@companion gear ${m.name} ${slot}`, false);
			}, `Take back: ${slot}`));
		});
		page.append(grid);
	});
}


/**
 * Route the roster's machine-readable lines into the parser and keep them out of
 * the chat log.
 *
 * Installed from init() rather than at module scope on purpose: BasicInfo is
 * imported after ChatBox, so importing this component at module scope closes an
 * import cycle and the ChatBox binding is still undefined here. Reaching into it
 * during module evaluation threw and the client failed to load entirely
 * ("Failed to load app: Online.js"), which is exactly the bug this replaces.
 */
function installChatHook() {
	if (typeof ChatBox === 'undefined' || ChatBox === null || !ChatBox.addText) {
		return;
	}
	if (ChatBox.__companionPanelHooked) {
		return;
	}
	const original = ChatBox.addText;
	ChatBox.addText = function addText(text, ...rest) {
		if (typeof text === 'string' && text.indexOf('@CP') >= 0 && parseRosterLine(text)) {
			return;
		}
		return original.call(this, text, ...rest);
	};
	ChatBox.__companionPanelHooked = true;
}

/**
 * Show an in-window confirmation. Resolves to true when the player confirms.
 *
 * Deliberately not window.confirm(): a blocking browser dialog freezes the game
 * loop and input until it is dismissed, inside a component that lives on the game
 * page. This overlay is plain DOM, so the confirming click is an ordinary click on
 * this component and nothing else stops.
 *
 * @param {string} question
 * @param {string} detail
 * @return {Promise<boolean>}
 */
function confirmInWindow(question, detail) {
	return new Promise(resolve => {
		const root = CompanionPanel.getRoot();
		const overlay = document.createElement('div');
		overlay.className = 'confirm-overlay';
		overlay.innerHTML = `
			<div class="confirm-box">
				<div class="confirm-question"></div>
				<div class="confirm-detail"></div>
				<div class="confirm-buttons">
					<button class="b" data-act="cancel">Cancel</button>
					<button class="b danger" data-act="ok">Delete</button>
				</div>
			</div>`;
		overlay.querySelector('.confirm-question').textContent = question;
		overlay.querySelector('.confirm-detail').textContent = detail || '';

		const done = answer => {
			overlay.remove();
			resolve(answer);
		};
		overlay.addEventListener('mousedown', e => e.stopImmediatePropagation());
		overlay.querySelector('[data-act="cancel"]').addEventListener('click', e => {
			e.stopPropagation();
			done(false);
		});
		overlay.querySelector('[data-act="ok"]').addEventListener('click', e => {
			e.stopPropagation();
			done(true);
		});
		// Escape cancels, matching every other window in the client.
		const onKey = ev => {
			if (ev.key === 'Escape') {
				ev.stopPropagation();
				window.removeEventListener('keydown', onKey, true);
				done(false);
			}
		};
		window.addEventListener('keydown', onKey, true);
		root.append(overlay);
	});
}

/**
 * Initialize events
 */
CompanionPanel.init = function init() {
	installChatHook();
	const root = this.getRoot();

	this.draggable('.titlebar');

	// Resize grip. Dragging it sets an explicit size; the stored size wins over
	// the content-driven default from then on. Double-click resets to auto.
	const grip = root.querySelector('.resize-grip');
	if (grip) {
		const panel = root.querySelector('.panel');
		grip.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startY = event.clientY;
			const startW = panel.offsetWidth;
			const startH = panel.offsetHeight;
			grip.setPointerCapture(event.pointerId);
			const move = ev => {
				const w = Math.max(296, startW + (ev.clientX - startX));
				const h = Math.max(160, startH + (ev.clientY - startY));
				panel.style.width = `${w}px`;
				panel.style.height = `${h}px`;
			};
			const up = () => {
				grip.removeEventListener('pointermove', move);
				grip.removeEventListener('pointerup', up);
				_preferences.width = panel.offsetWidth;
				_preferences.height = panel.offsetHeight;
				_preferences.save();
			};
			grip.addEventListener('pointermove', move);
			grip.addEventListener('pointerup', up);
		});
		grip.addEventListener('dblclick', event => {
			event.stopPropagation();
			panel.style.width = '';
			panel.style.height = '';
			_preferences.width = 0;
			_preferences.height = 0;
			_preferences.save();
		});
	}

	root.querySelector('.titlebar .close').addEventListener('click', () => {
		CompanionPanel._host.style.display = 'none';
	});

	// Tabs are ui-button elements now, not plain <button>, so select on the class
	// and data attribute instead of the tag name.
	const tabs = root.querySelectorAll('.tab[data-tab]');
	tabs.forEach(btn => {
		btn.addEventListener('click', () => {
			tabs.forEach(b => b.classList.toggle('on', b === btn));
			root.querySelectorAll('.page').forEach(p => {
				p.style.display = p.dataset.page === btn.dataset.tab ? '' : 'none';
			});
			// Switching to a tab re-reads the roster, so a stale list cannot sit
			// there looking broken after companions are summoned or benched.
			if (btn.dataset.tab === 'party' || btn.dataset.tab === 'gear') {
				refreshRoster();
			}
		});
	});
	if (tabs.length) {
		tabs[0].classList.add('on');
	}

};

/**
 * Intercept roster lines coming from the server BEFORE init runs, so the hook is
 * in place even if the first refresh answers before the component is initialised.
 *
 * ChatBox.addText is the single funnel every server message passes through, so
 * wrapping it is how the panel sees its own data without a second network path.
 * @CP lines return false so they never reach the chat log - the raw format is
 * machine data, not something a player should read.
 */


/**
 * When the window is removed
 */
CompanionPanel.onRemove = function onRemove() {
	_preferences.x = this._host.offsetLeft;
	_preferences.y = this._host.offsetTop;
	_preferences.squads = _preferences.squads || {};
	_preferences.save();
};

/**
 * Once appended: position from the saved preference (clamped to the viewport,
 * like every other window) and ask for the roster. A map change re-appends the
 * component, so this is also where the list is refreshed after a warp.
 */
CompanionPanel.onAppend = function onAppend() {
	// A size the player chose is applied here; with none, the panel keeps its
	// content-driven width so nothing is ever cropped by a stale fixed value.
	const panel = this.getRoot().querySelector('.panel');
	if (panel) {
		panel.style.width = _preferences.width ? `${_preferences.width}px` : '';
		panel.style.height = _preferences.height ? `${_preferences.height}px` : '';
	}
	Object.assign(this._host.style, {
		top: `${Math.min(Math.max(0, _preferences.y), Renderer.height - this._host.getBoundingClientRect().height)}px`,
		left: `${Math.min(Math.max(0, _preferences.x), Renderer.width - this._host.getBoundingClientRect().width)}px`
	});
	_roster = [];
	refreshRoster();
};

/**
 * Clean up
 */
CompanionPanel.clean = function clean() {
	_preferences.save();
};

CompanionPanel.toggle = function toggle() {
	// append() prepares on demand (see GUIComponent.append -> prepare), so this
	// also covers the case where the engine never prepared this component: a
	// button press must not be the thing that discovers _host is still null.
	if (!this.__active || !this._host || this._host.style.display === 'none') {
		this.append();
		this._host.style.display = '';
		if (typeof this._fixPositionOverflow === 'function') {
			this._fixPositionOverflow();
		}
	} else {
		this._host.style.display = 'none';
	}
};

export default UIManager.addComponent(CompanionPanel);
export { refreshRoster };
