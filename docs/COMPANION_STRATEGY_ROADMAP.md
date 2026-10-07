# Companion strategies: roadmap

What companion strategies (`db/population_strategy.yml`,
[docs/mods/companion-strategies/](mods/companion-strategies/README.md)) have, and
what they still need. The first part is the state of things. The second,
[Not done yet](#not-done-yet), is written so that each open item can be picked
up later without this conversation: what is missing, why it was not done now,
how it would work, what it would add, and where to start.

## Status

| # | Item | Status |
|---|---|---|
| 1 | Holding position wins over following | built, played (Phreeoni) |
| 2 | Leaving hostile ground (`Leave:`) | built, not yet played |
| 3 | Choosing who to help or fight (selectors, `SetTarget`) | built, played (Phreeoni) |
| 4 | Items and gear | **not done**: needs [inventories](#inventories-the-foundation) |
| 5 | [Time and memory](#5-time-and-memory) | **not done** |
| 6 | Companions coordinating | signals built, not yet played; role plans built and played; [roles that change in a fight and claims](#6-coordination-roles-that-change-in-a-fight-and-claims) **not done** |
| 7 | Boss mechanics (MVP survey, A to F) | built; phases, reacting to a summon and revealing a hidden boss played |
| 8 | [AI raid parties](#8-ai-raid-parties) | **not done** |

Built since the list was first written, and played against Phreeoni unless
noted:
- role plans for any boss (`Mob: Boss`, `examples/mods/companion-roles`), with
  the role taken from the class family and overridden by the party-chat Duty;
- `Job:` lists and class families;
- layered `Rotation`; `Allow` and `Ban`, which also bind the engine's own heals
  and buffs; `Attack: false` and `Exact` (not yet played);
- `Cast:` lists, which pick a spell by element;
- kinds of monster (`Mob: { Race, Element }`) and `Disable` (not yet played).

Engine fixes along the way, active with or without plans:
- a companion that cannot move takes no turn;
- Sanctuary is never placed where it would heal a monster;
- healers pass over allies their heals cannot help (undead armour).

**Phreeoni has been beaten** by a Priest, a Wizard and an Assassin Cross beside
their owner, with companion-roles and companion-tactics. See
[Playtest: Phreeoni](#playtest-phreeoni).

# Built

## 1. Holding position wins over following

**The problem.** Owner-follow and its leash run before the companion's turn
(`pop_companion_follow_owner`). The companion loop also stops an idle
companion's walk and sends it to its formation cell. So `Hold`, `MoveTo`,
`KeepDistance`, `Retreat` and `Leave` lost as soon as the owner walked a few
cells away. Standing on a Land Protector or in a ring of Blaze Shield could not
last.

**What it does.** A rule that positions the companion holds it there for a
moment (`population_strategy_holds_position`). While it holds:

- the leash does not walk it back;
- the idle formation step does not move it;
- the idle stop does not cancel the walk the rule started.

Each positional action (or standing where `MoveTo` wanted it) renews the hold.
When no positional rule applies any more, following resumes within a turn.

**What it does not do.** It never stops the warps: a companion still follows its
owner to another map, and is still pulled back once the owner is out of sight
(`AREA_SIZE + 2`). Holding is for a fight on one screen, not a way to leave a
companion behind.

## 2. Leaving hostile ground

`Leave: { Field, Owner, Within }`. If the companion stands on a ground unit
placed by `Owner` (default `enemy`: anyone outside the party, monsters
included), it walks to the nearest free cell with none. `Field` narrows it to
one skill (Storm Gust, Meteor Storm, a trap); without it, any such unit counts.
Not standing on one: the rule passes.

## 3. Choosing who to help or fight

The case that drives it: **a tank that provokes whatever is hitting someone
else.** Today a rule's `Target` is fixed (`enemy`, `owner`, `event`...), so a
tank can only provoke what it already fights.

**Monster selectors** for `Target`, picked deterministically (closest to the
companion, then lowest id):

```yaml
- Name: peel
  Priority: 80
  Requires: { Role: tank }                      # the party role, set in party chat
  Cast: SM_PROVOKE
  Target: { Enemy: attacking, Who: party, NotSelf: true, Prefer: support }
  When: not_enemy_provoke                       # When's enemy_* is the chosen monster
  SetTarget: true                               # and keep fighting it
  OnePerParty: true                             # two tanks never provoke the same one
```

- `Enemy: attacking` with `Who: owner | party | support | self`; `NotSelf` for
  "hitting someone other than me". It reads each monster's target, which the
  engine already tracks per companion.
- Also `Enemy: nearest | lowest_hp | boss | slaves | casting`.
- With a selector, `When`'s `enemy_*` tokens ask about **the chosen monster**,
  not the current target, so `not_enemy_provoke` checks the right one.

**Ally selectors** for buffs and heals: `Target: { Ally: lowest_hp, Job: Knight }`,
`{ Ally: nearest, Role: tank }`, `{ Ally: missing, Status: SC_BLESSING }`.

**`SetTarget: true`** makes the chosen monster the companion's combat target for
3 s, renewed while the rule keeps applying. It needs no new engine line:
`population_strategy_target` already has the last word over the party
controller's choice, the same way holding position overrides following.
Assisting is a selector: `Target: { Enemy: target_of, Who: tank }` with
`SetTarget: true` takes the tank's target instead of the owner's.

Provoke itself fails on status-immune monsters (bosses, so Phreeoni) and on
Undead, and succeeds by chance otherwise (rAthena's `skills/swordman/provoke.cpp`).
Against Phreeoni, the tank's Provoke is for its slaves.

**`Requires: { Role: tank }`** gates a rule on the party role assigned in chat
(`<name> tank`), so one table serves a party arranged differently each time.
This was listed under 6; it belongs here because peeling is a tank's job.

Range: a monster out of the skill's range is not chosen for a `Cast`, so a tank
provokes what it can reach. If the playtest shows it should walk to one first,
that is an `Approach:` option on the rule.

## 7. Boss mechanics: what the MVPs do that rules could not answer

A survey of every MVP's `mob_skill_db` rows (renewal: 90 MVPs with skills, about
1,950 rows; the conditions are `always` 1054, `myhpltmaxrate` 390, `slavele` 159,
`rudeattacked` 135, `skillused` 85, `longrangeattacked` 34, `attackpcge` 15,
`casttargeted` 12, and a few others). Most boss skills are **instant**, and an
instant skill cannot be seen coming. A rule can only answer its *result*: a
status on the boss, a ground field, new monsters. These are what that needed.

| | Gap | What it answers | Status |
|---|---|---|---|
| A | `Ban` and `Rotation` per **strategy**, not only per plan | Reflect Shield (14 rows), Magic Mirror (7), Auto Guard, Stone Skin (11), a boss in its own Pneuma (14) or Safety Wall (6): "no magic / no melee / no ranged until it drops" is a strategy whose rotation is limited | built |
| B | `Field: { ..., At: target }`: ground units around the rule's target | the boss standing in its own Pneuma, Safety Wall or Land Protector (16) | built |
| C | `Enemy: { Element, Race, Size, Boss }` on a rule | bosses that change element (NPC_CHANGEHOLY, CHANGETELEKINESIS...); `When` cannot express element or race | built |
| D | **Counting** monsters around a point (D1), and a cap on how many companions take one target (D2) | instant Call Slave (152 rows): "3 slaves around the boss → AoE"; `attackpcge` (15): bosses that answer N attackers with an AoE | built: `Count:` and `Targeting: { MaxAttackers }`. rAthena's `attackpcge` counts every unit targeting the boss; the cap counts the owner and the party's companions, lower companion ids first |
| E | **Can the boss reach me?** A path check before attacking from range | `rudeattacked` → Teleport, **135 rows, the commonest boss reaction**: hitting a boss from where it cannot walk to makes it vanish. rAthena decides it in `mob.cpp` (can it hit back from where it stands; can it move; `unit_can_reach_bl` within its chase range), so a rule can ask the same question. Holding a boss in place (Ankle Snare, Spider Web) counts as "cannot reach back" too | built: `Reach: false` on a rule, and `MoveTo: reachable` |
| F | **Encounter ended / target lost** events | after a Teleport the encounter plan just stops applying: "it teleported, regroup on the owner" | built (`encounter_ended`, `target_lost`, each with `Reason: died \| vanished`) |

Not answerable: an instant skill before it lands (Teleport, Call Slave, instant
summons, Power Up, Heal, instant Meteor / Land Protector / Heaven's Drive /
Pneuma, Dispel, Full Strip). Rules answer what follows: the status
(`enemy_*`, `Ally: having`, `Ally: missing` to rebuff after Dispel), the field
(`Field`, `Leave`), the monsters (D). Gear stripped or broken (Full Strip, the
breaks) waits for inventories.

Already answerable: the cast-time AoEs (Hell Judgement 30, Earthquake 29, Lord
of Vermilion 26, Meteor 22, Storm Gust 21, the Wide statuses ~60 together) with
`On: casts`; summons with a cast time (151); reactions to our own skills
(`skillused`, `groundattacked`, `casttargeted`) with a plan's `Ban`.

# Not done yet

Each item below has the same headings, so it can be picked up cold.

## Inventories: the foundation

**What is missing.** Shells and companions have no inventory of their own that
anyone manages. A companion's bag holds what the engine hands it (gear, virtual
ammunition) and what a trade puts there, and only its *worn* gear is saved
(`cp_companion_persistence`, `gear_detail`). The rest is lost with the shell.
Nothing restocks it, and the owner cannot see or manage it. On top of that, the
engine's rAthena patch (`0001`, `skill_get_requirement`) waives every item
requirement for population characters, so even an item that is there is never
needed or spent.

**Why not now.** Three decisions belong to the inventory itself, not to
strategies: where the bag is saved, who fills it (the owner by trade, a shopping
trip, a virtual supply), and how the owner sees and manages it (the companion
panel). Making items matter before that would only make companions weaker:
every catalyst skill would fail on an empty bag.

**How it would work.**
- Save the bag with the companion, beside its worn gear, so it survives a relog
  and a recall.
- Stock it by trade, which already lands items in the companion's bag
  (patch `0025` snapshots it).
- Show and manage it in the companion panel.
- Then stop waiving item requirements for companions in patch `0001`, behind a
  setting, so ambient shells can keep the waiver.

**What it adds.** The three items below, and real economy: a companion's gems,
potions and spare gear come from its owner.

**Where to start.** `cp_companion_persistence.sql` and the save and recall code
in `population_engine.cpp`; `patches/0025-companion-trade-snapshot.patch`;
`patches/0001-population-engine-hooks.patch` (`skill_get_requirement`);
`patches/CompanionPanel.*` for the UI.

### Catalysts for skills

**What is missing.** Skills that cost an item (Blue Gemstone for Resurrection,
Sanctuary and Magnus, Holy Water for Aspersio, Flame Stone for Blaze Shield)
are cast for free.

**Why not now.** No inventory: with an empty bag every such skill would fail.

**How it would work.** It is prepared already. Rules mark such casts
`Consume: true`, and the server checks at load that the skill has an item cost.
The strategy module has the paying code (`item_cost`, `can_pay`, `pay`) behind
one switch, `kPayCatalysts`, which is off. With inventories: turn the switch on,
and stop the patch-`0001` waiver for companions. A `Consume` rule then checks
the bag before casting and pays when the cast starts. The engine's own rotation
pays through rAthena as a player does. Rules can react to running low with
`item_below` (already an event) and, for example, say "out of gems".

**What it adds.** Catalysts become a resource the owner provides, so a
companion's strongest skills cost something, as they do for players.

**Where to start.** `kPayCatalysts` in `strategy/population_strategy.cpp`;
`Consume` in [the reference](mods/companion-strategies/reference.md#rules).
Tables written today need no change.

### Using items

**What is missing.** Companions use no items: no potions, no Yggdrasil Leaf, no
Fly Wing, no elemental converters.

**Why not now.** No inventory.

**How it would work.** A new rule action, `UseItem: <item>` with `Target:`
(`self`, an ally selector, a dead ally for a Yggdrasil Leaf). It calls rAthena's
item use (`pc_useitem`); for an item that targets someone, the server completes
the target step a client would send. Item use waits out its own delay the way
casts wait out theirs. The conditions exist: HP and SP (`When:`), the bag
(`item_below`, `Requires: { Items }`). Example: "below 30 % HP with no healer
alive, drink a White Potion".

**What it adds.** Survival without a healer, revives without a Priest, and
consumables as part of boss plans (a Yggdrasil Berry at Phreeoni's Power Up).

**Where to start.** A new action in `parse_rule` and `run_rule`
(`strategy/population_strategy.cpp`), modelled on `Cast`.

### Switching gear to the situation

**What is missing.** A companion wears one set of gear whatever it fights.

**Why not now.** No inventory to hold the other sets.

**How it would work.** Named gear sets on a plan (`Gear: { ghost: [...] }`) and a
rule action `Equip: <set>`, which equips the set's pieces from the bag. The
plan layers already describe *when*:
- an elemental weapon in a kind plan (`Mob: { Element: Ghost }`);
- an armour against a boss's element in that boss's plan;
- the normal set back under `Mob: All`.

Swapping costs a moment, so a set is switched once per fight, not per target. A
strategy is the natural place: entering it equips its set.

**What it adds.** The second half of fighting by element, after spells: the
right weapon against Ghosts or the undead, the right armour against a boss's
element. Also the answer to Strip and to broken gear (`equip_broken` is already
an event).

**Where to start.** The worn-gear code in `population_engine.cpp`
(`gear_detail`, the gear-return patches `0007` and `0025`); a new action in the
strategy module.

## 5. Time and memory

**What is missing.** A plan knows the present (HP, statuses, who is where) and
which strategy it is in. It does not know how long it has been in that
strategy, how long a status has left, or what it already did this fight.

**Why not now.** Phreeoni did not need it: its phases follow its HP, which the
plan can read. A boss whose pattern runs on a clock or on counts (every 30 s; at
the third summon) would.

**How it would work.** Kept per plan and per fight, reset when the plan starts
over:
- **Time** as conditions: time in the current strategy (`in_strategy_gt10s`),
  time since the fight began.
- **Time left on a status**, from rAthena's status timer:
  `ally_blessing_left_lt10s`, so a buff is renewed before it lapses rather than
  after.
- **Flags and counters**, as rule actions (`Set: lex_done`, `Inc: summons`,
  `Clear: ...`) and as conditions (`flag_lex_done`, `count_summons_ge3`). They
  turn "once per fight" and "after the third summon" into plain rules.

All of it lives in the strategy module's per-companion state, beside the active
strategy.

**What it adds.** Periodic actions ("every 30 s"), buffs without gaps,
once-per-fight openers, sequences longer than one state, and bosses with timed
patterns.

**Where to start.** `PlanState` in `strategy/population_strategy.cpp` (where the
active strategy lives); the condition parser for the new tokens.

## 6. Coordination: roles that change in a fight, and claims

### Roles that change in a fight

**What is missing.** A role is the party-chat Duty, or the class family through
a `Requires: { Role: [..., none] }` on a role plan. It does not change during a
fight. Selectors like `Who: support` only see a typed Duty. Regular shells have
no roles at all.

**Why not now.** It was designed after the Phreeoni playtests and deliberately
left for after the PR, so a test result is never mixed with a new feature.

**How it would work** (agreed design):
- A `Roles:` list in the same table, scoped like plans (a monster, a kind,
  `Boss`, `All`). Each entry names a role, a `Job`, and optional `When:` and
  `Stats: { Flee: ">=180", Def: ">=60", MaxHp: ... }`.
- Worked out for every party member, the owner included, before the plans are
  chosen: role, then plans, then rules. Re-checked every turn, with a minimum
  hold of about 3 s so a flickering condition does not flap.
- The first match wins, most specific scope first.
- A typed Duty replaces the defaults (entries without `When`). An entry marked
  `OverridesDuty: true` can still override it while its condition holds.
- Everything that reads roles (`Requires: { Role }`, `Who:`, `Role:` in
  selectors) reads this result.
- All of it in the strategy module, with `Stats:` read there too, so no engine
  change. The engine's own role behaviour keeps reading the Duty.

```yaml
- Mob: Boss
  Roles:
    - { Role: tank, Job: Monk, When: self_steelbody, OverridesDuty: true }
    - { Role: tank, Job: Assassin, Stats: { Flee: ">=180" } }
    - { Role: support, Job: Priest }
    - { Role: attacker, Job: All }
```

**What it adds.** Roles that follow the fight: a Monk under Steel Body becomes
the tank and the healer's tank rules follow it; an Assassin with enough Flee
tanks. The role plans can say plain `Role: support` instead of the
family-default lists. Regular shells get roles, and with them role plans.

**Where to start.** `plans_for` and `requires_ok` in
`strategy/population_strategy.cpp`; `member_is` for `Who:`.

### Claims

**What is missing.** `OnePerParty` stops two companions firing the same rule at
the same target at the same moment. Nothing stops two companions using
*different* rules for the same job: two Lex Aeternas on one boss, both
crowd-controllers on one monster while another runs free.

**Why not now.** The Phreeoni party had one of each role, so nothing doubled up.

**How it would work.** A rule takes `Claim: <name>` (for example `Claim: lex`). Acting
on a target puts a party-wide claim on (name, target) for the rule's duration or
until the target changes. Other companions' rules with the same claim skip a
claimed target and pick another. The module already keeps party-wide state for
`OnePerParty` and signals, and claims extend it.

**What it adds.** Parties with two of a role: crowd control spread over
different monsters, one Lex Aeterna per boss, two tanks holding two monsters.

**Where to start.** The `OnePerParty` bookkeeping in
`strategy/population_strategy.cpp`.

## 8. AI raid parties


Shells fighting an MVP on their own, as a party, with nobody's character in it.

**What exists.** Every ambient shell already belongs to a synthetic party, one per
map (`0x70000000 | map`, `population_engine.cpp`), so party-only skills such as
Kyrie and Devotion work between shells; with `PackBehavior`, idle shells share a
target. The PvP arena spawns teams in synthetic parties of their own
(`population_arena_start`, `npc/custom/population/arena.txt`). So shells fight side
by side, but as "everyone on this map": no leader, no goal, no plan.

**What a raid party needs:**

1. **A group**: a synthetic party per group, spawned by a script command in the
   arena's style. Engine work; a new script command also touches the engine's
   rAthena patch (`custom/script.inc`).
2. **A leader with a goal**: go to the MVP, find it, and the others follow that
   shell. Engine work: owner-follow knows only real players.
3. **Strategies for them**: let a raid group's shells (not ambient ones) run the
   strategy module, and let the module list a synthetic party's members (it asks
   rAthena's party table today, which does not know them). Module only, small.
   The plans themselves carry over unchanged.
4. **Someone watching**: shells only take combat turns while a real player has
   them in view (`pop_combat_tick_per_real_pc`); companions are the exception. A
   raid party would fight while watched, not on an empty map.
5. **A decision on rewards**: an AI party that kills an MVP takes it from players,
   and its MVP item and drops need an inventory (item 4) to go anywhere.

**Why not now.** It is mostly engine work: groups, a leader and a goal. It also
raises a game-design question, rewards, that the strategies do not answer. The
strategies themselves carry over unchanged.

**What it adds.** MVPs contested and killed by the world's AI characters:
something to watch, to race, or to join.

**Where to start.** `population_arena_start` (synthetic parties, spawning by
script) and the party listing in the strategy module (`party_members`).

## Measuring the cost

**What is missing.** How much a strategy turn costs on a busy map has not been
measured. Companions take turns all the time. Ambient shells only do so with a
`For: shells` or `For: all` plan, and only while a player watches them.

**Why not now.** The load tests run without a player online, so shells never
take turns there.

**How it would work.** A live session with traces off, timing
`population_strategy_turn` per shell on a crowded map, with and without a
`For: all` plan.

**What it adds.** A number to put beside "keep their plans short".

# Played

## Playtest: Phreeoni

The first played boss fight, after 1 and 2: a tank, a Priest and a damage dealer
with Wizard support, traces on (`<name> trace`).

Why Phreeoni. Its `mob_skill_db` (renewal adds All Heal; the rest is the same in
both eras) tests most of what the rules are for:

| Phreeoni does | What it tests |
|---|---|
| **Teleports** when attacked by someone it cannot reach (`rudeattacked`) | ranged companions placed badly lose the boss; positioning (1) |
| **Summons and calls slaves** | targeting: boss or slaves (3, `Targeting: Ignore`) |
| **Wide Stone Curse** below some HP (petrify around itself, 0.5 s cast) | `On: casts` + `KeepDistance`/`Retreat` in time |
| **Petrify Attack**, **Lick**, **Helm Break** | Priest reactions (Status Recovery), gear (4) |
| **Power Up** and **Hiding** below some HP | phases (5); Hiding is the "where did it go" moment |
| **Heal**; **All Heal** in renewal when hit hard | burst timing, focus (3, 5) |
| Renewal: 300,000 HP, defence 269, magic defence 98. Pre-renewal: 188,000 HP, defence 10 | a long fight; SP and consumables (4) |

Land Protector does not help against Phreeoni itself. Its Wide Stone Curse is
a petrify around the boss, not a ground spell, and its Heaven's Drive is instant,
so nothing sees it coming. Signals still matter there: gathering for heals or a
Sanctuary when it powers up, or "it is hiding" when it vanishes.

**Result.** Over seven playtests, each fix came from something that went wrong;
they are in
[Writing plans that hold up](mods/companion-strategies/reference.md#writing-plans-that-hold-up-in-a-fight).
The party of a Priest, a Wizard and an Assassin Cross beside their owner then
beat Phreeoni. Nothing in the fight needed items 4, 5, 6 or 8. The next
test is a second boss with a different kit, to show whether the role plans
generalise.
