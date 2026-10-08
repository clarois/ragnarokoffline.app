## 1.5.0

### Hunted supply (new, off by default)
- What only monsters drop reaches the sell stalls only once someone has found it. Fake hunters roam the world's fields and dungeons around the clock: mostly solo players spread over every map, some duos and trios, and full parties farming the known spots. Kills follow each map's spawns and respawn timers, drops follow the server's own drop rates.
- Switch it on with **Hunted supply: parties** (how much they hunt, in full parties' worth; 20 is a good start). Fewer hunt at night, more in the evening and at weekends, and every map gets its turn.
- MvPs die at most once a day each, never faster than they respawn, and their loot reaches the market too.
- Loot leaves the market again: **How long loot stays** sets the half-life, 5 days by default. What players use up (ores, stones, herbs, potions) goes in half that time, equipment lasts three times as long, cards and MvP loot five times.
- Scarcity sets prices: an item costs up to 25 % more as it runs out and up to 15 % less when there is plenty.
- Fewer sellers while stock is low: about a third of the sell stalls stand on an empty market, all of them once it has filled up.
- Buying from a stall takes from the supply, and selling into a buying store puts it back.
- The market starts empty and fills up as the hunters go; the time the server was off is hunted too.
- What NPCs sell and what players make (potions, forged, refined and carded gear) is always there.
- GMs: `@supply` shows the hunters out, the last MvP and the stock; `@supply hunt <hours>` fast-forwards; `@supply reset [empty|filled]` starts over.
- Needs app 1.5.2 for the supply, and app 1.5.4 for the stalls to follow it.

### Market
- Market news: 11 new events (a monster raid on Prontera, a blight on the World Tree, a fashion contest, an arrow shortage, the Sages' elemental research, bounty week, a collector's card sale, an ore strike, a herb bloom, two more monster migrations), 31 in all.
- The server announces market news as it starts and when it ends. **Market news** is now 0 (off), 1 (board only) or 2 (announced, the default); a server that had it switched off gets the default once.
- Settings → Mods → Reset data… starts the whole market over: the supply and the dynamic market's prices. The first start with the hunted supply on resets the prices once.

- War of Emperium moves the market: when WoE starts, potions, gems and bottles go up 10–20 % and drift back afterwards; announced at **Market news** 2.

### Street
- The street follows the clock: **Sell stalls** and **Buy stalls** are the most that stand, in the evening; the morning has the fewest, the night a core of AFK merchants. Shouts follow the time of day too, frequent in the evening and seldom at night.
- Stalls change every 2 hours by default (was 4), so new stock reaches the street sooner.

### Fixes
- The festival no longer makes Elunium and Oridecon cheaper: its "junk loot" is monster parts now.
- The merchant clearance sells everyday goods only, not WoE potions, boxes or GM scrolls.
- Monster migrations no longer cancel out on loot both dungeons share (Magma and Abyss Lake's dragon parts).

## 1.4.0
- New: a **dynamic market** (off by default). Prices follow trades and drift back to the price list: buying from the stalls drives a price up, selling to the buyers drives it down, and the customers at your own stall nudge it. Related items move together, and every move fades with **Price recovery** (72 hours by default), downtime included.
- **Market news** about once a week moves a group of items for a few days: a War of Emperium season, refining fever, a card craze, a Glast Heim purge, monsters migrating between dungeons and more (20 events).
- A **market board** at Prontera (131, 218) shows the news and the items rising and falling most.
- GMs: `@market` lists the movers, shows one item, starts news or resets the prices.

## 1.3.0
- New: **customers for your own stalls** (off by default). Customers buy from the vending stalls you open, online or on @autotrade, and sellers bring loot to your buying stores, by your price against the market and by demand. Each has a pace setting.
- Customers keep coming while the server is off (up to 48 hours), and the Merchant Guild mails you what your stall did.
- The mod has its own settings page, with each pace's rate table beside it.

## 1.2.0
- Buying stores now mostly buy what you bring home: a buyer per dungeon and per popular leveling field, plus junk, berries, quest turn-ins and dyestuffs. Loot buyers pay 75–95 % of the low end of the market price. No more buyers of low-level cards.
- Old and Mystical Card Albums are priced properly (they were capped at 10,000z by a test shop).
- Two more sell lanes east of the fountain; both markets fill one lane at a time, like a real street. Sell and buy stalls default to 30 each, up to 100.
- Buyers never get "SALE" signs, and the dyestuff stall says so on every sign.

## 1.1.0
- More sidewalks: sell stalls also on the southern sidewalks, buying stores also on the two rows west of the fountain.
- The common materials always have buyers: two for upgrade ores, one each for crafting materials, elemental stones, herbs and alchemy materials.

## 1.0.0
- A living player market on Prontera's main road: fake players run real vending stalls and buying stores, with themes from potions and cards to class gear, refined and carded equipment and every dungeon's loot.
- Buying stores on the outer sidewalks buy ores, cards, boxes, loot, potions and gems from you.
- Prices follow kRO's player market, stalls undercut each other, sell out, pack up and make room for others. The price list is a CSV you can edit in a spreadsheet.
- A pre-renewal set with its own items and prices.
- Settings for how many stalls stand, how often they change, the price level, the population limit and their shouts.
