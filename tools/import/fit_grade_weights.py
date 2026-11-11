#!/usr/bin/env python3
"""Fit team-grade position weights to what actually wins in the engine.

Input: JSONL from the harness (FIT_OUT=path pnpm sim:harness ...): per game, the home-minus-away
average effective overall at each position and the final score margin. A ridge regression of
margin on those differences gives "points of margin per overall point" for each position. Those
become the grade's per-slot weights (divided by how many starters share the position) and the
offense/defense/special unit weights, written into packages/shared/config/grade.json.

Usage: python3 tools/import/fit_grade_weights.py path/to/fit.jsonl [--write]
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
GRADE = ROOT / "packages/shared/config/grade.json"
SLOTS = {"QB": 1, "RB": 1, "WR": 3, "TE": 1, "LT": 1, "LG": 1, "C": 1, "RG": 1, "RT": 1,
         "DE": 2, "DT": 2, "OLB": 2, "MLB": 1, "CB": 2, "FS": 1, "SS": 1, "K": 1, "P": 1, "LS": 1}
UNIT = {"offense": ["QB", "RB", "WR", "TE", "LT", "LG", "C", "RG", "RT"],
        "defense": ["DE", "DT", "OLB", "MLB", "CB", "FS", "SS"],
        "special": ["K", "P", "LS"]}


def main():
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    pos = list(SLOTS)
    X = np.array([[r["d"].get(p, 0.0) for p in pos] for r in rows])
    y = np.array([r["margin"] for r in rows], float)
    lam = 50.0
    beta = np.linalg.solve(X.T @ X + lam * np.eye(len(pos)), X.T @ y)
    pred = X @ beta
    r = np.corrcoef(pred, y)[0, 1]
    acc = np.mean(np.sign(pred[y != 0]) == np.sign(y[y != 0]))
    print(f"{len(rows)} games  fit r={r:.3f}  predicts winner {acc * 100:.1f}%")
    order = sorted(range(len(pos)), key=lambda i: -beta[i])
    print("points of margin per +1 avg overall at the position (and per single starter):")
    for i in order:
        print(f"  {pos[i]:4s} {beta[i]:+.3f}   per starter {beta[i] / SLOTS[pos[i]]:+.3f}")

    if "--write" in sys.argv:
        g = json.loads(GRADE.read_text())
        per = {p: max(0.02, float(beta[i]) / SLOTS[p]) for i, p in enumerate(pos)}  # never zero/negative
        for unit, ps in UNIT.items():
            norm = max(per[p] for p in ps)
            g["unitWeights"][unit] = {p: round(per[p] / norm * 4, 3) for p in ps}
            # 3-4 positions reuse their 4-3 cousins until there is data for them
        g["unitWeights"]["defense"]["NT"] = g["unitWeights"]["defense"]["DT"]
        g["unitWeights"]["defense"]["ILB"] = g["unitWeights"]["defense"]["MLB"]
        g["unitWeights"]["special"]["KR"] = g["unitWeights"]["special"].get("KR", 0.6)
        tot = {u: sum(max(0.0, float(beta[pos.index(p)])) for p in ps) for u, ps in UNIT.items()}
        s = sum(tot.values())
        g["overallUnitWeights"] = {u: round(v / s, 3) for u, v in tot.items()}
        g["_fit"] = {"games": len(rows), "r": round(float(r), 3), "winnerAcc": round(float(acc), 3),
                     "note": "unit/slot weights fitted by tools/import/fit_grade_weights.py from harness games"}
        GRADE.write_text(json.dumps(g, indent=2) + "\n")
        print(f"wrote {GRADE.relative_to(ROOT)}: overall unit weights {g['overallUnitWeights']}")


if __name__ == "__main__":
    main()
