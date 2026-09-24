'use strict';
// Companion panel — a command surface for AI companions.
//
// The server treats *party chat* as the order channel (see docs/COMPANIONS.md):
// "attack" / "defensive" / "passive" set the group stance, "<name> tank" sets one
// companion's duty, "taunt" and "recall" are orders. At-commands such as
// "@companion summon <name>" are ordinary public chat. This panel is therefore a
// thin, opinionated front-end for sentences the player could type by hand: every
// button ends in one chat line, so nothing here can do anything the chat line
// could not, and the server stays the only authority.
//
// The roster is read from the party window's own DOM (the same nodes the client
// draws), so it needs no new server data. Names are remembered locally so the
// squad presets survive a restart.

const PANEL_ID = 'ro-companion-panel';

const STYLES = `
#${PANEL_ID} {
  position: fixed; width: 330px; z-index: 2147483000;
  font: 12px/1.45 Verdana, "Segoe UI", sans-serif; color: #e8e8e8;
  background: linear-gradient(180deg, #1b1f2aea, #12161fe8);
  border: 1px solid #4a5468; border-radius: 6px;
  box-shadow: 0 10px 28px #000a; backdrop-filter: blur(3px);
  user-select: none;
}
#${PANEL_ID}[hidden] { display: none; }
#${PANEL_ID} .title {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: linear-gradient(180deg, #2c3446, #222938);
  border-bottom: 1px solid #4a5468; border-radius: 6px 6px 0 0; cursor: move;
}
#${PANEL_ID} .title b { flex: 1; font-size: 12px; letter-spacing: .4px; color: #dbe4f5; }
#${PANEL_ID} .title span { color: #93a1bd; font-weight: normal; }
#${PANEL_ID} .x { cursor: pointer; color: #b9c4d8; padding: 0 4px; }
#${PANEL_ID} .x:hover { color: #fff; }
#${PANEL_ID} .tabs { display: flex; border-bottom: 1px solid #3a4356; }
#${PANEL_ID} .tabs button {
  flex: 1; padding: 6px 0; background: #1a1f2b; color: #8d9ab5;
  border: 0; border-right: 1px solid #3a4356; cursor: pointer; font-size: 11px;
}
#${PANEL_ID} .tabs button:last-child { border-right: 0; }
#${PANEL_ID} .tabs button.on { background: #2e6fb7; color: #fff; }
#${PANEL_ID} .page { padding: 9px 10px; max-height: 60vh; overflow-y: auto; }
#${PANEL_ID} .page[hidden] { display: none; }
#${PANEL_ID} h4 {
  margin: 9px 0 5px; font-size: 10px; letter-spacing: .8px;
  text-transform: uppercase; color: #8fa2c4; font-weight: bold;
}
#${PANEL_ID} h4:first-child { margin-top: 0; }
#${PANEL_ID} .row {
  display: flex; align-items: center; gap: 4px; padding: 5px 6px; margin-bottom: 4px;
  background: #232a38; border: 1px solid #3a4356; border-radius: 4px;
}
#${PANEL_ID} .row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .row .lv { color: #8d9ab5; font-size: 10px; }
#${PANEL_ID} .row .duty { font-size: 9px; padding: 1px 4px; border-radius: 3px; }
#${PANEL_ID} .duty.tank { background: #2f6b45; }
#${PANEL_ID} .duty.support { background: #2b5d78; }
#${PANEL_ID} .duty.attacker { background: #7a3b3b; }
#${PANEL_ID} .duty.none { background: #3d4454; color: #98a4bb; }
#${PANEL_ID} button.b {
  padding: 4px 7px; background: #333c50; color: #dfe6f4;
  border: 1px solid #4a5468; border-radius: 4px; cursor: pointer; font-size: 10px;
}
#${PANEL_ID} button.b:hover { background: #3e4a63; }
#${PANEL_ID} button.b.on { background: #2e6fb7; border-color: #4b8fd6; color: #fff; }
#${PANEL_ID} button.b.wide { flex: 1; padding: 6px 0; font-size: 11px; }
#${PANEL_ID} button.b:disabled { opacity: .45; cursor: default; }
#${PANEL_ID} .grid { display: flex; gap: 4px; flex-wrap: wrap; }
#${PANEL_ID} .hint { color: #8693ac; font-size: 10px; margin: 4px 0 2px; }
#${PANEL_ID} .empty { color: #8693ac; font-size: 11px; font-style: italic; padding: 6px 2px; }
#${PANEL_ID} input.num {
  width: 46px; padding: 3px 4px; background: #1a1f2b; color: #e8e8e8;
  border: 1px solid #4a5468; border-radius: 3px; font-size: 11px;
}
#${PANEL_ID} .squad { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
#${PANEL_ID} .squad .sn { flex: 1; color: #cfd8ea; }
#${PANEL_ID} .toast {
  position: fixed; left: 50%; transform: translateX(-50%); bottom: 84px; z-index: 2147483001;
  background: #12161fdd; border: 1px solid #4a5468; color: #e8e8e8; padding: 6px 12px;
  border-radius: 4px; font: 12px Verdana, sans-serif; pointer-events: none;
}
`;

function send(api, text, channel) {
  return api.actions.perform('chat', { text, channel });
}

/** Party roster, read from the nodes the client itself renders. */
function readRoster() {
  const out = [];
  let nodes;
  try {
    nodes = document.querySelectorAll('[class*="party" i] .node, .content .party .node');
  } catch {
    nodes = [];
  }
  for (const node of nodes) {
    const name = node.querySelector('.name')?.textContent?.trim();
    if (!name) continue;
    const level = parseInt((node.querySelector('.level')?.textContent || '').replace(/\D+/g, ''), 10);
    const hpText = node.querySelector('.hp')?.textContent || '';
    const [hp, hpMax] = hpText.split('/').map(v => parseInt(v.replace(/\D+/g, ''), 10));
    const aid = node.getAttribute('data-aid');
    if (out.some(m => m.name === name)) continue;
    out.push({
      name,
      aid: aid ? Number(aid) : null,
      level: Number.isFinite(level) ? level : 0,
      hp: Number.isFinite(hp) ? hp : null,
      hpMax: Number.isFinite(hpMax) ? hpMax : null,
      isLeader: node.classList.contains('leader'),
      me: node.classList.contains('leader') || /me/i.test(node.querySelector('.status-icon')?.style?.backgroundImage || ''),
    });
  }
  return out.slice(0, 12);
}
'use strict';
// Part 2: panel construction, tabs, and the three pages.

function buildPanel(api, state) {
  const el = document.createElement('section');
  el.id = PANEL_ID;
  el.hidden = true;
  el.innerHTML = `
    <div class="title">
      <b>Companions <span class="count"></span></b>
      <span class="x" title="Close">✕</span>
    </div>
    <div class="tabs">
      <button data-tab="party" class="on">Party</button>
      <button data-tab="summon">Summon</button>
      <button data-tab="battle">Battle</button>
      <button data-tab="squads">Squads</button>
    </div>
    <div class="page" data-page="party"></div>
    <div class="page" data-page="summon" hidden></div>
    <div class="page" data-page="battle" hidden></div>
    <div class="page" data-page="squads" hidden></div>`;

  const page = name => el.querySelector(`.page[data-page="${name}"]`);
  const showTab = name => {
    el.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    el.querySelectorAll('.page').forEach(p => { p.hidden = p.dataset.page !== name; });
    render();
  };
  el.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  el.querySelector('.x').addEventListener('click', () => { el.hidden = true; });

  // --- drag by the title bar, remembered per browser ---
  const title = el.querySelector('.title');
  let drag = null;
  title.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('x')) return;
    drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
    title.setPointerCapture(e.pointerId);
  });
  title.addEventListener('pointermove', e => {
    if (!drag) return;
    el.style.left = `${Math.max(0, Math.min(innerWidth - el.offsetWidth, e.clientX - drag.dx))}px`;
    el.style.top = `${Math.max(0, Math.min(innerHeight - 40, e.clientY - drag.dy))}px`;
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    api.preferences.set('panel', { x: el.offsetLeft, y: el.offsetTop });
  };
  title.addEventListener('pointerup', endDrag);
  title.addEventListener('pointercancel', endDrag);

  const saved = api.preferences.get('panel', null);
  el.style.left = `${saved?.x ?? Math.max(12, innerWidth - 360)}px`;
  el.style.top = `${saved?.y ?? 150}px`;

  // --- toast, one at a time ---
  let toastEl = null;
  let toastTimer = 0;
  const toast = text => {
    toastEl?.remove();
    clearTimeout(toastTimer);
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.textContent = text;
    document.body.append(toastEl);
    toastTimer = setTimeout(() => { toastEl?.remove(); toastEl = null; }, 1800);
  };

  return { el, page, showTab, toast, render: () => render() };
}
'use strict';
// Part 3: the three pages (Party / Battle / Squads) + the panel's render pass.

function renderPage(ui, api, state, toast) {
  const { page } = ui;
  const roster = readRoster();

  // ---------------- Party ----------------
  const saved = api.preferences.get('saved', []);
  const p = page('party');
  p.replaceChildren();

  const on = roster.filter(m => !m.me);
  const head = document.createElement('div');
  head.className = 'hint';
  head.textContent = on.length
    ? `${on.length} companion${on.length === 1 ? '' : 's'} in party.`
    : 'No companions in the party yet.';
  p.append(head);

  if (!on.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Recruit in game (whisper "party" to a population character), or summon a saved one below.';
    p.append(e);
  }

  for (const m of on) {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = m.name;
    const lv = document.createElement('span');
    lv.className = 'lv';
    lv.textContent = m.level ? `Lv.${m.level}` : '';
    const duty = document.createElement('span');
    const known = state.duties[m.name];
    duty.className = `duty ${known || 'none'}`;
    duty.textContent = known ? known : 'auto';
    row.append(nm, lv, duty);

    // Duty cycle: none -> attacker -> tank -> support -> none
    const cycle = document.createElement('button');
    cycle.className = 'b';
    cycle.textContent = 'Duty';
    cycle.title = 'Cycle this companion\'s duty (attacker / tank / support)';
    cycle.addEventListener('click', () => {
      const order = [null, 'attacker', 'tank', 'support'];
      const next = order[(order.indexOf(state.duties[m.name] || null) + 1) % order.length];
      if (next) {
        state.duties[m.name] = next;
        send(api, `${m.name} ${next}`, 'party');
        toast(`${m.name} → ${next}`);
      } else {
        delete state.duties[m.name];
        toast(`${m.name} duty cleared (server keeps its profile role)`);
      }
      api.preferences.set('duties', state.duties);
      ui.render();
    });
    row.append(cycle, benchButton(api, m, toast));
    p.append(row);
  }

  // Summon the saved list (recruited before, currently benched/absent).
  if (saved.length) {
    const h = document.createElement('h4');
    h.textContent = 'Saved companions';
    p.append(h);
    for (const name of saved) {
      if (on.some(m => m.name === name)) continue;
      const row = document.createElement('div');
      row.className = 'row';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = name;
      const sum = document.createElement('button');
      sum.className = 'b';
      sum.textContent = 'Summon';
      sum.addEventListener('click', () => {
        send(api, `@companion summon ${name}`);
        toast(`Summoning ${name}…`);
      });
      const forget = document.createElement('button');
      forget.className = 'b';
      forget.textContent = '✕';
      forget.title = 'Remove from this local list (does not affect the server)';
      forget.addEventListener('click', () => {
        api.preferences.set('saved', saved.filter(n => n !== name));
        ui.render();
      });
      row.append(nm, sum, forget);
      p.append(row);
    }
  }

  const add = document.createElement('button');
  add.className = 'b wide';
  add.textContent = '+ Add a remembered companion';
  add.addEventListener('click', () => {
    const name = prompt('Companion name (as it appears in @companion list):');
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed || saved.includes(trimmed)) return;
    api.preferences.set('saved', [...saved, trimmed]);
    ui.render();
  });
  p.append(add);

  // ---------------- Battle ----------------
  const b = page('battle');
  b.replaceChildren();

  const hStance = document.createElement('h4');
  hStance.textContent = 'Stance (whole party)';
  b.append(hStance);
  const stances = [
    ['attack', 'Free', 'Engage on sight inside 12 cells of you.'],
    ['defensive', 'Standard', 'Fight what you fight; defend the party. Default.'],
    ['passive', 'Hold', 'Never start a fight — still follows, heals and buffs.'],
  ];
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const [cmd, label, tip] of stances) {
    const btn = document.createElement('button');
    btn.className = `b wide${state.stance === cmd ? ' on' : ''}`;
    btn.textContent = label;
    btn.title = tip;
    btn.addEventListener('click', () => {
      state.stance = cmd;
      send(api, cmd, 'party');
      api.preferences.set('stance', cmd);
      toast(`${label} stance sent`);
      ui.render();
    });
    grid.append(btn);
  }
  b.append(grid);

  const hOrders = document.createElement('h4');
  hOrders.textContent = 'Orders';
  b.append(hOrders);
  const orders = document.createElement('div');
  orders.className = 'grid';
  const taunt = document.createElement('button');
  taunt.className = 'b wide';
  taunt.textContent = 'Taunt / Pull';
  taunt.title = 'Your defender grabs the monster you are targeting and drags it to you.';
  taunt.addEventListener('click', () => { send(api, 'taunt', 'party'); toast('Taunt sent'); });
  const recall = document.createElement('button');
  recall.className = 'b wide';
  recall.textContent = 'Recall';
  recall.title = 'Teleport every summon beside you.';
  recall.addEventListener('click', () => { send(api, 'recall', 'party'); toast('Recall sent'); });
  orders.append(taunt, recall);
  b.append(orders);

  const hHeal = document.createElement('h4');
  hHeal.textContent = 'Healer priority';
  b.append(hHeal);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Thresholds a support companion heals below. Saved on the server.';
  b.append(hint);
  const hRow = document.createElement('div');
  hRow.className = 'row';
  const below = document.createElement('span');
  below.className = 'nm';
  below.textContent = 'Heal below';
  const inNormal = document.createElement('input');
  inNormal.className = 'num';
  inNormal.type = 'number';
  inNormal.min = '1';
  inNormal.max = '99';
  inNormal.value = String(api.preferences.get('healAt', 75));
  const pct = document.createElement('span');
  pct.className = 'lv';
  pct.textContent = '%';
  const inEm = document.createElement('input');
  inEm.className = 'num';
  inEm.type = 'number';
  inEm.min = '1';
  inEm.max = '99';
  inEm.value = String(api.preferences.get('emergencyAt', 35));
  const pct2 = document.createElement('span');
  pct2.className = 'lv';
  pct2.textContent = '% emergency';
  const apply = document.createElement('button');
  apply.className = 'b';
  apply.textContent = 'Set';
  apply.addEventListener('click', () => {
    const a = Math.max(1, Math.min(99, Number(inNormal.value) || 75));
    const e = Math.max(1, Math.min(99, Number(inEm.value) || 35));
    api.preferences.set('healAt', a);
    api.preferences.set('emergencyAt', e);
    send(api, `@companion heal ${a} ${e}`);
    toast(`Heal below ${a}% / emergency ${e}%`);
  });
  hRow.append(below, inNormal, pct, inEm, pct2, apply);
  b.append(hRow);

  // ---------------- Squads ----------------
  const s = page('squads');
  s.replaceChildren();
  const squads = api.preferences.get('squads', {});

  const hS = document.createElement('h4');
  hS.textContent = 'Party squads';
  s.append(hS);
  const h2 = document.createElement('div');
  h2.className = 'hint';
  h2.textContent = 'Save the companions you have now, then re-summon the whole set with one click.';
  s.append(h2);

  for (const [name, members] of Object.entries(squads)) {
    const row = document.createElement('div');
    row.className = 'squad';
    const sn = document.createElement('span');
    sn.className = 'sn';
    sn.textContent = `${name} (${members.length})`;
    sn.title = members.join(', ');
    const go = document.createElement('button');
    go.className = 'b';
    go.textContent = 'Summon all';
    go.addEventListener('click', () => {
      for (const m of members) send(api, `@companion summon ${m}`);
      toast(`Summoning ${members.length} from ${name}…`);
    });
    const del = document.createElement('button');
    del.className = 'b';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      delete squads[name];
      api.preferences.set('squads', squads);
      ui.render();
    });
    row.append(sn, go, del);
    s.append(row);
  }

  const save = document.createElement('button');
  save.className = 'b wide';
  save.textContent = '+ Save current party as a squad';
  save.addEventListener('click', () => {
    const names = readRoster().filter(m => !m.me).map(m => m.name);
    if (!names.length) { toast('No companions in the party to save'); return; }
    const label = prompt('Squad name (for example: MVP, PVE, GVG):', 'MVP');
    if (!label) return;
    const key = label.trim().slice(0, 24);
    if (!key) return;
    squads[key] = names;
    api.preferences.set('squads', squads);
    toast(`Saved ${names.length} in "${key}"`);
    ui.render();
  });
  s.append(save);

  // ---------------- Summon (Phase 3: draft any job) ----------------
  renderSummonPage(ui, api, toast);
}

function benchButton(api, member, toast) {
  const btn = document.createElement('button');
  btn.className = 'b';
  btn.textContent = 'Bench';
  btn.title = 'Expel this companion from the party (it stays in your saved list).';
  btn.addEventListener('click', () => {
    send(api, `@companion dismiss ${member.name}`);
    toast(`Benching ${member.name}…`);
  });
  return btn;
}
'use strict';
// Part 5: the Summon tab — draft a companion of any job (Phase 3).
// Jobs are grouped the way a player thinks of them; each button sends
// "@companion draft <Job>" exactly as typing it would.

const JOB_GROUPS = [
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
           'Shinkiro', 'Shiranui', 'NightWatch', 'HyperNovice', 'SpiritHandler']],
];

function renderSummonPage(ui, api, toast) {
  const p = ui.page('summon');
  p.replaceChildren();

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Draft a new companion of any job. It joins your party immediately.';
  p.append(hint);

  for (const [label, jobs] of JOB_GROUPS) {
    const h = document.createElement('h4');
    h.textContent = label;
    p.append(h);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const job of jobs) {
      const b = document.createElement('button');
      b.className = 'b';
      b.textContent = job.replace(/([a-z])([A-Z])/g, '$1 $2');
      b.title = `Draft a ${job} companion`;
      b.addEventListener('click', () => {
        send(api, `@companion draft ${job}`);
        toast(`Drafting ${job}…`);
      });
      grid.append(b);
    }
    p.append(grid);
  }

  const note = document.createElement('div');
  note.className = 'hint';
  note.textContent = 'Drafted companions level like any party member and change job on their own as they grow.';
  p.append(note);
}
'use strict';
// Part 4: initializer — mount, bind, clean up.

export default function initialize(parameters, api) {
  if (api?.version !== 1) throw new Error('companion-panel requires client API 1');
  const hotkey = parameters?.hotkey_enabled !== false;
  const showButton = parameters?.show_button !== false;

  const state = {
    duties: api.preferences.get('duties', {}),
    stance: api.preferences.get('stance', 'defensive'),
  };

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);

  // buildPanel/renderPage are defined in the same bundle (see part 2/3): defined
  // here as closures so the panel owns no globals.
  const ui = buildPanel(api, state);
  document.body.append(ui.el);
  api.cleanup(() => { ui.el.remove(); style.remove(); });

  function render() {
    try {
      renderPage(ui, api, state, ui.toast);
      const count = ui.el.querySelector('.count');
      const n = readRoster().filter(m => !m.me).length;
      if (count) count.textContent = n ? `${n}/11` : '';
    } catch (error) {
      ui.toast(`Panel error: ${error.message}`);
    }
  }
  ui.render = render;

  // Roster changes are what the page is about: re-read whenever the party
  // window draws, and on an interval as a safety net (HP bars update often).
  let raf = 0;
  const schedule = () => {
    if (raf || ui.el.hidden) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  };
  api.on('ui:append', schedule);
  api.on('ui:remove', schedule);
  api.on('map:enter', schedule);
  const interval = setInterval(() => {
    const node = document.querySelector(`#${PANEL_ID}`);
    if (node && !node.hidden) schedule();
  }, 1500);
  api.cleanup(() => { clearInterval(interval); if (raf) cancelAnimationFrame(raf); });

  // --- open/close: hotkey, and a button in the party window title bar ---
  const toggle = () => {
    ui.el.hidden = !ui.el.hidden;
    if (!ui.el.hidden) render();
  };
  const onKey = event => {
    if (!hotkey) return;
    if (event.ctrlKey && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  };
  window.addEventListener('keydown', onKey, true);
  api.cleanup(() => window.removeEventListener('keydown', onKey, true));

  const attachButton = () => {
    if (!showButton) return;
    const bar = document.querySelector('[class*="party" i] .header, .content .party')?.closest('[class*="party" i]');
    if (!bar || bar.querySelector('.ro-companion-open')) return;
    const btn = document.createElement('button');
    btn.className = 'ro-companion-open';
    btn.textContent = 'Companions';
    btn.style.cssText = 'margin:0 2px;padding:1px 5px;font:10px Verdana,sans-serif;cursor:pointer;';
    btn.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    const anchor = bar.querySelector('.titlebar, .header') || bar;
    anchor.append(btn);
  };
  api.on('ui:append', attachButton);
  api.on('map:enter', attachButton);
  attachButton();

  // First render only once a roster exists; until then the panel opens empty.
  api.on('ui:append', () => { if (!ui.el.hidden) schedule(); });
  return () => { /* cleanup registered via api.cleanup above */ };
}
