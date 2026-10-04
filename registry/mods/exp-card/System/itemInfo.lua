-- What the client calls items 50051..50070 and the art it draws. Added to
-- the client's customItemInfo ahead of the base table (see docs/MODDING.md,
-- System/), so a table holding these twenty entries is all it needs -- the
-- client registers every entry in `tbl` itself. Saved as UTF-8.
--
-- The two card families share their shape (weight, resource, description
-- layout), so this is a small loop over levels 1..10 instead of twenty
-- copy-pasted blocks. The layout follows the stock English tooltips (see
-- Awakening Potion, 656): flavour line, rule, ^0000CC-labelled fields, rule,
-- Requirement block.
--
-- No exp amount appears here on purpose. Each card's exp is scaled by the
-- server's Base/Job EXP rate at the moment it is used (db/item_db.yml), and
-- this file is static on the client, so any number written here would be
-- wrong at every rate but 1x. The message shown after using a card prints
-- the exact amount granted.
--
-- identifiedResourceName is the ART, written in Korean the way the client
-- names it. 스페어카드 ("spare card") is item 779's resource -- the
-- blank-backed card used by the "Blank Nibble Leon Card" item, and the
-- closest thing the shipped GRF has to a generic back-of-a-card look.
-- Verified present: the Magnifier (돋보기) and the Poring Card art
-- (포링카드) are NOT both in the GRF -- Poring Card's bitmaps are
-- absent in this distribution and the client logs "Can't get file" for
-- data/texture/.../item/Æ÷¸µÄ«µå.bmp. If you retarget, swap for another
-- item's resource name that is actually in the archive, or ship your own
-- bitmap + sprite; a name that matches no file shows an apple icon and
-- is logged in state/assets/logs/missing-files.log.
tbl = {}

local RESOURCE = "스페어카드"

-- desc builds one card's description. kind is "base" or "job"; rate names
-- the server setting that scales it, as the Settings window labels it.
local function desc(level, kind, rate)
	-- Player-level gate for this card, matching EquipLevelMin in
	-- db/item_db.yml: (level - 1) * 10 + 1.
	local requiredLevel = (level - 1) * 10 + 1
	return {
		"A card holding condensed " .. kind .. " experience. Use it to gain " .. kind .. " experience at once.",
		"Higher-level cards grant more experience, and every amount grows with the server's " .. rate .. " rate.",
		"Dropped on a small chance by any monster; tougher monsters drop higher-level cards.",
		"_______________________",
		"^0000CCType:^000000 Usable",
		"^0000CCEffect:^000000 Grants " .. kind .. " experience",
		"^0000CCWeight:^000000 1",
		"_______________________",
		"^0000CCRequirement:^000000",
		"Base Level " .. requiredLevel
	}
end

for level = 1, 10 do
	local baseName = "Base Exp Card Lv" .. level
	local jobName  = "Job Exp Card Lv"  .. level
	local baseDesc = desc(level, "base", "Base EXP")
	local jobDesc  = desc(level, "job", "Job EXP")
	tbl[50050 + level] = {
		unidentifiedDisplayName = baseName,
		unidentifiedResourceName = RESOURCE,
		unidentifiedDescriptionName = baseDesc,
		identifiedDisplayName = baseName,
		identifiedResourceName = RESOURCE,
		identifiedDescriptionName = baseDesc,
		slotCount = 0,
		ClassNum = 0
	}
	tbl[50060 + level] = {
		unidentifiedDisplayName = jobName,
		unidentifiedResourceName = RESOURCE,
		unidentifiedDescriptionName = jobDesc,
		identifiedDisplayName = jobName,
		identifiedResourceName = RESOURCE,
		identifiedDescriptionName = jobDesc,
		slotCount = 0,
		ClassNum = 0
	}
end
