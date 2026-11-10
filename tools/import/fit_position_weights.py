#!/usr/bin/env python3
"""Fit a position-overall formula for every game position from Madden's own overalls.

For each game position we take the Madden players who play there and fit
    overall ~ intercept + sum(weight_i * rating_i)
with non-negative weights, a small ridge penalty, and only the ratings that
plausibly matter for that position. Applying a position's formula to any
player gives that player's overall *at that position* - which is how the game
rates out-of-position picks in the Triple Draft.

Writes packages/shared/config/position_weights.json (weights normalised to sum 1,
plus scale/intercept so outputs land on Madden's 0-99 scale). Re-run after
importing a new ratings week. Positions with no Madden equivalent (NT, ILB, KR)
are derived from a related position with documented tweaks.

Requires: numpy
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PLAYERS = ROOT / "packages/shared/data/players.json"
OUT = ROOT / "packages/shared/config/position_weights.json"

PHYS = ["speed", "acceleration", "agility", "changeOfDirection", "strength", "jumping", "stamina",
        "toughness", "injury", "awareness"]
FEATURES = {
    "QB": PHYS + ["throwPower", "throwAccuracyShort", "throwAccuracyMid", "throwAccuracyDeep",
                  "throwOnTheRun", "throwUnderPressure", "playAction", "breakSack"],
    "RB": PHYS + ["carrying", "bCVision", "breakTackle", "trucking", "stiffArm", "jukeMove", "spinMove",
                  "catching", "shortRouteRunning", "passBlock"],
    "FB": PHYS + ["carrying", "trucking", "breakTackle", "leadBlock", "impactBlocking", "runBlock",
                  "passBlock", "catching"],
    "WR": PHYS + ["catching", "catchInTraffic", "spectacularCatch", "shortRouteRunning",
                  "mediumRouteRunning", "deepRouteRunning", "release", "bCVision", "breakTackle"],
    "TE": PHYS + ["catching", "catchInTraffic", "spectacularCatch", "shortRouteRunning",
                  "mediumRouteRunning", "deepRouteRunning", "release", "runBlock", "passBlock",
                  "impactBlocking", "breakTackle"],
    "OT": PHYS + ["passBlock", "passBlockPower", "passBlockFinesse", "runBlock", "runBlockPower",
                  "runBlockFinesse", "impactBlocking"],
    "OG": PHYS + ["passBlock", "passBlockPower", "passBlockFinesse", "runBlock", "runBlockPower",
                  "runBlockFinesse", "impactBlocking"],
    "C": PHYS + ["passBlock", "passBlockPower", "passBlockFinesse", "runBlock", "runBlockPower",
                 "runBlockFinesse", "impactBlocking"],
    "DE": PHYS + ["tackle", "hitPower", "pursuit", "playRecognition", "blockShedding", "powerMoves",
                  "finesseMoves"],
    "DT": PHYS + ["tackle", "hitPower", "pursuit", "playRecognition", "blockShedding", "powerMoves",
                  "finesseMoves"],
    "OLB": PHYS + ["tackle", "hitPower", "pursuit", "playRecognition", "blockShedding", "powerMoves",
                   "finesseMoves", "zoneCoverage", "manCoverage"],
    "MLB": PHYS + ["tackle", "hitPower", "pursuit", "playRecognition", "blockShedding", "zoneCoverage",
                   "manCoverage"],
    "CB": PHYS + ["manCoverage", "zoneCoverage", "press", "playRecognition", "catching", "tackle",
                  "pursuit", "hitPower"],
    "S": PHYS + ["manCoverage", "zoneCoverage", "press", "playRecognition", "catching", "tackle",
                 "pursuit", "hitPower"],
    "K": ["kickPower", "kickAccuracy", "awareness"],
    "P": ["kickPower", "kickAccuracy", "awareness"],
    "LS": ["awareness", "strength", "passBlock", "runBlock", "speed", "tackle"],
}
# game position -> (feature family, Madden positions it is fitted on)
GAME_POS = {
    "QB": ("QB", ["QB"]), "RB": ("RB", ["HB"]), "FB": ("FB", ["FB"]), "WR": ("WR", ["WR"]),
    "TE": ("TE", ["TE"]), "LT": ("OT", ["LT"]), "RT": ("OT", ["RT"]), "LG": ("OG", ["LG"]),
    "RG": ("OG", ["RG"]), "C": ("C", ["C"]), "DE": ("DE", ["LEDG", "REDG"]), "DT": ("DT", ["DT"]),
    "OLB": ("OLB", ["SAM", "WILL"]), "MLB": ("MLB", ["MIKE"]), "CB": ("CB", ["CB"]),
    "FS": ("S", ["FS"]), "SS": ("S", ["SS"]), "K": ("K", ["K"]), "P": ("P", ["P"]), "LS": ("LS", ["LS"]),
}


def nnls_ridge(X, y, lam=2.0, iters=4000):
    """Non-negative ridge regression with an unpenalised intercept (projected coordinate descent)."""
    mu_x, mu_y = X.mean(0), y.mean()
    Xc, yc = X - mu_x, y - mu_y
    n, k = Xc.shape
    w = np.full(k, 1.0 / k)
    col_sq = (Xc ** 2).sum(0) + lam * n
    r = yc - Xc @ w
    for _ in range(iters):
        delta = 0.0
        for j in range(k):
            old = w[j]
            rho = Xc[:, j] @ r + (Xc[:, j] ** 2).sum() * old
            new = max(0.0, rho / col_sq[j])
            if new != old:
                r -= Xc[:, j] * (new - old)
                w[j] = new
                delta = max(delta, abs(new - old))
        if delta < 1e-7:
            break
    b = mu_y - mu_x @ w
    return w, b


def main():
    players = json.loads(PLAYERS.read_text())["players"]
    out = {"_doc": "overall_at_pos = clamp(intercept + scale * sum(weights[k] * rating[k]), 0, 99). "
                   "Generated by tools/import/fit_position_weights.py.",
           "positions": {}}
    report = []
    for gpos, (fam, mpos) in GAME_POS.items():
        feats = FEATURES[fam]
        rows = [p for p in players if p["pos"] in mpos]
        X = np.array([[p["stats"].get(f, 0) for f in feats] for p in rows], float)
        y = np.array([p["ovr"] for p in rows], float)
        lam = 0.5 if len(rows) > 60 else 3.0
        w, b = nnls_ridge(X, y, lam=lam)
        pred = X @ w + b
        rmse = float(np.sqrt(((pred - y) ** 2).mean()))
        corr = float(np.corrcoef(pred, y)[0, 1]) if len(rows) > 2 else 1.0
        scale = float(w.sum()) or 1.0
        weights = {f: round(float(v / scale), 4) for f, v in zip(feats, w) if v / scale >= 0.005}
        out["positions"][gpos] = {"fitOn": mpos, "n": len(rows), "scale": round(scale, 4),
                                  "intercept": round(float(b), 3), "weights": weights,
                                  "fit": {"rmse": round(rmse, 2), "r": round(corr, 3)}}
        report.append((gpos, len(rows), rmse, corr, sorted(weights.items(), key=lambda kv: -kv[1])[:4]))

    # derived positions (no Madden equivalent)
    def derive(src, tweak, note):
        d = json.loads(json.dumps(out["positions"][src]))
        wts = d["weights"]
        for k, f in tweak.items():
            wts[k] = round(wts.get(k, 0) * f[0] + f[1], 4)
        s = sum(wts.values())
        d["weights"] = {k: round(v / s, 4) for k, v in wts.items()}
        d["derivedFrom"] = src
        d["note"] = note
        return d
    out["positions"]["NT"] = derive("DT", {"strength": (1.6, 0.04), "blockShedding": (1.3, 0.02),
                                           "speed": (0.5, 0), "finesseMoves": (0.6, 0)},
                                    "3-4 nose tackle: DT formula weighted toward strength/shedding")
    out["positions"]["ILB"] = derive("MLB", {"blockShedding": (1.3, 0.02), "strength": (1.2, 0.02)},
                                     "3-4 inside linebacker: MLB formula, a bit more take-on ability")
    out["positions"]["KR"] = {
        "derivedFrom": None, "note": "returner role (hand-set weights)", "scale": 1.0, "intercept": 0.0,
        "weights": {"kickReturn": 0.4, "speed": 0.2, "acceleration": 0.12, "agility": 0.1,
                    "carrying": 0.08, "bCVision": 0.1}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    for gpos, n, rmse, corr, top in report:
        print(f"{gpos:4s} n={n:4d}  rmse={rmse:4.2f}  r={corr:.3f}  top: " +
              ", ".join(f"{k}={v:.2f}" for k, v in top), file=sys.stderr)
    print(f"wrote {OUT.relative_to(ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
