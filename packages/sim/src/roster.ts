// Rosters: 22 starters + K/P/LS by slot, plus a bench, from the creature pool.
import type { PlayerCard, GameData } from "@tdf/shared";
import { slotOverall } from "./cards.js";

/** Starting slots. Digits distinguish repeated positions; slotPos() strips them. */
export const OFFENSE_SLOTS = ["QB", "RB", "WR1", "WR2", "WR3", "TE", "LT", "LG", "C", "RG", "RT"] as const;
export const DEFENSE_SLOTS = ["DE1", "DT1", "DT2", "DE2", "OLB1", "MLB", "OLB2", "CB1", "CB2", "FS", "SS"] as const;
export const SPECIAL_SLOTS = ["K", "P", "LS"] as const;
export const ALL_SLOTS = [...OFFENSE_SLOTS, ...DEFENSE_SLOTS, ...SPECIAL_SLOTS];
/** fill order: most important first, so a scarce star lands where he matters most */
const FILL_ORDER = ["QB", "LT", "DE1", "CB1", "WR1", "DE2", "CB2", "RB", "WR2", "TE", "DT1", "MLB", "FS", "SS", "RT",
  "OLB1", "OLB2", "DT2", "WR3", "LG", "RG", "C", "K", "P", "LS"];

export const slotPos = (slot: string) => slot.replace(/#?\d+$/, "");

export interface TeamInfo { abbr: string; name: string; nick: string; c1: string; c2: string; c3: string }
export interface Roster {
  info: TeamInfo;
  starters: Record<string, PlayerCard>;
  bench: PlayerCard[];
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
  const bench = [...left].sort((a, b) => b.ovr - a.ovr || a.id - b.id);
  return { info, starters, bench };
}

/** A real NFL team's roster from the pool. */
export function nflRoster(abbr: string, pool: readonly PlayerCard[], data: GameData): Roster {
  const t = data.teams.teams.find((x) => x.abbr === abbr);
  if (!t) throw new Error(`unknown team ${abbr}`);
  const info = { abbr: t.abbr, name: t.name, nick: t.nick, c1: t.c1, c2: t.c2, c3: t.c3 };
  return buildRoster(info, pool.filter((c) => c.team === abbr), data);
}
