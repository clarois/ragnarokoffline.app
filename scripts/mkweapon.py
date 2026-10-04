#!/usr/bin/env python3
"""Make a new weapon look: a stock weapon's sprites for every class, recoloured.

    scripts/mkweapon.py --type shortsword --name crimson --look 5001 --hue 150 \
        --mod my-mod

with the game running (it reads the stock sprites from the app, at
http://127.0.0.1:3338). It writes, inside my-mod:

    data/sprite/human/<class>/<class>_<sex>_crimson.spr and .act
        one pair per class and sex that has a sprite for that weapon type
    System/weapontable.lub
        WeaponNameTable[5001] = "_crimson"       the name above
        Expansion_Weapon_IDs[5001] = 1           attack like a dagger

and an item uses the look by `ClassNum = 5001` in its System/itemInfo.lua entry.
See docs/MODDING.md, "A new weapon look".

Why it works this way
---------------------
A weapon is drawn as an extra layer over the character's body, animated frame
for frame with it. So a weapon's sprite is not one file but one per class (and
sex), in that class's own folder, each matching that class's own attack, walk
and sit animations. Drawing that by hand is a big job. Recolouring keeps every
frame and every .act exactly as the stock weapon has them, so the new look moves
correctly on every class at once; only the colours change.

`--hue` turns the colour wheel by that many degrees (0-360), `--saturation` and
`--lightness` scale those (1.0 = unchanged). Only the palette changes, never the
pictures.

The look id: official weapons use 0-102, and the client reads a mod's names
only above that (roBrowserLegacy#61), so pick 103 or more; this guide uses
5000-5999. Python 3, no packages.
"""

import argparse
import colorsys
import os
import sys
import urllib.parse
import urllib.request

# The client's weapon folders, one per class line and mount (roBrowserLegacy
# src/DB/Jobs/WeaponJobTable.js), and its weapon types (DB/Items/WeaponType.js,
# WeaponTable.js): name -> (type id, stock sprite suffix).
FOLDERS = ["초보자", "검사", "마법사", "궁수", "성직자", "상인", "도둑", "기사", "프리스트", "위저드", "제철공", "헌터", "어세신", "페코페코_기사", "크루세이더", "몽크", "세이지", "로그", "연금술사", "바드", "무희", "신페코크루세이더", "결혼", "슈퍼노비스", "건너", "닌자", "산타", "여름", "태권소년", "권성", "권성융합", "소울링커", "레인져늑대", "마도기어", "노비스포링", "페코건너", "페코검사", "두꺼비소울링커", "화이트스미스멧돼지", "상인멧돼지", "제네릭멧돼지", "크리에이터멧돼지", "타조궁수", "권성포링", "몽크알파카", "복사알파카", "슈라알파카", "슈퍼노비스포링", "아크비숍알파카", "여우마법사", "여우세이지", "여우소서러", "여우워록", "여우위저드", "여우프로페서", "여우하이위저드", "연금술사멧돼지", "제철공멧돼지", "챔피온알파카", "켈베로스길로틴크로스", "켈베로스도둑", "켈베로스로그", "켈베로스쉐도우체이서", "켈베로스스토커", "켈베로스어쎄신", "켈베로스어쎄신크로스", "타조무희", "타조민스트럴", "타조바드", "타조스나이퍼", "타조원더러", "타조짚시", "타조크라운", "타조헌터", "태권소년포링", "프리스트알파카", "하이프리스트알파카", "미케닉멧돼지", "타조레인져", "사자기사", "사자로드나이트", "사자로얄가드", "사자룬나이트", "사자크루세이더", "사자팔라딘", "kagerou", "oboro", "frog_kagerou", "frog_oboro", "rebellion", "peco_rebellion", "summoner", "성제", "소울리퍼", "해태성제", "sky_emperor", "soul_ascetic", "shinkiro", "shiranui", "night_watch", "hyper_novice", "spirit_handler", "sky_emperor2", "druid", "karnos", "alitea", "werewolf", "wereraptor", "druid_riding", "karnos_riding", "alitea_riding", "아크비숍"]
TYPES = {"shortsword": [1, "_단검"], "sword": [2, "_검"], "twohandsword": [3, "_검"], "spear": [4, "_창"], "twohandspear": [5, "_창"], "axe": [6, "_도끼"], "twohandaxe": [7, "_도끼"], "mace": [8, "_클럽"], "twohandmace": [9, "_클럽"], "rod": [10, "_롯드"], "bow": [11, "_활"], "knukle": [12, "_너클"], "instrument": [13, "_악기"], "whip": [14, "_채찍"], "book": [15, "_책"], "katar": [16, "_카타르_카타르"], "gun_handgun": [17, "_권총"], "gun_rifle": [18, "_기관총"], "gun_gatling": [19, "_기관총"], "gun_shotgun": [20, "_기관총"], "gun_granade": [21, "_기관총"], "syuriken": [22, "_수리검"], "twohandrod": [23, "_롯드"], "shortsword_shortsword": [25, "_단검_단검"], "sword_sword": [26, "_검_검"], "axe_axe": [27, "_도끼_도끼"], "shortsword_sword": [28, "_단검_검"], "shortsword_axe": [29, "_단검_도끼"], "sword_axe": [30, "_검_도끼"]}

SEXES = ["남", "여"]


def client_path(rel):
    """A client path written in Korean -> the URL path the app serves it at.

    The client names files in CP949 bytes, read as Latin-1; the app's URLs are
    those characters UTF-8 encoded."""
    return urllib.parse.quote(rel.encode("cp949").decode("latin-1").encode("utf-8"), safe="/")


def fetch(base, rel):
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/" + client_path(rel), timeout=10) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except urllib.error.URLError as e:
        sys.exit(f"could not reach the game at {base}: {e.reason}. Start Ragnarok Offline first, or pass --from.")


def recolour(spr, hue, saturation, lightness):
    """The same .spr with its palette (the last 1024 bytes) turned."""
    if spr[:2] != b"SP":
        raise ValueError("not a .spr file")
    if spr[2] / 10 + spr[3] <= 1.0:
        raise ValueError("a version 1.0 .spr has no palette to recolour")
    out = bytearray(spr)
    pal = len(out) - 1024
    for i in range(1, 256):  # colour 0 is the transparent background
        r, g, b = out[pal + i * 4: pal + i * 4 + 3]
        h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        h = (h + hue / 360) % 1.0
        s = min(1.0, s * saturation)
        l = min(1.0, l * lightness)
        nr, ng, nb = colorsys.hls_to_rgb(h, l, s)
        out[pal + i * 4: pal + i * 4 + 3] = bytes(round(c * 255) for c in (nr, ng, nb))
    return bytes(out)


def write_table(path, look, name, type_id):
    """Add (or replace) this look in the mod's System/weapontable.lub."""
    rows = {}
    if os.path.exists(path):
        import re
        text = open(path, encoding="utf-8").read()
        for m in re.finditer(r'\[(\d+)\]\s*=\s*"([^"]*)"', text.split("Expansion_Weapon_IDs")[0]):
            rows.setdefault(int(m.group(1)), [m.group(2), None])[0] = m.group(2)
        if "Expansion_Weapon_IDs" in text:
            for m in re.finditer(r"\[(\d+)\]\s*=\s*(\d+)", text.split("Expansion_Weapon_IDs")[1]):
                rows.setdefault(int(m.group(1)), [None, None])[1] = int(m.group(2))
    rows[look] = [name, type_id]
    lines = ["-- Written by scripts/mkweapon.py: each new weapon look's sprite name, and",
             "-- the weapon type it attacks like. Only these rows: the app adds them to",
             "-- the client's own table.",
             "WeaponNameTable = {"]
    lines += [f'\t[{k}] = "{v[0]}",' for k, v in sorted(rows.items()) if v[0] is not None]
    lines += ["}", "", "Expansion_Weapon_IDs = {"]
    lines += [f"\t[{k}] = {v[1]}," for k, v in sorted(rows.items()) if v[1] is not None]
    lines += ["}", ""]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # newline="\n": the same file on every system, not CRLF on Windows.
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--type", required=True, choices=sorted(TYPES), help="the stock weapon type to start from")
    ap.add_argument("--name", required=True, help="your look's name, ASCII, e.g. crimson")
    ap.add_argument("--look", type=int, required=True, help="the look id items will use as ClassNum (103 or more; 5000-5999 suggested)")
    ap.add_argument("--mod", required=True, help="the mod folder to write into")
    ap.add_argument("--hue", type=float, default=0, help="degrees to turn the colours (0-360)")
    ap.add_argument("--saturation", type=float, default=1.0)
    ap.add_argument("--lightness", type=float, default=1.0)
    ap.add_argument("--from", dest="base", default="http://127.0.0.1:3338", help="where the game serves its files")
    args = ap.parse_args()
    if args.look < 103:
        sys.exit("--look must be 103 or more: 0-102 are the official weapons")
    if not args.name.replace("_", "").isalnum() or not args.name.isascii():
        sys.exit("--name: letters, digits and _ only")
    type_id, stock = TYPES[args.type]
    made = 0
    for folder in FOLDERS:
        for sex in SEXES:
            src = f"data/sprite/인간족/{folder}/{folder}_{sex}{stock}"
            spr = fetch(args.base, src + ".spr")
            act = fetch(args.base, src + ".act") if spr else None
            if not spr or not act:
                continue
            dst = os.path.join(args.mod, "data", "sprite", "human", folder, f"{folder}_{sex}_{args.name}")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst + ".spr", "wb") as f:
                f.write(recolour(spr, args.hue, args.saturation, args.lightness))
            with open(dst + ".act", "wb") as f:
                f.write(act)
            made += 1
    if made == 0:
        sys.exit(f"no {args.type} sprites found at {args.base}: is the game running, with your client?")
    write_table(os.path.join(args.mod, "System", "weapontable.lub"), args.look, "_" + args.name, type_id)
    print(f"wrote {made} sprite pairs and System/weapontable.lub: look {args.look} = _{args.name}, attacks like a {args.type}")


if __name__ == "__main__":
    main()
