// AI coach: situational decisions for both sides. Deterministic given the Rng.
import type { DefenseCall, GameData, OffensePlay } from "@tdf/shared";
import { ONE } from "./fixed.js";
import type { Rng } from "./rng.js";
import { other, secondsLeft, type GameState, type Side, type Tempo } from "./rules.js";
import type { Roster } from "./roster.js";
import { fgDistance, fgMakePerMille } from "./engine/kicks.js";
import type { Stats } from "./engine/play.js";

export type ScrimmageDecision =
  | { kind: "play"; play: OffensePlay; call: DefenseCall; flip: boolean }
  | { kind: "punt" } | { kind: "fieldGoal" } | { kind: "kneel" } | { kind: "spike" };

const yds = (fx: number) => fx / ONE;
const lead = (s: GameState, side: Side) => s.score[side] - s.score[other(side)];
const lateGame = (s: GameState, cfgSecs: number) => s.quarter >= 4 && cfgSecs <= 300;

export function tempoFor(s: GameState, data: GameData): Tempo {
  const t = secondsLeft(s, data.rules);
  const l = lead(s, s.possession);
  if ((s.quarter === 2 && t <= 120) || (s.quarter >= 4 && t <= 300 && l < 0)) return "hurry";
  if (s.quarter >= 4 && l > 0 && t <= 420) return "milk";
  return "normal";
}

/** Who (if anyone) burns a timeout before this snap. */
export function timeoutFor(s: GameState, data: GameData): Side | null {
  if (!s.clockRunning || s.ot) return null;
  const t = secondsLeft(s, data.rules);
  const off = s.possession, def = other(off);
  const endOfHalf = (s.quarter === 2 || s.quarter >= 4) && t <= 120;
  if (!endOfHalf) return null;
  if (lead(s, off) <= 0 && s.timeouts[off] > 0 && (s.quarter >= 4 || yds(s.ballOn) > 45)) return off;
  if (s.quarter >= 4 && lead(s, def) < 0 && lead(s, def) >= -16 && s.timeouts[def] > 0) return def;
  return null;
}

function weightedPick<T extends { weight: number }>(items: T[], rng: Rng): T {
  const w = items.map((i) => Math.max(1, Math.round(i.weight * 10)));
  return items[rng.weighted(w)]!;
}

/** Pass probability (per mille) by situation. */
function passRate(s: GameState, data: GameData): number {
  const d = s.down, togo = yds(s.toGo), t = secondsLeft(s, data.rules), l = lead(s, s.possession);
  let p = 560;
  if (d === 1) p = 500;
  if (d === 2) p = togo >= 7 ? 640 : togo <= 3 ? 400 : 540;
  if (d >= 3) p = togo >= 5 ? 880 : togo <= 2 ? 330 : 680;
  if (s.quarter >= 4 && t <= 300) p += l < 0 ? 250 : l > 0 ? -320 : 0;
  if (s.quarter === 2 && t <= 120) p += 200;
  return Math.max(100, Math.min(970, p));
}

export function chooseScrimmage(s: GameState, offense: Roster, defense: Roster, data: GameData, ratings: (id: number) => Stats, rng: Rng): ScrimmageDecision {
  const t = secondsLeft(s, data.rules);
  const l = lead(s, s.possession);
  const ballOn = yds(s.ballOn), togo = yds(s.toGo);
  const kin = { data, ratings };
  const k = offense.starters.K!;

  // victory formation / end of half
  if (!s.ot && s.quarter >= 4 && l > 0 && t <= (5 - s.down) * data.rules.runoffSeconds.milk + 5 && s.timeouts[other(s.possession)] === 0) return { kind: "kneel" };
  if (!s.ot && s.quarter >= 4 && l > 0 && t <= 40 && s.down < 4) return { kind: "kneel" };
  if (!s.ot && s.quarter === 2 && t <= 30 && ballOn < 40 && s.down < 4) return { kind: "kneel" };

  const dist = fgDistance(s.ballOn, data);
  const fgP = fgMakePerMille(dist, k, kin);
  // last-second field goal
  if (!s.ot && (s.quarter === 2 || s.quarter >= 4) && t <= 6 && fgP >= 250 && (s.quarter === 2 || (l <= 0 && l >= -3))) return { kind: "fieldGoal" };

  if (s.down === 4) {
    const desperate = !s.ot && s.quarter >= 4 && t <= 240 && l < 0;
    const otNeed = s.ot !== null;
    if (otNeed) {
      if (togo <= 3 && ballOn >= 65 && !(fgP >= 600 && (s.ot!.possIdx === 0 || l === 0))) return goForIt();
      return fgP >= 150 ? { kind: "fieldGoal" } : goForIt();
    }
    if (desperate && !(l >= -3 && fgP >= 500)) return goForIt();
    if (fgP >= 600 && !(togo <= 1 && ballOn >= 60 && ballOn <= 95)) return { kind: "fieldGoal" };
    if (togo <= 1 && ballOn >= 40) return goForIt();
    if (togo <= 2 && ballOn >= 55 && ballOn < 70) return goForIt();
    if (ballOn >= 62 && fgP >= 350) return { kind: "fieldGoal" };
    if (ballOn >= 62 && togo <= 4) return goForIt();
    return { kind: "punt" };
  }
  return goForIt();

  function goForIt(): ScrimmageDecision {
    const pass = rng.int(1000) < passRate(s, data);
    const short = togo <= 2;
    let plays = data.offense.plays.filter((p) => p.kind === (pass ? "pass" : "run") && p.weight > 0);
    if (!pass && short) plays = plays.filter((p) => p.tags.includes("short") || p.tags.includes("inside"));
    if (pass && togo >= 12) plays = plays.filter((p) => p.tags.some((t2) => t2 === "deep" || t2 === "medium")).concat(plays.filter(() => false));
    if (pass && ballOn >= 90) plays = plays.filter((p) => !p.tags.includes("deep"));
    if (!plays.length) plays = data.offense.plays.filter((p) => p.kind === (pass ? "pass" : "run"));
    if (!pass && short && togo <= 1 && rng.int(1000) < 250) plays = data.offense.plays.filter((p) => p.tags.includes("sneak"));
    const play = weightedPick(plays.length ? plays : data.offense.plays, rng);
    return { kind: "play", play, call: chooseDefense(s, data, rng), flip: rng.int(2) === 1 };
  }
}

export function chooseDefense(s: GameState, data: GameData, rng: Rng): DefenseCall {
  const togo = yds(s.toGo), d = s.down, t = secondsLeft(s, data.rules);
  const defLead = lead(s, other(s.possession));
  const calls = data.defense.calls.map((c) => {
    let w = c.weight;
    if (d >= 3 && togo >= 7) { if (c.tags.includes("run")) w *= 0.2; if (c.tags.includes("blitz") || c.id === "cover2" || c.id === "cover4") w *= 1.8; }
    if (togo <= 2) { if (c.tags.includes("run")) w *= 2.5; if (c.id === "cover4") w *= 0.3; }
    if (d === 1) { if (c.tags.includes("run")) w *= 1.3; }
    if (s.quarter >= 4 && t <= 120 && defLead > 0) { if (c.tags.includes("prevent")) w *= 3; if (c.tags.includes("blitz")) w *= 0.2; }
    return { ...c, weight: w };
  });
  return weightedPick(calls, rng);
}

/** Extra point or two-point try, from a standard chart. */
export function chooseTry(s: GameState, options: ("pat" | "twoPoint")[]): "pat" | "twoPoint" {
  if (!options.includes("pat")) return "twoPoint";
  if (s.ot) return "pat";
  const l = lead(s, s.possession); // already includes the 6 points
  if (s.quarter >= 4 && [-2, -5, -10, 1, 5, -13].includes(l)) return "twoPoint";
  return "pat";
}
