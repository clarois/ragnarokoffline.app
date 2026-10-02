-- What the client calls the two new items and what it draws for them. Only
-- these two: the app adds this table in front of the client's own
-- (see examples/mods/custom-item).
tbl = {
	[50102] = {
		unidentifiedDisplayName = "Ribbon",
		unidentifiedResourceName = "리본",
		unidentifiedDescriptionName = { "A ribbon that shimmers faintly." },
		identifiedDisplayName = "Moon Ribbon",
		identifiedResourceName = "리본",
		identifiedDescriptionName = {
			"A ribbon spun from moonlight.",
			"MDEF +5",
			"When hit below 30% HP, 20% chance to cast ^0000FFHeal^000000 Lv 5 on yourself.",
			"Class: ^777777Headgear^000000",
			"Defense: ^7777772^000000",
			"Location: ^777777Upper^000000",
			"Weight: ^77777710^000000"
		},
		slotCount = 0,
		ClassNum = 5001
	},
	[50103] = {
		unidentifiedDisplayName = "Card",
		unidentifiedResourceName = "이름없는카드",
		unidentifiedDescriptionName = { "" },
		identifiedDisplayName = "Lunar Poring Card",
		identifiedResourceName = "이름없는카드",
		identifiedDescriptionName = {
			"When attacking, 5% chance to cast ^FF0000Fire Bolt^000000 Lv 3 on the target.",
			"Class: ^777777Card^000000",
			"Compound on: ^777777Armor^000000",
			"Weight: ^7777771^000000"
		},
		slotCount = 0,
		ClassNum = 0
	},
}
