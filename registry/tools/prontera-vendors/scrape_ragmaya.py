#!/usr/bin/env python3
"""Fetch kRO player-market prices from RagMAYA (ragmaya.kr) into prices_kro.json.

    python3 registry/tools/prontera-vendors/scrape_ragmaya.py [--workers 3]

RagMAYA tracks the vending of kRO's official servers and publishes, per item
id (rAthena ids), the median asking price of the last 90 days and how many
listings it is based on. This reads the ids from its sitemap and saves

    { "<item id>": [median, samples, lowest] }     (null, 0, null = no listings)

Already fetched ids are skipped, and progress is saved every 100 items, so it
can be stopped and resumed. Pages are requested compressed (~26 KB each) and
a few at a time with a pause, to stay gentle on a hobby site; its robots.txt
allows these pages.
"""
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "prices_kro.json")
BASE = "https://ragmaya.kr/v2/item/"

SUMMARY = re.compile(r"과거 노점 \(90일\)\|([\d,]+)z\|중앙값 · 표본 \|(\d+)\|건(?:\|· 최저 ([\d,]+)z)?")


def get(url):
    try:
        raw = subprocess.run(["curl", "-s", "-m", "30", "--compressed", "-A", "Mozilla/5.0", url],
                             capture_output=True, timeout=45).stdout
    except subprocess.TimeoutExpired:
        return None
    return raw.decode("utf-8", errors="replace")


def parse(html):
    t = re.sub(r"<script.*?</script>", "", html, flags=re.S)
    t = re.sub(r"<style.*?</style>", "", t, flags=re.S)
    t = re.sub(r"<[^>]*>", "|", t)
    t = re.sub(r"(\|\s*)+", "|", t)
    m = SUMMARY.search(t)
    if not m:
        return [None, 0, None]
    num = lambda s: int(s.replace(",", "")) if s else None
    return [num(m.group(1)), int(m.group(2)), num(m.group(3))]


def fetch(iid):
    time.sleep(1.0)
    html = get(BASE + str(iid))
    if not html or "아이템 정보" not in html and "시세 요약" not in html:
        return iid, None  # failed; retried next run
    return iid, parse(html)


def main():
    workers = 3
    if "--workers" in sys.argv:
        workers = int(sys.argv[sys.argv.index("--workers") + 1])
    try:
        data = json.load(open(OUT))
    except FileNotFoundError:
        data = {}
    sitemap = get(BASE + "sitemap.xml") or ""
    ids = [int(x) for x in re.findall(r"/v2/item/(\d+)<", sitemap)]
    todo = [i for i in ids if str(i) not in data]
    print(f"{len(ids)} ids in the sitemap, {len(todo)} to fetch", file=sys.stderr)
    done = 0
    with ThreadPoolExecutor(workers) as pool:
        for iid, res in pool.map(fetch, todo):
            if res is not None:
                data[str(iid)] = res
            done += 1
            if done % 100 == 0:
                json.dump(data, open(OUT, "w"), separators=(",", ":"), sort_keys=True)
                print(f"  {done}/{len(todo)}", file=sys.stderr)
    json.dump(data, open(OUT, "w"), separators=(",", ":"), sort_keys=True)
    priced = sum(1 for v in data.values() if v[0])
    print(f"done: {len(data)} items, {priced} with a price", file=sys.stderr)


if __name__ == "__main__":
    main()
