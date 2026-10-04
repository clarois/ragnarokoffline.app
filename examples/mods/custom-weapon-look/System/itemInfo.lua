-- What the client calls item 50101 and how it looks.
--
-- ClassNum is the weapon's look: 5001, which System/weapontable.lub names
-- "_jade" (the sprites under data/sprite/human/) and says attacks like a
-- dagger. The icon and the dropped picture borrow the stock Knife's (나이프).
tbl = {
	[50101] = {
		unidentifiedDisplayName = "Dagger",
		unidentifiedResourceName = "나이프",
		unidentifiedDescriptionName = { "A dagger with a green-tinged blade." },
		identifiedDisplayName = "Jade Dagger",
		identifiedResourceName = "나이프",
		identifiedDescriptionName = {
			"A dagger whose blade has the green of old jade.",
			"Class : ^777777Dagger^000000",
			"Attack : ^77777770^000000",
			"Weight : ^7777776^000000",
			"Weapon Level : ^7777772^000000",
			"Requirement : ^777777None^000000"
		},
		slotCount = 2,
		ClassNum = 5001
	}
}
