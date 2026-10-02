-- steal-cards: Thief Steal gives cards an independent roll.
--
-- rAthena's pc_steal_item walks the mob's drops in slot order and stops at
-- the first roll that passes, and the card is almost always the last slot.
-- So without this hook, Steal only reaches the card when every earlier drop
-- has missed. A Jellopy at 1.5x+ rates ends up at 100% and locks the card
-- away for good; even at 1x, the card sits behind five other rolls and
-- comes out at about 0.05% per successful steal.
--
-- The on_steal hook rolls cards first, independently, at the stock card
-- rate. If any card roll succeeds the player gets the card; otherwise the
-- hook returns nil and rAthena's slot-order loop runs as usual, so Jellopy
-- and Mucus are unaffected.
--
-- The accompanying db/mob_db.yml unprotects the card slot on every non-MVP
-- monster that drops one; this hook only sees drops that are already
-- stealable, so without that override the card never reaches c.drops.

skill("TF_STEAL", {
  on_steal = function(c)
    for _, drop in ipairs(c.drops) do
      if drop.is_card and c:chance(drop.rate) then
        return drop
      end
    end
  end,
})
