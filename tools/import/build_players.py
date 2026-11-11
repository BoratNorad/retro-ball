#!/usr/bin/env python3
"""Import real players into the game's data files.

Reads the Madden ratings spreadsheet, matches every player to the nflverse
player database (headshots, ids, draft info), adds nflverse team colours,
and writes validated-shape JSON into packages/shared/data/:

    players.json           every player: bio, position, all ratings, Madden ability ids, nflverse ids
    teams.json             32 teams: names, conference/division, colours, default depth-chart lineup
    madden_abilities.json  Madden X-Factor / Superstar abilities, deduplicated
    stat_groups.json       rating groups used by UIs

It also regenerates apps/dex/js/data.js so the Gridiron Dex keeps working.
Run `pnpm data:report` afterwards to validate and see distributions.

Usage:
    python3 tools/import/build_players.py                      # uses data/raw/Madden_27_Ratings.xlsx
    python3 tools/import/build_players.py path/to/ratings.xlsx
    python3 tools/import/build_players.py --players-csv players.csv --teams-csv teams.csv

Requires: pandas, openpyxl
"""
import argparse
import io
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
NFLVERSE_PLAYERS = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
NFLVERSE_TEAMS = "https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv"

# Madden team label -> nflverse team_abbr
TEAM_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LA", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "NY Giants": "NYG", "NY Jets": "NYJ", "New England Patriots": "NE",
    "New Orleans Saints": "NO", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

# Stat groups shown on the dex page (key in sheet -> short label)
STAT_GROUPS = [
    ("Physical", [("speed", "SPD"), ("acceleration", "ACC"), ("agility", "AGI"),
                  ("changeOfDirection", "COD"), ("strength", "STR"), ("jumping", "JMP"),
                  ("stamina", "STA"), ("toughness", "TGH"), ("injury", "INJ"),
                  ("awareness", "AWR")]),
    ("Passing", [("throwPower", "THP"), ("throwAccuracyShort", "SAC"), ("throwAccuracyMid", "MAC"),
                 ("throwAccuracyDeep", "DAC"), ("throwOnTheRun", "RUN"),
                 ("throwUnderPressure", "TUP"), ("playAction", "PAC"), ("breakSack", "BSK")]),
    ("Rushing", [("carrying", "CAR"), ("bCVision", "BCV"), ("breakTackle", "BTK"),
                 ("trucking", "TRK"), ("stiffArm", "SFA"), ("jukeMove", "JKM"),
                 ("spinMove", "SPM")]),
    ("Receiving", [("catching", "CTH"), ("catchInTraffic", "CIT"), ("spectacularCatch", "SPC"),
                   ("shortRouteRunning", "SRR"), ("mediumRouteRunning", "MRR"),
                   ("deepRouteRunning", "DRR"), ("release", "RLS"), ("kickReturn", "RET")]),
    ("Blocking", [("passBlock", "PBK"), ("passBlockPower", "PBP"), ("passBlockFinesse", "PBF"),
                  ("runBlock", "RBK"), ("runBlockPower", "RBP"), ("runBlockFinesse", "RBF"),
                  ("leadBlock", "LBK"), ("impactBlocking", "IBL")]),
    ("Defense", [("tackle", "TAK"), ("hitPower", "POW"), ("pursuit", "PUR"),
                 ("playRecognition", "PRC"), ("blockShedding", "BSH"), ("powerMoves", "PMV"),
                 ("finesseMoves", "FMV"), ("manCoverage", "MCV"), ("zoneCoverage", "ZCV"),
                 ("press", "PRS")]),
    ("Kicking", [("kickPower", "KPW"), ("kickAccuracy", "KAC")]),
]

# Position families (used for "type" badges and depth charts)
POS_GROUP = {
    "QB": "QB", "HB": "RB", "FB": "RB", "WR": "WR", "TE": "TE",
    "LT": "OL", "LG": "OL", "C": "OL", "RG": "OL", "RT": "OL",
    "LEDG": "DL", "REDG": "DL", "DT": "DL",
    "SAM": "LB", "MIKE": "LB", "WILL": "LB",
    "CB": "DB", "FS": "DB", "SS": "DB",
    "K": "ST", "P": "ST", "LS": "ST",
}

# Starting 22: (slot label, positions eligible in priority order, x, y on field 0..1)
# Offense: 11 personnel (1 RB, 1 TE, 3 WR). Defense: 4-3 base.
# x = across the field (0 left .. 1 right), y = depth (0 = line of scrimmage)
OFFENSE = [
    ("QB", ["QB"]), ("HB", ["HB", "FB"]),
    ("WR1", ["WR"]), ("WR2", ["WR"]), ("WR3", ["WR"]), ("TE", ["TE"]),
    ("LT", ["LT", "RT", "LG", "RG"]), ("LG", ["LG", "RG", "C"]), ("C", ["C", "LG", "RG"]),
    ("RG", ["RG", "LG", "C"]), ("RT", ["RT", "LT", "RG", "LG"]),
]
DEFENSE = [
    ("LEDG", ["LEDG", "REDG"]), ("DT1", ["DT"]), ("DT2", ["DT"]), ("REDG", ["REDG", "LEDG"]),
    ("SAM", ["SAM", "WILL", "MIKE"]), ("MIKE", ["MIKE", "WILL", "SAM"]), ("WILL", ["WILL", "MIKE", "SAM"]),
    ("CB1", ["CB"]), ("CB2", ["CB"]), ("FS", ["FS", "SS"]), ("SS", ["SS", "FS"]),
]
SPECIAL = [("K", ["K"]), ("P", ["P"]), ("LS", ["LS"])]


# typos in the Madden export
ARCH_FIX = {"Manto Man": "Man to Man"}


def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


def load_csv(local, url):
    if local:
        return pd.read_csv(local, low_memory=False)
    print(f"downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=120) as r:
        return pd.read_csv(io.BytesIO(r.read()), low_memory=False)


def ht(inches):
    return f"{int(inches) // 12}'{int(inches) % 12}\""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx", nargs="?", default=str(ROOT / "data/raw/Madden_27_Ratings.xlsx"))
    ap.add_argument("--players-csv", help="local copy of nflverse players.csv")
    ap.add_argument("--teams-csv", help="local copy of nflverse teams_colors_logos.csv")
    ap.add_argument("--out-dir", default=str(ROOT / "packages/shared/data"))
    ap.add_argument("--dex-out", default=str(ROOT / "apps/dex/js/data.js"))
    args = ap.parse_args()

    md = pd.read_excel(args.xlsx)
    nv = load_csv(args.players_csv, NFLVERSE_PLAYERS)
    tm = load_csv(args.teams_csv, NFLVERSE_TEAMS)

    # ---- nflverse lookup indexes -------------------------------------------------
    nv = nv[nv["headshot"].notna() | nv["gsis_id"].notna()].copy()
    nv["k_last"] = nv["last_name"].map(norm)
    nv["k_first"] = nv["first_name"].map(norm)
    nv["k_common"] = nv["common_first_name"].fillna(nv["first_name"]).map(norm)
    nv["k_full"] = nv["display_name"].map(norm)
    nv["bday"] = nv["birth_date"].astype(str).str[:10]
    nv = nv.sort_values("last_season", ascending=False)  # prefer most recent record

    by_bday_last = {}
    by_full = {}
    by_full_team = {}
    for _, r in nv.iterrows():
        by_bday_last.setdefault((r["bday"], r["k_last"]), r)
        by_full.setdefault(r["k_full"], []).append(r)
        by_full_team.setdefault((r["k_full"], r["latest_team"]), r)

    def match(row, abbr):
        bday = str(row["birthdate"])[:10]
        last = norm(row["lastName"])
        full = norm(f'{row["firstName"]} {row["lastName"]}')
        r = by_bday_last.get((bday, last))
        if r is not None:
            return r, "birthdate+last"
        # birthday match with a first-name match (handles last-name spelling/suffix diffs)
        cands = nv[(nv["bday"] == bday) & ((nv["k_common"] == norm(row["firstName"])) |
                                           (nv["k_first"] == norm(row["firstName"])))]
        if len(cands) == 1:
            return cands.iloc[0], "birthdate+first"
        r = by_full_team.get((full, abbr))
        if r is not None:
            return r, "name+team"
        lst = by_full.get(full, [])
        if len(lst) == 1:
            return lst[0], "name"
        return None, None

    # ---- abilities (deduped) ---------------------------------------------------
    abilities = {}

    # ---- players -----------------------------------------------------------------
    players = []
    stats_hit = {"birthdate+last": 0, "birthdate+first": 0, "name+team": 0, "name": 0, None: 0}
    for _, row in md.iterrows():
        abbr = TEAM_ABBR.get(row["team/label"], "FA")
        m, how = match(row, abbr)
        stats_hit[how] += 1

        stats, stat_diff = {}, {}
        for _, group in STAT_GROUPS:
            for key, _lbl in group:
                v = row.get(f"stats/{key}/value")
                d = row.get(f"stats/{key}/diff")
                if pd.notna(v):
                    stats[key] = int(v)
                    if pd.notna(d) and int(d) != 0:
                        stat_diff[key] = int(d)

        abil = []
        for i in range(5):
            aid = row.get(f"playerAbilities/{i}/id")
            if pd.isna(aid):
                continue
            aid = str(int(aid)) if isinstance(aid, float) else str(aid)
            abilities.setdefault(aid, {
                "name": row[f"playerAbilities/{i}/label"],
                "desc": row[f"playerAbilities/{i}/description"],
                "type": "XF" if row[f"playerAbilities/{i}/type/label"] == "X-Factor" else "SS",
            })
            abil.append(aid)

        pos = row["position/shortLabel"]
        players.append({
            "id": int(row["id"]),
            "first": row["firstName"],
            "last": row["lastName"],
            "team": abbr,
            "pos": pos,
            "posName": row["position/label"],
            "group": POS_GROUP.get(pos, "ST"),
            "side": {"offense": "O", "defense": "D"}.get(row["position/positionType/id"], "S"),
            "num": int(row["jerseyNum"]) if pd.notna(row["jerseyNum"]) else None,
            "ovr": int(row["overallRating"]),
            "ovrDiff": int(row["stats/overall/diff"]) if pd.notna(row.get("stats/overall/diff")) else 0,
            "arch": ARCH_FIX.get(a := (row["archetype/label"] or "").split(" - ")[0], a) if pd.notna(row["archetype/label"]) else "",
            "age": int(row["age"]),
            "bday": str(row["birthdate"])[:10],
            "htIn": int(row["height"]),
            "wt": int(row["weight"]),
            "college": row["college"] if pd.notna(row["college"]) else "",
            "yrs": int(row["yearsPro"]),
            "hand": "R" if int(row["handedness"]) == 1 else "L",
            "runStyle": row.get("stats/runningStyle/value") if pd.notna(row.get("stats/runningStyle/value")) else "",
            "stats": stats,
            "statDiff": stat_diff,
            "abil": abil,
            # nflverse
            "gsis": m["gsis_id"] if m is not None and pd.notna(m["gsis_id"]) else None,
            "espn": int(m["espn_id"]) if m is not None and pd.notna(m["espn_id"]) else None,
            "headshot": m["headshot"] if m is not None and pd.notna(m["headshot"]) else None,
            "draft": (f'{int(m["draft_year"])} R{int(m["draft_round"])} #{int(m["draft_pick"])} {m["draft_team"]}'
                      if m is not None and pd.notna(m["draft_year"]) and pd.notna(m["draft_round"]) else
                      ("Undrafted" if m is not None else "")),
        })

    # ---- depth charts / starting 22 -----------------------------------------------
    teams_out = {}
    tm = tm.set_index("team_abbr")
    for label, abbr in TEAM_ABBR.items():
        roster = [p for p in players if p["team"] == abbr]
        # depth at each listed position
        for pos in set(p["pos"] for p in roster):
            ranked = sorted([p for p in roster if p["pos"] == pos], key=lambda p: -p["ovr"])
            for i, p in enumerate(ranked):
                p["depth"] = i + 1
        used = set()
        lineup = {}
        for side, slots in (("O", OFFENSE), ("D", DEFENSE), ("S", SPECIAL)):
            for slot, eligible in slots:
                pick = None
                for pos in eligible:
                    cands = sorted([p for p in roster if p["pos"] == pos and p["id"] not in used],
                                   key=lambda p: -p["ovr"])
                    if cands:
                        pick = cands[0]
                        break
                if pick:
                    used.add(pick["id"])
                    pick["starter"] = slot
                    lineup[slot] = pick["id"]
        t = tm.loc[abbr] if abbr in tm.index else None
        teams_out[abbr] = {
            "abbr": abbr,
            "name": label,
            "nick": t["team_nick"] if t is not None else label.split()[-1],
            "conf": t["team_conf"] if t is not None else "",
            "div": t["team_division"] if t is not None else "",
            "c1": t["team_color"] if t is not None else "#444444",
            "c2": t["team_color2"] if t is not None else "#cccccc",
            "c3": t["team_color3"] if t is not None and pd.notna(t["team_color3"]) else "#ffffff",
            "lineup": lineup,
            "ovr": round(sum(p["ovr"] for p in roster if p.get("starter") in lineup) /
                         max(1, len(lineup))),
        }

    players.sort(key=lambda p: (-p["ovr"], p["last"]))
    for i, p in enumerate(players):
        p["dex"] = i + 1  # national dex number = league-wide OVR rank

    source = str(md["iteration/label"].iloc[0]) if "iteration/label" in md else ""
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def dump(name, obj):
        (out_dir / name).write_text(json.dumps(obj, ensure_ascii=False, indent=None, separators=(",", ":"),
                                               default=str, allow_nan=False) + "\n", encoding="utf-8")

    dump("players.json", {"source": source, "players": players})
    dump("teams.json", {"teams": list(teams_out.values())})
    dump("madden_abilities.json", {"abilities": [{"id": k, **v} for k, v in abilities.items()]})
    dump("stat_groups.json", {"groups": [{"name": g, "stats": [{"key": k, "short": l} for k, l in st]}
                                         for g, st in STAT_GROUPS]})

    # Gridiron Dex keeps its original single-file format
    if args.dex_out:
        dex_players = []
        for p in players:
            q = dict(p)
            q["ht"] = ht(q.pop("htIn"))
            diff = q.pop("statDiff")
            q["stats"] = {k: ([v, diff[k]] if k in diff else v) for k, v in q["stats"].items()}
            dex_players.append(q)
        dex = {"source": source, "statGroups": [[g, [[k, l] for k, l in st]] for g, st in STAT_GROUPS],
               "abilities": abilities, "teams": teams_out, "players": dex_players}
        Path(args.dex_out).write_text("// Generated by tools/import/build_players.py - do not edit by hand\n"
                                      "window.DEX_DATA = " + json.dumps(dex, separators=(",", ":"),
                                                                        ensure_ascii=False, default=str,
                                                                        allow_nan=False) + ";\n",
                                      encoding="utf-8")

    total = len(players)
    matched = total - stats_hit[None]
    print(f"players: {total}  nflverse matched: {matched} ({matched / total:.1%})", file=sys.stderr)
    for k, v in stats_hit.items():
        print(f"  {k or 'unmatched'}: {v}", file=sys.stderr)
    print(f"with headshot: {sum(1 for p in players if p['headshot'])}", file=sys.stderr)
    for f in sorted(out_dir.glob("*.json")):
        print(f"wrote {f.relative_to(ROOT)} ({f.stat().st_size / 1e6:.2f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
