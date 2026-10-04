#!/usr/bin/env python3
"""Make a Ragnarok sprite (.spr + .act) from PNG pictures, for an NPC or a monster.

    scripts/mksprite.py my_npc.png --out my-mod/data/sprite/npc/my_npc
    scripts/mksprite.py walk1.png walk2.png walk3.png --out .../my_npc --delay 200

writes `my_npc.spr` and `my_npc.act` next to each other. Python 3 only, no
packages: it reads PNG itself.

What it makes
-------------
- **The .spr** holds the pictures: one frame per PNG, palette-indexed (version
  2.0, the format every client and tool reads). Colours are reduced to 255;
  fully transparent pixels -- and anything with alpha under 128 -- become the
  background, palette index 0. Pixel art with a few dozen colours comes through
  exactly; a painted picture with thousands of colours is reduced, so give it
  flat colours if you want it crisp.
- **The .act** says how to show them: eight actions, one per facing direction
  (0 = south, then clockwise), each playing the frames in order. Every
  direction shows the same pictures, so the sprite looks the same whichever way
  the NPC faces. The picture is placed with its bottom edge on the NPC's cell,
  centred, which is where a standing character's feet go.

That is what an NPC needs: the client shows an NPC's action 0 (standing) in the
direction its script gives. A monster also walks, attacks, is hit and dies; this
writes the standing loop into all five of those actions (40 in all, 8 each) so a
monster made this way is visible doing everything, just without separate art for
each. For real per-direction or per-action art, start from this file and edit it
in a sprite editor (see docs/MODDING.md, "A new NPC with its own sprite").

Sizes: keep NPCs around 40-60 px wide and 70-110 px tall, which is what the
stock ones are. Larger works; the client draws it at its size.
"""

import argparse
import os
import struct
import sys
import zlib


def read_png(path):
    """Return (width, height, rows of (r, g, b, a) tuples) for an 8-bit PNG."""
    with open(path, 'rb') as f:
        data = f.read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        sys.exit(f"{path}: not a PNG file")
    pos = 8
    width = height = depth = ctype = interlace = None
    idat = b''
    palette = []
    trns = b''
    while pos < len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b'IHDR':
            width, height, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
        elif kind == b'PLTE':
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif kind == b'tRNS':
            trns = chunk
        elif kind == b'IDAT':
            idat += chunk
        elif kind == b'IEND':
            break
    if depth != 8 or interlace != 0 or ctype not in (2, 3, 6):
        sys.exit(f"{path}: save it as an 8-bit RGB, RGBA or palette PNG without interlacing")
    channels = {2: 3, 3: 1, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = width * channels
    rows, prev = [], bytearray(stride)
    i = 0
    for _ in range(height):
        kind = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - channels] if x >= channels else 0
            b = prev[x]
            c = prev[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + a) & 255
            elif kind == 2:
                line[x] = (line[x] + b) & 255
            elif kind == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        if ctype == 6:
            rows.append([tuple(line[x:x + 4]) for x in range(0, stride, 4)])
        elif ctype == 2:
            rows.append([tuple(line[x:x + 3]) + (255,) for x in range(0, stride, 3)])
        else:
            rows.append([palette[v] + ((trns[v] if v < len(trns) else 255),) for v in line])
    return width, height, rows


def build_palette(images):
    """Up to 255 colours shared by every frame; index 0 is the background."""
    counts = {}
    for _, _, rows in images:
        for row in rows:
            for r, g, b, a in row:
                if a >= 128:
                    counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    colours = sorted(counts, key=counts.get, reverse=True)
    if len(colours) > 255:
        # Too many: keep the 255 most used, and map the rest to the nearest.
        print(f"note: {len(colours)} colours reduced to 255", file=sys.stderr)
        colours = colours[:255]
    return colours


def nearest(colour, palette, cache):
    if colour in cache:
        return cache[colour]
    r, g, b = colour
    best = min(range(len(palette)), key=lambda i: (palette[i][0] - r) ** 2 + (palette[i][1] - g) ** 2 + (palette[i][2] - b) ** 2)
    cache[colour] = best + 1
    return best + 1


def write_spr(path, images, palette):
    out = bytearray(b'SP')
    out += bytes([0, 2])  # version 2.0: uncompressed palette frames
    out += struct.pack('<HH', len(images), 0)
    cache = {c: i + 1 for i, c in enumerate(palette)}
    for width, height, rows in images:
        out += struct.pack('<HH', width, height)
        for row in rows:
            for r, g, b, a in row:
                out.append(0 if a < 128 else nearest((r, g, b), palette, cache))
    pal = bytearray(1024)
    pal[0:4] = bytes([255, 0, 255, 0])  # the background: magenta, as the stock files use
    for i, (r, g, b) in enumerate(palette):
        pal[(i + 1) * 4:(i + 2) * 4] = bytes([r, g, b, 0])
    out += pal
    with open(path, 'wb') as f:
        f.write(out)


def write_act(path, images, actions, delay_ms):
    out = bytearray(b'AC')
    out += bytes([1, 2])  # version 2.1: version 2.0's layers plus sounds
    out += struct.pack('<H', actions * 8)
    out += bytes(10)
    for _ in range(actions * 8):
        out += struct.pack('<I', len(images))
        for index, (width, height, _) in enumerate(images):
            out += bytes(32)                       # unused rectangles
            out += struct.pack('<I', 1)            # one layer
            # Centred, bottom edge on the cell: the layer position is the
            # picture's centre relative to the character's feet.
            out += struct.pack('<iiii', 0, -(height // 2), index, 0)
            out += bytes([255, 255, 255, 255])     # no tint
            out += struct.pack('<f', 1.0)          # scale
            out += struct.pack('<ii', 0, 0)        # angle, frame type (palette)
            out += struct.pack('<i', -1)           # no sound
    out += struct.pack('<i', 0)                    # no sound files
    with open(path, 'wb') as f:
        f.write(out)
    # Version 2.1 reads delays only from 2.2 on; the client's default (150 ms
    # per frame) applies. --delay is honoured through version 2.2 below.
    if delay_ms != 150:
        with open(path, 'r+b') as f:
            body = bytearray(f.read())
            body[2:4] = bytes([2, 2])  # 2.2: a delay per action follows
            body += b''.join(struct.pack('<f', delay_ms / 25.0) for _ in range(actions * 8))
            f.seek(0)
            f.write(body)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('png', nargs='+', help='one PNG per animation frame, in order')
    ap.add_argument('--out', required=True, help='output path without extension, e.g. my-mod/data/sprite/npc/my_npc')
    ap.add_argument('--monster', action='store_true', help='write 5 actions (stand, walk, attack, hit, die) instead of 1')
    ap.add_argument('--delay', type=int, default=150, help='milliseconds per frame (default 150)')
    args = ap.parse_args()
    images = [read_png(p) for p in args.png]
    palette = build_palette(images)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    write_spr(args.out + '.spr', images, palette)
    write_act(args.out + '.act', images, 5 if args.monster else 1, args.delay)
    w, h, _ = images[0]
    print(f"wrote {args.out}.spr and {args.out}.act: {len(images)} frame(s), {w}x{h}, {len(palette)} colours")


if __name__ == '__main__':
    main()
