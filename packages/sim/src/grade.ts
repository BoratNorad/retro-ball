// Team grade: weighted mean of starters' effective overall at their slot, per unit, plus a small,
// capped chemistry bonus. Letter grades A+..F come from config/grade.json.
import type { PlayerCard, GameData } from "@tdf/shared";
import { slotOverall } from "./cards.js";

/** A lineup: slot id (e.g. "QB", "WR", "CB") -> creature. Repeated slots (3 WRs) use suffixes "WR#2". */
export type Lineup = Record<string, PlayerCard>;
export const slotBase = (slot: string) => slot.replace(/#?\d+$/, "");

export interface UnitGrade { score: number; letter: string }
export interface TeamGrade {
  offense: UnitGrade; defense: UnitGrade; special: UnitGrade; overall: UnitGrade;
  chemistry: { qbTargets: number; olCohesion: number; total: number };
}

export function letterFor(score: number, data: GameData): string {
  for (const [letter, min] of data.grade.letters) if (score >= min) return letter;
  return data.grade.letters[data.grade.letters.length - 1]![0];
}

function unit(lineup: Lineup, weights: Record<string, number>, data: GameData): number | null {
  let sum = 0, tot = 0;
  for (const [slot, c] of Object.entries(lineup)) {
    const w = weights[slotBase(slot)];
    if (w == null) continue;
    sum += w * slotOverall(c, slotBase(slot), data);
    tot += w;
  }
  return tot ? sum / tot : null;
}

/** Real-life chemistry: a QB throwing to his actual NFL teammates, linemen who play together. */
export function chemistry(lineup: Lineup, data: GameData) {
  const cfg = data.grade.chemistry;
  const qb = Object.entries(lineup).find(([s]) => slotBase(s) === "QB")?.[1];
  const targets = Object.entries(lineup).filter(([s]) => ["WR", "TE", "RB"].includes(slotBase(s))).map(([, c]) => c);
  const qbTargets = qb ? Math.min(cfg.qbTargetCap, targets.filter((t) => t.team === qb.team).length * cfg.qbTargetSameTeamBonus) : 0;
  const ol = Object.entries(lineup).filter(([s]) => ["LT", "LG", "C", "RG", "RT"].includes(slotBase(s))).map(([, c]) => c.team);
  let pairs = 0;
  for (let i = 0; i < ol.length; i++) for (let j = i + 1; j < ol.length; j++) if (ol[i] === ol[j]) pairs++;
  const olCohesion = Math.min(cfg.olCap, pairs * cfg.olSameTeamPairBonus);
  const total = Math.min(cfg.maxTotal, qbTargets + olCohesion);
  return { qbTargets, olCohesion, total };
}

export function teamGrade(lineup: Lineup, data: GameData): TeamGrade {
  const w = data.grade.unitWeights;
  const o = unit(lineup, w.offense, data) ?? 0;
  const d = unit(lineup, w.defense, data) ?? 0;
  const s = unit(lineup, w.special, data) ?? 0;
  const chem = chemistry(lineup, data);
  const ow = data.grade.overallUnitWeights;
  const overall = o * ow.offense + d * ow.defense + s * ow.special + chem.total;
  const g = (x: number): UnitGrade => ({ score: Math.round(x * 10) / 10, letter: letterFor(x, data) });
  return { offense: g(o), defense: g(d), special: g(s), overall: g(overall), chemistry: chem };
}
