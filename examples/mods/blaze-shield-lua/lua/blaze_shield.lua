-- Blaze Shield (NJ_KAENSIN): the Ninja's ring of fire pillars.
--
-- rAthena applies HP/SP drain bonuses (bHPDrainValue, bSPDrainValue and the
-- rest) and Hylozoist Card's bClassChange to weapon attacks only, so a Ninja
-- channelling Blaze Shield never sees either. This makes every pillar hit
-- honour them.
--
-- It used to take two C++ changes to the server (Flux159/rathena #5 and #6).

local MOD = "blaze-shield-lua"

skill("NJ_KAENSIN", {
  on_hit = function(c)
    if c.caster.kind ~= "pc" or c.damage <= 0 then
      return
    end

    if setting(MOD, "drain", true) then
      c:drain()
    end

    -- Hylozoist Card is `bonus bClassChange,100`: 100 in 10000, 1%.
    -- c:polymorph() leaves bosses and status-immune monsters alone itself;
    -- the check here only saves the roll.
    if setting(MOD, "polymorph", true) and c.target.kind == "mob" and not c.target.boss
        and c.caster.classchange > 0 and c:chance(c.caster.classchange) then
      c:polymorph()
    end

    if setting(MOD, "log_hits", false) then
      log(c.caster.name, "hit", c.target.name, "for", c.damage,
          "SP", c.caster.sp, "classchange", c.caster.classchange)
    end
  end,
})
