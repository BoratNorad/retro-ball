// Team grade: weighted mean of starters' effective overall at their slot, per unit, plus a small,
// capped chemistry bonus. Letter grades A+..F come from config/grade.json.
import type { Creature, GameData } from "@tdf/shared";
import { slotOverall } from "./creatures.js";

/** A lineup: slot id (e.g. "QB", "WR", "CB") -> creature. Repeated slots (3 WRs) use suffixes "WR#2". */
export type Lineup = Record<string, Creature>;
export const slotBase = (slot: string) => slot.split("#")[0] as string;

export interface UnitGrade { score: number; letter: string }
export interface TeamGrade {
  offense: UnitGrade; defense: UnitGrade; special: UnitGrade; overall: UnitGrade;
  chemistry: { typeDiversity: number; qbWr: number; olCohesion: number; total: number };
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

export function chemistry(lineup: Lineup, data: GameData) {
  const cfg = data.grade.chemistry;
  const sideTypes = (side: "O" | "D") => {
    const s = new Set<string>();
    for (const [slot, c] of Object.entries(lineup)) {
      const pos = data.positions.positions.find((p) => p.id === slotBase(slot));
      if (pos?.side === side) c.types.forEach((t) => s.add(t));
    }
    return s.size;
  };
  const typeDiversity = Math.min(cfg.typeDiversityCap, (sideTypes("O") + sideTypes("D") - 2) * cfg.typeDiversityPerType / 2);
  const qb = Object.entries(lineup).find(([s]) => slotBase(s) === "QB")?.[1];
  const wrs = Object.entries(lineup).filter(([s]) => ["WR", "TE"].includes(slotBase(s))).map(([, c]) => c);
  const qbWr = qb ? Math.min(cfg.qbWrCap, wrs.filter((w) => w.types.some((t) => qb.types.includes(t))).length * cfg.qbWrSharedTypeBonus) : 0;
  const ol = Object.entries(lineup).filter(([s]) => ["LT", "LG", "C", "RG", "RT"].includes(slotBase(s))).map(([, c]) => c.team);
  let pairs = 0;
  for (let i = 0; i < ol.length; i++) for (let j = i + 1; j < ol.length; j++) if (ol[i] === ol[j]) pairs++;
  const olCohesion = Math.min(cfg.olCap, pairs * cfg.olSameTeamPairBonus);
  const total = Math.min(cfg.maxTotal, typeDiversity + qbWr + olCohesion);
  return { typeDiversity, qbWr, olCohesion, total };
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
