-- What the client calls item 50071 and the art it draws. Added to the client's
-- customItemInfo ahead of the base table (see docs/MODDING.md, System/), so a
-- table holding only this one item is all it needs -- no footer, the client
-- registers every entry in `tbl` itself. Saved as UTF-8.
--
-- identifiedResourceName is the ART, written in Korean the way the client names
-- it. 돋보기 is the Magnifier's icon and sprite, borrowed here so the item needs
-- no art of its own. Swap it for another item's Korean resource name, or ship
-- your own bitmap and sprite, to change the look; a name that matches no file
-- shows an apple icon and is logged in state/assets/logs/missing-files.log.
tbl = {
	[50071] = {
		unidentifiedDisplayName = "Bounty Marker",
		unidentifiedResourceName = "돋보기",
		unidentifiedDescriptionName = {
			"A blank writ for naming a quarry."
		},
		identifiedDisplayName = "Bounty Marker",
		identifiedResourceName = "돋보기",
		identifiedDescriptionName = {
			"Use it, then click a monster to place a bounty on its kind.",
			"Choose one of its drops; kill enough of them and that drop",
			"becomes a ^0000FFguaranteed^000000 reward.",
			"^ffffff_^000000",
			"Your progress is saved on this character.",
			"^ffffff_^000000",
			"Weight: ^777777 1 ^000000"
		},
		slotCount = 0,
		ClassNum = 0
	}
}
