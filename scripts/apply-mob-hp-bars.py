#!/usr/bin/env python3
"""Send every nearby player a monster's HP bar on sight, not only its attackers.

The bar reaches a client as 0x977 (ZC_HP_INFO), which clif_getareachar sends
only to players in the mob's damage log: a mob nobody has hit yet reads -1/-1
to everyone watching it, which leaves an AI agent (or any HP-bar client)
blind until after it engages. Send it on sight instead; the damage-time and
heal-time sends still refresh the bar for whoever is in the log.

Anchor-based, no line offsets (same approach as apply-party-chat-hook.py).
Idempotent: a source already carrying the new comment is left alone.
Usage: apply-mob-hp-bars.py <path/to/clif.cpp>
"""
from pathlib import Path
import sys

MARKER = "HP before engaging"

OLD = """#if PACKETVER >= 20120404
			if (battle_config.monster_hp_bars_info && !map_getmapflag(bl->m, MF_HIDEMOBHPBAR)) {
				// Must show hp bar to all char who already hit the mob.
				for( const auto& entry : md->dmglog ){
					if( entry.id == sd->status.char_id ){
						clif_monster_hp_bar(md, sd->fd);
					}
				}
			}
#endif"""

NEW = """#if PACKETVER >= 20120404
			if (battle_config.monster_hp_bars_info && !map_getmapflag(bl->m, MF_HIDEMOBHPBAR)) {
				// Show the bar to every player who can see the mob, not only to
				// those in its damage log: a client (or an AI agent) can read
				// HP before engaging, and damage events keep it fresh once
				// fighting starts.
				clif_monster_hp_bar(md, sd->fd);
			}
#endif"""


def main() -> None:
    path = Path(sys.argv[1])
    source = path.read_text(encoding="utf-8")
    if MARKER in source:
        return  # already applied
    # A Windows checkout can hold CRLF even though the blob is LF; match the
    # file's own newline convention so the anchor still finds it.
    nl = "\r\n" if "\r\n" in source else "\n"
    old, new = OLD.replace("\n", nl), NEW.replace("\n", nl)
    if source.count(old) != 1:
        raise SystemExit(
            f"mob HP bar anchor expected exactly once, found {source.count(old)}: {path} "
            "(rAthena has changed under this patch)"
        )
    path.write_text(source.replace(old, new, 1), encoding="utf-8", newline="")


if __name__ == "__main__":
    main()
