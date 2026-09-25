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
		squads: {}
	},
	1.0
);

/// The roster as last received from the server, parsed from @companion list raw.
let _roster = [];
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
function refreshRoster() {
	talk('@companion list raw', false);
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
		_render();
		return true;
	}
	if (body.startsWith('@CPFAIL')) {
		_roster = [];
		_render();
		return true;
	}
	const parts = body.split('|');
	if (parts[0] !== '@CP' || parts.length < 7) {
		return false;
	}
	_roster.push({
		name: parts[1],
		job: parts[2],
		level: parseInt(parts[3], 10) || 0,
		active: parts[4] === '1',
		favorite: parts[5] === '1',
		liveLevel: parseInt(parts[6], 10) || 0
	});
	_render();
	return true;
}

let _collecting = false;
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

		page.append(_row(nm, lv, badge, duty, summon, fav));
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
 * Initialize events
 */
CompanionPanel.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	root.querySelector('.titlebar .close').addEventListener('click', () => {
		CompanionPanel._host.style.display = 'none';
	});

	root.querySelectorAll('.tabs button').forEach(btn => {
		btn.addEventListener('click', () => {
			root.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b === btn));
			root.querySelectorAll('.page').forEach(p => {
				p.style.display = p.dataset.page === btn.dataset.tab ? '' : 'none';
			});
		});
	});
	root.querySelector('.tabs button').classList.add('on');

	// Ask for the roster whenever the window is opened, and after a map change
	// (a companion can be left behind or re-summoned across maps).
	this.onAppend = () => {
		_roster = [];
		refreshRoster();
	};
};

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
 * Append to html
 */
CompanionPanel.onAppend = function onAppend() {
	this._host.style.top = `${_preferences.y}px`;
	this._host.style.left = `${_preferences.x}px`;
};

/**
 * Clean up
 */
CompanionPanel.clean = function clean() {
	_preferences.save();
};

/**
 * Intercept roster lines coming from the server.
 *
 * ChatBox.addText is the single funnel every server message passes through, so
 * wrapping it is how the panel sees its own data without a second network path.
 * Returns false from the wrapper for @CP lines so they never reach the chat log
 * - the raw format is machine data, not something a player should read.
 */
const _addText = ChatBox.addText;
ChatBox.addText = function addText(text, ...rest) {
	if (typeof text === 'string' && text.indexOf('@CP') >= 0) {
		_collecting = true;
		if (parseRosterLine(text)) {
			return;
		}
	}
	return _addText.call(this, text, ...rest);
};

CompanionPanel.toggle = function toggle() {
	if (this._host.style.display === 'none') {
		this._host.style.display = '';
		this.append();
	} else {
		this._host.style.display = 'none';
	}
};

export default UIManager.addComponent(CompanionPanel);
export { refreshRoster };
