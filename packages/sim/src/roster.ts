// Rosters: 22 starters + K/P/LS by slot, plus a bench, from the creature pool.
import type { PlayerCard, GameData } from "@tdf/shared";
import { slotOverall } from "./cards.js";

/** Starting slots. Digits distinguish repeated positions; slotPos() strips them. */
export const OFFENSE_SLOTS = ["QB", "RB", "WR1", "WR2", "WR3", "TE", "LT", "LG", "C", "RG", "RT"] as const;
export const DEFENSE_SLOTS = ["DE1", "DT1", "DT2", "DE2", "OLB1", "MLB", "OLB2", "CB1", "CB2", "FS", "SS"] as const;
export const SPECIAL_SLOTS = ["K", "P", "LS"] as const;
export const ALL_SLOTS = [...OFFENSE_SLOTS, ...DEFENSE_SLOTS, ...SPECIAL_SLOTS];
/** Sub-package slots (personnel groupings and fronts), filled from the bench after the starters. */
export const PACKAGE_SLOTS = ["WR4", "TE2", "FB", "CB3", "CB4", "RB2", "TE3", "SS2", "DT3", "MLB2"] as const;
/** fill order: most important first, so a scarce star lands where he matters most */
const FILL_ORDER = ["QB", "LT", "DE1", "CB1", "WR1", "DE2", "CB2", "RB", "WR2", "TE", "DT1", "MLB", "FS", "SS", "RT",
  "OLB1", "OLB2", "DT2", "WR3", "LG", "RG", "C", "K", "P", "LS"];

export const slotPos = (slot: string) => slot.replace(/#?\d+$/, "");

export interface TeamInfo { abbr: string; name: string; nick: string; c1: string; c2: string; c3: string }
export interface Roster {
  info: TeamInfo;
  starters: Record<string, PlayerCard>;
  /** sub-package players (WR4, TE2, FB, CB3, ...): bench players, may be missing on thin rosters */
  depth: Record<string, PlayerCard>;
  bench: PlayerCard[];
  /** base defensive front (base43 / base34); default from config/coach.json */
  baseFront?: string;
}

/** Who plays a slot: the starter, else the sub-package player, else the best fit among starters
 *  not in `taken` (a thin roster plays someone out of position). */
export function slotPlayer(ro: Roster, slot: string, data: GameData, taken?: Set<number>): PlayerCard {
  const s = ro.starters[slot];
  if (s && !taken?.has(s.id)) return s;
  const d = ro.depth[slot];
  if (d && !taken?.has(d.id)) return d;
  const pos = slotPos(slot);
  let best: PlayerCard | null = null, bv = -1;
  for (const c of [...ro.bench, ...Object.values(ro.starters)]) {
    if (taken?.has(c.id)) continue;
    const v = slotOverall(c, pos, data);
    if (v > bv) { bv = v; best = c; }
  }
  if (!best) throw new Error(`${ro.info.abbr}: nobody can play ${slot}`);
  return best;
}

/** Greedy assignment: each slot (in importance order) takes the best remaining player there. */
export function buildRoster(info: TeamInfo, players: readonly PlayerCard[], data: GameData): Roster {
  const left = new Set(players);
  const starters: Record<string, PlayerCard> = {};
  for (const slot of FILL_ORDER) {
    const pos = slotPos(slot);
    let best: PlayerCard | null = null, bestVal = -1;
    for (const c of left) {
      const v = slotOverall(c, pos, data);
      if (v > bestVal || (v === bestVal && best && c.id < best.id)) { best = c; bestVal = v; }
    }
    if (!best) throw new Error(`${info.abbr}: not enough players to fill ${slot}`);
    starters[slot] = best;
    left.delete(best);
  }
  const depth: Record<string, PlayerCard> = {};
  for (const slot of PACKAGE_SLOTS) {
    const pos = slotPos(slot);
    let best: PlayerCard | null = null, bestVal = -1;
    for (const c of left) {
      const v = slotOverall(c, pos, data);
      if (v > bestVal || (v === bestVal && best && c.id < best.id)) { best = c; bestVal = v; }
    }
    if (best) { depth[slot] = best; left.delete(best); }
  }
  const bench = [...left, ...Object.values(depth)].sort((a, b) => b.ovr - a.ovr || a.id - b.id);
  return { info, starters, depth, bench };
}

/** A real NFL team's roster from the pool. */
export function nflRoster(abbr: string, pool: readonly PlayerCard[], data: GameData): Roster {
  const t = data.teams.teams.find((x) => x.abbr === abbr);
  if (!t) throw new Error(`unknown team ${abbr}`);
  const info = { abbr: t.abbr, name: t.name, nick: t.nick, c1: t.c1, c2: t.c2, c3: t.c3 };
  return buildRoster(info, pool.filter((c) => c.team === abbr), data);
}
