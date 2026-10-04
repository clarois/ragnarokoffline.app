"""Price estimates for items no market prices, learned from the ones it does.

Used by build_vendors.py: fit() takes the items that have a real market price
(kRO via RagMAYA, or iRO via ragnastats converted) and learns log(price) from
what rAthena knows about every item -- its kind, NPC value, which monsters
drop it and how rarely, and for equipment its level, slots and stats. A ridge
regression per category where there are enough examples, one shared model
otherwise. predict() then prices the rest.

Only items with something real to go on are estimated: at least one monster
drops it, or an NPC sells it at a real price. Everything else stays unpriced.

evaluate() reports how far off the model is on items whose price is known, by
predicting each one with a model fitted without it (k-fold), so the error is
what an unknown item can expect.
"""
import math

import numpy as np

CATEGORIES = ["Etc", "Healing", "Usable", "DelayConsume", "Card", "Weapon", "armor", "headgear",
              "accessory", "Ammo", "ShadowGear", "other"]
MIN_PER_MODEL = 60
RIDGE = 1.0


def drop_stats(mobs, item_of, mvp_ids):
    """item id -> (droppers, best rate 0..1, min level, max level, boss?, mvp?)."""
    out = {}
    for mid, m in mobs.items():
        boss = m.get("Class") == "Boss"
        mvp = mid in mvp_ids
        lvl = m.get("Level", 1)
        for d in (m.get("Drops") or []) + (m.get("MvpDrops") or []):
            e = item_of(d["Item"])
            if not e:
                continue
            s = out.setdefault(e["Id"], [0, 0.0, 999, 0, False, False])
            s[0] += 1
            s[1] = max(s[1], d.get("Rate", 0) / 10000.0)
            s[2] = min(s[2], lvl)
            s[3] = max(s[3], lvl)
            s[4] |= boss
            s[5] |= mvp
    return out


class Model:
    def __init__(self, category, npc_sold, drops):
        self.category = category
        self.npc_sold = npc_sold
        self.drops = drops
        self.models = {}

    def eligible(self, e):
        buy = e.get("Buy") or 0
        return e["Id"] in self.drops or (e["Id"] in self.npc_sold and buy >= 100)

    def features(self, e):
        cat = self.category(e)
        cat = cat if cat in CATEGORIES else ("ShadowGear" if cat == "Shadowgear" else "other")
        buy = e.get("Buy") or 0
        sell = e.get("Sell") or buy // 2
        real_npc = buy >= 100
        d = self.drops.get(e["Id"], [0, 0.0, 0, 0, False, False])
        rate = d[1]
        f = [
            1.0,
            math.log1p(buy) if real_npc else 0.0,
            math.log1p(sell) if real_npc else 0.0,
            1.0 if e["Id"] in self.npc_sold and real_npc else 0.0,
            math.log1p(d[0]),
            -math.log10(rate) if rate > 0 else 0.0,     # rarity: 0 for 100%, 4 for 0.01%
            1.0 if d[0] == 0 else 0.0,
            (d[2] if d[0] else 0) / 100.0,
            (d[3] if d[0] else 0) / 100.0,
            1.0 if d[4] else 0.0,
            1.0 if d[5] else 0.0,
            (e.get("EquipLevelMin") or 0) / 100.0,
            float(e.get("WeaponLevel") or 0),
            float(e.get("Slots") or 0),
            math.log1p(e.get("Attack") or 0),
            math.log1p(e.get("MagicAttack") or 0),
            math.log1p(e.get("Defense") or 0),
            0.0 if e.get("Refineable", True) is False else 1.0,
            math.log1p(e.get("Weight") or 0),
        ]
        onehot = [1.0 if cat == c else 0.0 for c in CATEGORIES]
        return cat, np.array(f + onehot)

    @staticmethod
    def _solve(X, y):
        n = X.shape[1]
        reg = RIDGE * np.eye(n)
        reg[0, 0] = 0.0  # don't shrink the intercept
        return np.linalg.solve(X.T @ X + reg, X.T @ y)

    def fit(self, known):
        """known: list of (item entry, price)."""
        rows = [(*self.features(e), math.log(p)) for e, p in known if p > 0]
        X_all = np.array([r[1] for r in rows])
        y_all = np.array([r[2] for r in rows])
        self.models = {"*": self._solve(X_all, y_all)}
        for c in CATEGORIES:
            idx = [i for i, r in enumerate(rows) if r[0] == c]
            if len(idx) >= MIN_PER_MODEL:
                self.models[c] = self._solve(X_all[idx], y_all[idx])
        return self

    def predict(self, e):
        if not self.eligible(e):
            return None
        cat, x = self.features(e)
        w = self.models.get(cat, self.models["*"])
        return int(round(math.exp(float(x @ w))))

    def evaluate(self, known, folds=5, seed=1):
        """Typical error on items whose price is known, per category: the
        median of |log(predicted / actual)|, given as a factor (1.5 = half
        the time within ×1.5 either way)."""
        rng = np.random.default_rng(seed)
        known = [k for k in known if self.eligible(k[0]) and k[1] > 0]
        order = rng.permutation(len(known))
        errs = {}
        for f in range(folds):
            test = set(order[f::folds].tolist())
            train = [known[i] for i in range(len(known)) if i not in test]
            m = Model(self.category, self.npc_sold, self.drops).fit(train)
            for i in test:
                e, p = known[i]
                q = m.predict(e)
                if q:
                    errs.setdefault(self.features(e)[0], []).append(abs(math.log(q / p)))
        every = [x for v in errs.values() for x in v]
        out = {c: (len(v), math.exp(float(np.median(v)))) for c, v in errs.items()}
        out["all"] = (len(every), math.exp(float(np.median(every))) if every else float("nan"))
        return out
