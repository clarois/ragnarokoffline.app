# Companion strategies: cookbook

Short recipes, by what you want a companion to do. Each one goes into a job
entry's `Rules:` (or a strategy's) in your mod's `db/population_strategy.yml`.
Each is taken from the example mods, where it loads without warnings. The ones
from the Phreeoni plan have been played; others, the undead rules among them,
not yet. Adjust names, priorities and numbers to your plan. The
[guide](guide.md) explains the parts; [team play](team.md) has the priority bands.

**Healing and support**
- [Heal whoever is being hit](#heal-whoever-is-being-hit)
- [Keep buffs up on the party](#keep-buffs-up-on-the-party)
- [Wall a member before a stun lands](#wall-a-member-before-a-stun-lands)
- [Walk to the fallen and revive](#walk-to-the-fallen-and-revive)
- [Cure petrification](#cure-petrification)

**Positioning**
- [Stand still instead of melee](#stand-still-instead-of-melee)
- [Out of the boss's reach, within the party's](#out-of-the-bosss-reach-within-the-partys)
- [Low on HP: kite round the healer](#low-on-hp-kite-round-the-healer)
- [Leave hostile ground](#leave-hostile-ground)
- [Don't make a boss teleport](#dont-make-a-boss-teleport)

**Damage**
- [A bolt by element at what is on the party](#a-bolt-by-element-at-what-is-on-the-party)
- [Area spells only on a pack](#area-spells-only-on-a-pack)
- [Go for the boss, but take slaves off the healer](#go-for-the-boss-but-take-slaves-off-the-healer)
- [Turn heals on the undead](#turn-heals-on-the-undead)

**Boss mechanics**
- [Phases on the boss's HP](#phases-on-the-bosss-hp)
- [React to a cast](#react-to-a-cast)
- [Fall back when the healer is down](#fall-back-when-the-healer-is-down)

**Talking**
- [Ask another companion for something](#ask-another-companion-for-something)
- [Answer the player in party chat](#answer-the-player-in-party-chat)

**Limiting the engine**
- [Only these skills at a boss](#only-these-skills-at-a-boss)
- [Casters never melee](#casters-never-melee)
- [Do one role rule differently for one boss](#do-one-role-rule-differently-for-one-boss)
- [Regular AI characters: area spells only for packs](#regular-ai-characters-area-spells-only-for-packs)

---

## Heal whoever is being hit

```yaml
- Name: heal_attacked
  Priority: 78
  Cast: AL_HEAL
  Target: { Ally: attacked }          # whoever the monsters are on
  When: [ally_hp_pct_lt85, self_sp_ge70]
- Name: heal_low
  Priority: 77
  Cast: AL_HEAL
  Target: { Ally: lowest_hp }         # then whoever is lowest
  When: [ally_hp_pct_lt55, self_sp_ge70]
```

`self_sp_ge70` keeps SP back for Resurrection (60). An ally that Heal can't
help (undead armor) is passed over automatically.

## Keep buffs up on the party

```yaml
- Name: blessing
  Priority: 50
  Cast: AL_BLESSING
  Target: { Ally: missing, Status: SC_BLESSING }     # the nearest without it
  When: self_sp_ge120
```

Needed whenever the plan ends in `Hold`: `Hold` ends the turn before the
engine's own buffing would come round.

## Wall a member before a stun lands

```yaml
- Name: wall_the_stunned
  Priority: 80
  On: { Event: monster_casts, Skill: NPC_STUNATTACK, At: party }
  Cast: MG_SAFETYWALL
  Target: event                        # whoever it is aimed at
  OnePerParty: true
```

Only skills with a cast time can be seen coming.

## Walk to the fallen and revive

```yaml
- Name: wall_before_rez                # with something on it, a hit breaks the cast
  Priority: 108
  Present: { Ally: dead, Range: 9 }
  When: [self_targeted, not_self_safetywall]
  Cast: MG_SAFETYWALL
  Target: self
- Name: resurrect
  Priority: 106
  When: { OR: [self_safetywall, not_self_targeted] }
  Cast: ALL_RESURRECTION
  Target: dead_ally
  Say: "Getting you up, {ally}!"
- Name: close_to_the_fallen            # every turn until within Resurrection's 9
  Priority: 104
  Target: { Ally: dead, NotSelf: true }
  KeepDistance: { Min: 1, Max: 8 }
```

Write the walk as a condition, not as `On: party_member_died`: an event rule is
done after one step.

## Cure petrification

```yaml
- Name: unstone_early                  # while it is still setting in
  Priority: 102
  Cast: PR_STRECOVERY
  Target: { Ally: having, Status: SC_STONEWAIT }
- Name: unstone
  Priority: 101
  Cast: PR_STRECOVERY
  Target: { Ally: having, Status: SC_STONE }
```

And for everyone, so they don't run from the cure:

```yaml
- Name: wait_for_the_cure
  Priority: 100
  When: self_stonewait
  Present: { Ally: nearest, Job: Priest, NotSelf: true }
  Hold: true
```

## Stand still instead of melee

The last rule of a healer or caster:

```yaml
- Name: no_melee
  Priority: 1
  Present: { Enemy: attacking, Range: 14 }   # only while something is on the party
  Hold: true
```

Without the `Present` it would also hold when the fight has moved away, and get
left behind. For "never plain-attack at all", see
[Casters never melee](#casters-never-melee).

## Out of the boss's reach, within the party's

```yaml
- Name: stay_back
  Priority: 74
  Target: { Enemy: boss, Range: 14 }
  KeepDistance: 5                      # at least 5 from the boss
- Name: stay_near_the_hit
  Priority: 73
  Target: { Ally: attacked, NotSelf: true, Range: 14 }
  KeepDistance: { Min: 1, Max: 7 }     # within Heal's reach of them
- Name: stay_with_the_party
  Priority: 72
  Target: { Ally: nearest, NotSelf: true, Range: 14 }
  KeepDistance: { Min: 1, Max: 7 }
```

A caster wants a band off the boss instead: `KeepDistance: { Min: 6, Max: 8 }`.

## Low on HP: kite round the healer

```yaml
- Name: kite_round_the_healer
  Priority: 60
  When: self_hp_pct_lt30
  Target: { Ally: nearest, Job: Priest, NotSelf: true, Range: 14 }
  Kite: { Away: 4, Within: 7, Gap: 3 }     # away from the boss, near the healer, never onto it
- Name: go_to_the_healer               # nothing chasing it: just go and stand there
  Priority: 59
  When: self_hp_pct_lt30
  Target: { Ally: nearest, Job: Priest, NotSelf: true, Range: 14 }
  KeepDistance: { Min: 1, Max: 4 }
- Name: wait_for_heal
  Priority: 58
  When: self_hp_pct_lt30
  Present: { Ally: nearest, Job: Priest, NotSelf: true, Range: 14 }
  Hold: true
```

These come before the engine's own flee below 30 % HP, which would run it off
the screen.

## Leave hostile ground

```yaml
- Name: leave_hostile_ground
  Priority: 99
  Leave: { Owner: monster }            # out of Storm Gust, Meteor Storm, traps
```

## Don't make a boss teleport

Most bosses teleport when hit by someone they can't fight back against:

```yaml
- Name: no_rude_attack
  Priority: 98
  Enemy: { Boss: true }
  Reach: false
  MoveTo: reachable                    # to where it could reach us
- Name: no_rude_attack_hold
  Priority: 97
  Enemy: { Boss: true }
  Reach: false
  Hold: true                           # nowhere: don't hit it at all
```

## A bolt by element at what is on the party

```yaml
- Name: bolt_my_attacker
  Priority: 43
  Cast: [MG_COLDBOLT, MG_FIREBOLT, MG_LIGHTNINGBOLT, WZ_EARTHSPIKE, MG_SOULSTRIKE]
  Target: { Enemy: attacking, Who: self }
  When: self_sp_pct_ge15
- Name: bolt_the_boss
  Priority: 41
  Cast: [MG_COLDBOLT, MG_FIREBOLT, MG_LIGHTNINGBOLT, WZ_EARTHSPIKE, MG_SOULSTRIKE]
  Target: { Enemy: boss }
  When: self_sp_pct_ge15
```

A `Cast:` list casts the one the target is weakest to; ties go to list order.
Selectors only look within the spell's range, so the caster never aims at
something across the screen, nor at a monster nobody is fighting.

## Area spells only on a pack

```yaml
- Name: aoe_the_pack
  Priority: 45
  Cast: [WZ_METEOR, WZ_STORMGUST, WZ_VERMILION, WZ_HEAVENDRIVE]
  Target: { Enemy: attacking }
  Count: { Enemy: attacking, Around: target, Range: 3, AtLeast: 3 }
  When: self_sp_pct_ge30
  Cooldown: 5000
```

## Go for the boss, but take slaves off the healer

```yaml
- Name: guard_the_healer
  Priority: 57
  Target: { Enemy: attacking, Job: Priest }
  SetTarget: true
  OnePerParty: true                    # one of the melee, not all of them
- Name: focus_boss
  Priority: 30
  Target: { Enemy: boss, Range: 12 }
  SetTarget: true
```

`SetTarget` only chooses the target; the engine (or a skill rule) does the
hitting.

## Turn heals on the undead

In a plan for `Mobs: [{ Race: Undead }, { Element: Undead }]`:

```yaml
- Name: resurrect_the_undead           # destroys it; a boss shrugs it off
  Priority: 66
  Cast: ALL_RESURRECTION
  Target: { Enemy: attacking, Race: Undead }
  When: [not_enemy_is_boss, self_sp_ge150]
- Name: heal_the_undead
  Priority: 61
  Cast: AL_HEAL
  Target: { Enemy: attacking, Race: Undead }
  When: self_sp_ge120
```

Sanctuary is never placed where a living (not undead, not demon) monster would
stand in it and be healed.

## Phases on the boss's HP

```yaml
- Mob: PHREEONI
  Encounter: true
  Jobs:
    - Job: All
      Start: opening
      Strategies:
        - Name: opening
          Rules:
            - Name: to_stone
              Target: { Enemy: boss }          # ask about the boss, not a slave
              When: enemy_hp_pct_lt80
              Switch: stone
              Say: "It's at 80%, petrify from here on."
        - Name: stone
          Rules:
            - Name: to_last
              Target: { Enemy: boss }
              When: enemy_hp_pct_lt30
              Switch: last
        - Name: last
          Rules: [...]
```

## React to a cast

```yaml
- Name: meteor_the_slaves
  Priority: 85
  On: { Event: casts, Skill: NPC_SUMMONSLAVE, Within: 10000 }
  Cast: WZ_METEOR
  Target: source                       # the boss: a ground spell lands at its feet
  Count: { Enemy: slaves, Around: target, Range: 5, AtLeast: 3 }
```

The event opens a window, here 10 s. The rule fires once within it, as soon as
its other conditions hold: here, once three slaves stand around the boss. Make
the window longer than the companion's own longest cast.

## Fall back when the healer is down

```yaml
      Start: fight
      Rules:
        - Name: healer_down
          Priority: 105
          On: party_member_died
          Present: { Ally: dead, Job: Priest }       # a Priest died...
          Absent: { Ally: nearest, Job: Priest }     # ...and no other is up
          Switch: fallback
      Strategies:
        - Name: fight
        - Name: fallback
          Rotation: false
          Rules:
            - { Name: healer_back, Priority: 103, Target: { Ally: nearest, Job: Priest }, Switch: fight }
            - { Name: to_owner, Priority: 102, Retreat: owner }
            - { Name: stand, Priority: 101, Hold: true }
```

## Ask another companion for something

The one asking:

```yaml
- Name: ask_for_kyrie
  Priority: 30
  When: self_hp_pct_ge90
  Signal: kyrie_me
  Cooldown: 6000
```

The one answering:

```yaml
- Name: kyrie_on_request
  Priority: 90
  On: { Event: signal, Name: kyrie_me, Within: 4000 }
  Target: event                        # who asked
  When: not_ally_kyrie
  Cast: PR_KYRIE
```

Signals reach the other companions of the party. The Stalactic Golem duo in
companion-tactics uses this pair.

## Answer the player in party chat

```yaml
- Name: wall_on_request
  Priority: 70
  On: { Event: party_chat, Match: "wall me" }
  Cast: MG_SAFETYWALL
  Target: event                        # who said it
  Say: "Wall on {ally}!"
```

## Only these skills at a boss

On the job entry:

```yaml
- Mob: Boss
  Jobs:
    - Job: Knight
      Allow: [KN_PIERCE, KN_BOWLINGBASH, KN_TWOHANDQUICKEN]
```

The engine then casts only these on its own near a boss. `Allow: []` means
nothing: only the plan's rules cast. To forbid one skill everywhere, use
`Ban: [MG_FIREWALL]`. (A Knight allowlist is an illustration; no example mod
has one.)

## Casters never melee

```yaml
- Mob: All
  Jobs:
    - Job: [Priest, Wizard, Sage]
      For: all                         # the AI characters around the world too
      Attack: false
    - Job: [Acolyte, Mage]
      Exact: true                      # not the Monks built on the Acolyte
      For: all
      Attack: false
```

## Do one role rule differently for one boss

The role's `stay_back` keeps a healer 5 cells off; the slow golem only needs 4:

```yaml
- Mob: STALACTIC_GOLEM
  Encounter: true
  Jobs:
    - Job: Priest
      Disable: [stay_back]             # the role's rule of that name
      Rules:
        - Name: stay_back              # this plan's own takes its place
          Priority: 74
          Target: { Enemy: boss, Range: 14 }
          KeepDistance: 4
```

## Regular AI characters: area spells only for packs

```yaml
- Mob: All
  Jobs:
    - Job: Wizard
      Build: shells_aoe
      For: shells
      Start: single
      Strategies:
        - Name: single
          Ban: [WZ_STORMGUST, WZ_METEOR, WZ_VERMILION, WZ_HEAVENDRIVE]
          Rules:
            - { Name: pack, Count: { Around: target, Range: 4, AtLeast: 3 }, Switch: pack }
        - Name: pack
          Rules:
            - { Name: no_pack, Count: { Around: target, Range: 4, Below: 3 }, Switch: single }
```
