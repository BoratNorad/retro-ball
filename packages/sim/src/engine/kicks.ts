// Kicking game for M2: rating-driven models (full swipe-kicking physics arrives in M6).
// Integer per-mille probabilities and the seeded Rng keep it deterministic.
import type { Creature, GameData } from "@tdf/shared";
import { fromInt, fx, ONE, type Fx } from "../fixed.js";
import type { Rng } from "../rng.js";
import type { PlayOutcome } from "../rules.js";
import type { Roster } from "../roster.js";
import type { StatEvent, Stats } from "./play.js";

export interface KickInput {
  data: GameData; rng: Rng; ratings: (id: number) => Stats;
  kicking: Roster; receiving: Roster; kickSide: 0 | 1;
}
export interface KickResult { outcome: PlayOutcome; stats: StatEvent[]; log: string[] }

const r = (inp: KickInput, c: Creature, k: string) => inp.ratings(c.id)[k] ?? 50;
const jitter = (rng: Rng, amp: number) => ((rng.int(2001) - 1000) / 1000) * amp;

/** Best returner on a roster by the KR role overall (bench players count). */
export function returner(ro: Roster): Creature {
  const all = [...Object.values(ro.starters), ...ro.bench];
  return all.reduce((b, c) => ((c.overallAt.KR ?? 0) > (b.overallAt.KR ?? 0) ? c : b));
}

export function kickoff(inp: KickInput, from: Fx): KickResult {
  const T = inp.data.tuning.kicking, hz = inp.data.rules.tickHz;
  const k = inp.kicking.starters.K!;
  const kr = returner(inp.receiving);
  const dist = T.kickoffBase + T.kickoffPer * (r(inp, k, "kickPower") - 50) + jitter(inp.rng, T.kickoffJitter);
  const land = from / ONE + dist;
  const log = [`${k.name} kicks off ${Math.round(dist)} yds`];
  if (land >= 100) {
    log.push("touchback");
    return { outcome: { play: "kickoff", endY: fromInt(105), elapsedTicks: 0 }, stats: [], log };
  }
  const krRating = kr.overallAt.KR ?? 60;
  if (inp.rng.int(1000) < T.returnTdPerMille * (krRating / 75)) {
    log.push(`${kr.name} takes it the distance!`);
    return { outcome: { play: "kickoff", endY: fromInt(-1), elapsedTicks: T.kickoffSeconds * hz + hz * 4 }, stats: [], log };
  }
  const ret = Math.max(0, T.returnMeanBase + T.returnPer * (krRating - 70) + jitter(inp.rng, T.returnJitter));
  const endY = Math.max(1, Math.min(99, Math.round(land - ret)));
  log.push(`${kr.name} returns ${Math.round(land - endY)} yds`);
  return {
    outcome: { play: "kickoff", endY: fromInt(endY), elapsedTicks: T.kickoffSeconds * hz },
    stats: [{ k: "rush", id: kr.id, team: inp.kickSide === 0 ? 1 : 0, yds: 0, att: 0 }], log,
  };
}

export function punt(inp: KickInput, ballOn: Fx): KickResult {
  const T = inp.data.tuning.kicking, hz = inp.data.rules.tickHz;
  const p = inp.kicking.starters.P!;
  const kr = returner(inp.receiving);
  const yl = ballOn / ONE;
  let gross = T.puntBase + T.puntPer * (r(inp, p, "kickPower") - 50) + jitter(inp.rng, T.puntJitter);
  const log: string[] = [];
  // pin it deep: a good punter aims short of the end zone instead of booting a touchback
  if (yl + gross > 95) {
    const acc = r(inp, p, "kickAccuracy");
    if (inp.rng.int(1000) < 350 + acc * 5) gross = 100 - yl - (3 + inp.rng.int(12));
  }
  const land = yl + gross;
  log.push(`${p.name} punts ${Math.round(gross)} yds`);
  if (land >= 100) {
    log.push("touchback");
    return { outcome: { play: "punt", endY: fromInt(105), elapsedTicks: T.puntSeconds * hz }, stats: [], log };
  }
  if (land > 90 || inp.rng.int(1000) < T.fairCatchPerMille) {
    log.push(land > 90 ? "downed" : `fair catch by ${kr.name}`);
    return { outcome: { play: "punt", endY: fx(land), elapsedTicks: T.puntSeconds * hz }, stats: [], log };
  }
  const krRating = kr.overallAt.KR ?? 60;
  const ret = Math.max(-2, T.puntReturnMean + (krRating - 70) * 0.1 + jitter(inp.rng, T.puntReturnJitter));
  const endY = Math.max(1, Math.round(land - ret));
  log.push(`${kr.name} returns ${Math.round(land - endY)} yds`);
  return { outcome: { play: "punt", endY: fromInt(endY), elapsedTicks: T.puntSeconds * hz + hz * 2 }, stats: [], log };
}

/** Field-goal distance (yards) from a spot: end zone + snap depth. */
export const fgDistance = (ballOn: Fx, data: GameData) => Math.round(100 - ballOn / ONE + 10 + data.rules.spots.fgSnapDepth);

export function fgRange(k: Creature, inp: Pick<KickInput, "data" | "ratings">): number {
  const T = inp.data.tuning.kicking;
  return T.fgRangeBase + T.fgRangePer * ((inp.ratings(k.id).kickPower ?? 70) - 70) * 2;
}

export function fgMakePerMille(dist: number, k: Creature, inp: Pick<KickInput, "data" | "ratings">): number {
  const T = inp.data.tuning.kicking;
  const acc = inp.ratings(k.id).kickAccuracy ?? 70;
  const range = fgRange(k, inp);
  if (dist > range + 4) return 0;
  let p = T.fgMakeShort - T.fgDropPerYardAfter35 * Math.max(0, dist - 35) - T.fgDropPerYardAfter50 * Math.max(0, dist - 50)
    + T.fgAccPer * (acc - 80);
  if (dist > range) p -= (dist - range) * 120;
  return Math.round(Math.max(0, Math.min(995, p)));
}

export function fieldGoal(inp: KickInput, ballOn: Fx): KickResult & { dist: number } {
  const T = inp.data.tuning.kicking, hz = inp.data.rules.tickHz;
  const k = inp.kicking.starters.K!;
  const dist = fgDistance(ballOn, inp.data);
  const good = inp.rng.int(1000) < fgMakePerMille(dist, k, inp);
  return {
    dist,
    outcome: { play: "fieldGoal", endY: ballOn, good, elapsedTicks: T.kickSeconds * hz },
    stats: [], log: [`${k.name} ${dist}-yd field goal is ${good ? "GOOD" : "NO GOOD"}`],
  };
}

export function pat(inp: KickInput, ballOn: Fx): KickResult {
  const T = inp.data.tuning.kicking;
  const k = inp.kicking.starters.K!;
  const p = T.patBase + T.patPer * ((inp.ratings(k.id).kickAccuracy ?? 70) - 70);
  const good = inp.rng.int(1000) < Math.min(995, p);
  return { outcome: { play: "pat", endY: ballOn, good, elapsedTicks: 0 }, stats: [], log: [`extra point ${good ? "good" : "NO GOOD"}`] };
}
