// AI coach: situational decisions for both sides. Deterministic given the Rng.
import type { DefenseCall, GameData, OffensePlay } from "@tdf/shared";
import { ONE } from "./fixed.js";
import type { Rng } from "./rng.js";
import { other, secondsLeft, type GameState, type Side, type Tempo } from "./rules.js";
import type { Roster } from "./roster.js";
import { fgDistance, fgMakePerMille } from "./engine/kicks.js";
import type { Stats } from "./engine/play.js";

/** A full offensive call: play, formation and personnel, plus the defense's answer. */
export interface PlayCall { play: OffensePlay; formation: string; personnel: string; flip: boolean }
export interface DefCall { call: DefenseCall; front: string }
export type ScrimmageDecision =
  | ({ kind: "play" } & PlayCall & DefCall)
  | { kind: "punt" } | { kind: "fieldGoal" } | { kind: "kneel" } | { kind: "spike" };

/** What each side has shown this game (the AI reads it; the UI shows it as a scouting report). */
export interface Tendencies {
  /** run/pass calls by situation bucket */
  calls: Record<string, { run: number; pass: number }>;
  formations: Record<string, number>;
  personnel: Record<string, number>;
  /** defense: snaps, blitzes, man coverage */
  defSnaps: number; blitz: number; man: number;
}
export const emptyTendencies = (): Tendencies => ({ calls: {}, formations: {}, personnel: {}, defSnaps: 0, blitz: 0, man: 0 });
export function situation(s: GameState): string {
  const togo = s.toGo / ONE;
  if (s.down === 1) return "1st";
  const d = s.down === 2 ? "2nd" : "3rd";
  return togo <= 3 ? `${d} & short` : togo >= 7 ? `${d} & long` : `${d} & medium`;
}
export function recordOffense(t: Tendencies, s: GameState, c: PlayCall) {
  const b = (t.calls[situation(s)] ??= { run: 0, pass: 0 });
  if (c.play.kind === "pass") b.pass++; else b.run++;
  t.formations[c.formation] = (t.formations[c.formation] ?? 0) + 1;
  t.personnel[c.personnel] = (t.personnel[c.personnel] ?? 0) + 1;
}
export function recordDefense(t: Tendencies, c: DefenseCall) {
  t.defSnaps++;
  if (c.tags.includes("blitz")) t.blitz++;
  if (c.man) t.man++;
}
/** Observed run rate overall, or in one situation, shrunk toward the league default. */
export function runRate(t: Tendencies | undefined, data: GameData, sit?: string): number {
  const prior = data.coach.tendency.prior;
  const base = 0.45;
  if (!t) return base;
  let run = 0, pass = 0;
  for (const [k, v] of Object.entries(t.calls)) if (!sit || k === sit) { run += v.run; pass += v.pass; }
  return (run + base * prior) / (run + pass + prior);
}

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

export function chooseScrimmage(s: GameState, offense: Roster, defense: Roster, data: GameData, ratings: (id: number) => Stats, rng: Rng, offTend?: Tendencies, oppDefense?: Tendencies): ScrimmageDecision {
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
    const c = chooseOffensePlay(s, offense, data, ratings, rng, oppDefense);
    return { kind: "play", ...c, ...chooseDefense(s, data, rng, c.personnel, defense, offTend) };
  }
}

/** Pick a play, then a formation and personnel group that fit it and the situation. */
export function chooseOffensePlay(s: GameState, offense: Roster, data: GameData, ratings: (id: number) => Stats, rng: Rng, oppDefense?: Tendencies): PlayCall {
  const t = secondsLeft(s, data.rules);
  const l = lead(s, s.possession);
  const ballOn = yds(s.ballOn), togo = yds(s.toGo);
  const C = data.coach;
  const all = data.offense.plays;
  // Hail Mary at the end of a half from midfield
  const HM = C.hailMary;
  if (!s.ot && (s.quarter === 2 || (s.quarter >= 4 && l < 0 && l >= -8)) && t <= HM.maxSeconds && ballOn >= HM.minBallOn && ballOn <= HM.maxBallOn) {
    const hm = all.find((p) => p.tags.includes("hailMary"));
    if (hm) return withFormation(hm, "passing");
  }
  const pass = rng.int(1000) < passRate(s, data);
  const short = togo <= 2;
  const qbSpeed = ratings(offense.starters.QB!.id).speed ?? 60;
  const qbRun = Math.max(C.qbRun.min, Math.min(C.qbRun.max, 1 + (qbSpeed - C.qbRun.speedRef) * C.qbRun.speedPer));
  const blitzy = oppDefense && oppDefense.defSnaps >= 6 ? oppDefense.blitz / oppDefense.defSnaps : 0.2;
  const isRunish = (p: OffensePlay) => p.kind !== "pass";
  let plays = all.filter((p) => isRunish(p) !== pass && p.weight > 0);
  if (!pass && short) plays = plays.filter((p) => p.tags.includes("short") || p.tags.includes("inside"));
  if (pass && togo >= 12) plays = plays.filter((p) => p.tags.some((t2) => t2 === "deep" || t2 === "medium"));
  if (pass && ballOn >= 90) plays = plays.filter((p) => !p.tags.includes("deep"));
  if (ballOn >= 95) plays = plays.filter((p) => !p.tags.includes("screen"));
  if (!plays.length) plays = all.filter((p) => isRunish(p) !== pass && p.weight > 0);
  if (!pass && short && togo <= 1 && rng.int(1000) < 250) plays = all.filter((p) => p.tags.includes("sneak"));
  const weighted = plays.map((p) => {
    let w = p.weight;
    if (p.tags.includes("qbRun") || p.tags.includes("option")) w *= qbRun;
    // a blitz-happy defense gets screens and quick throws
    if (p.tags.includes("screen") || p.tags.includes("quick")) w *= 0.7 + blitzy * 2;
    if (p.tags.includes("redzone")) w *= ballOn >= 80 ? 3 : 0.3;
    if (p.tags.includes("goalLine")) w *= ballOn >= 95 ? 3 : 1;
    return { ...p, weight: w, orig: p };
  });
  const play = weightedPick(weighted.length ? weighted : all.map((p) => ({ ...p, orig: p })), rng).orig;
  const sitKey = ballOn >= 96 ? "goalLine" : togo <= 3 && !pass ? "short" : pass && (togo >= 8 || t <= 120) ? "passing" : "normal";
  return withFormation(play, sitKey);

  function withFormation(play: OffensePlay, sitKey: keyof GameData["coach"]["personnel"]): PlayCall {
    const pref = C.personnel[sitKey];
    const opts: { f: string; p: string; weight: number }[] = [];
    for (const fid of play.formations) {
      const f = data.formations.offense.find((x) => x.id === fid);
      if (!f) continue;
      for (const p of f.personnel) opts.push({ f: fid, p, weight: (pref[p] ?? 0.5) / 10 });
    }
    const o = weightedPick(opts, rng);
    return { play, formation: o.f, personnel: o.p, flip: rng.int(2) === 1 };
  }
}

/** Deterministic "Suggested" list for the play-call screen: the coach's weights for this down,
 *  distance, field position and the opponent's tendencies, best first (one entry per play). */
export function suggestPlays(s: GameState, offense: Roster, data: GameData, ratings: (id: number) => Stats, oppDefense?: Tendencies, n = 8): PlayCall[] {
  const ballOn = yds(s.ballOn), togo = yds(s.toGo), t = secondsLeft(s, data.rules);
  const C = data.coach;
  const pr = passRate(s, data) / 1000;
  const qbSpeed = ratings(offense.starters.QB!.id).speed ?? 60;
  const qbRun = Math.max(C.qbRun.min, Math.min(C.qbRun.max, 1 + (qbSpeed - C.qbRun.speedRef) * C.qbRun.speedPer));
  const blitzy = oppDefense && oppDefense.defSnaps >= 6 ? oppDefense.blitz / oppDefense.defSnaps : 0.2;
  const scored = data.offense.plays.filter((p) => p.weight > 0 || (p.tags.includes("sneak") && togo <= 1)).map((p) => {
    const pass = p.kind === "pass";
    let w = (p.weight || 1) * (pass ? pr : 1 - pr);
    if (!pass && togo <= 2 && !(p.tags.includes("short") || p.tags.includes("inside") || p.tags.includes("sneak"))) w *= 0.2;
    if (pass && togo >= 12 && !p.tags.some((x) => x === "deep" || x === "medium")) w *= 0.2;
    if (pass && ballOn >= 90 && p.tags.includes("deep")) w *= 0.1;
    if (ballOn >= 95 && p.tags.includes("screen")) w *= 0.1;
    if (p.tags.includes("qbRun") || p.tags.includes("option")) w *= qbRun;
    if (p.tags.includes("screen") || p.tags.includes("quick")) w *= 0.7 + blitzy * 2;
    if (p.tags.includes("redzone")) w *= ballOn >= 80 ? 3 : 0.3;
    if (p.tags.includes("goalLine")) w *= ballOn >= 95 ? 3 : 1;
    if (p.tags.includes("sneak")) w *= togo <= 1 ? 2 : 0;
    return { p, w };
  }).sort((a, b) => b.w - a.w || a.p.id.localeCompare(b.p.id)).slice(0, n);
  const sitKey = ballOn >= 96 ? "goalLine" : togo <= 3 ? "short" : togo >= 8 || t <= 120 ? "passing" : "normal";
  const pref = C.personnel[sitKey];
  return scored.map(({ p }) => {
    let best = { f: p.formations[0]!, per: "", w: -1 };
    for (const fid of p.formations) {
      const f = data.formations.offense.find((x) => x.id === fid);
      if (!f) continue;
      for (const per of f.personnel) { const w = pref[per] ?? 0; if (w > best.w) best = { f: fid, per, w }; }
    }
    return { play: p, formation: best.f, personnel: best.per || data.formations.offense.find((x) => x.id === best.f)!.personnel[0]!, flip: false };
  });
}

/** The defense's front (answering the offense's personnel) and call. */
export function chooseDefense(s: GameState, data: GameData, rng: Rng, personnel = "11", defense?: Roster, offTend?: Tendencies): DefCall {
  const togo = yds(s.toGo), d = s.down, t = secondsLeft(s, data.rules);
  const ballOn = yds(s.ballOn);
  const defLead = lead(s, other(s.possession));
  const C = data.coach;
  const prevent = s.quarter >= 4 && t <= 120 && defLead > 0 && defLead <= 8 && ballOn < 60;
  let front: string;
  if (ballOn >= 97 || (togo <= 1 && ["22", "23", "13"].includes(personnel))) front = C.goalLineFront;
  else if (prevent && rng.int(1000) < 500) front = C.preventFront;
  else if (d >= 3 && togo >= 8 && ["10", "11", "01", "20"].includes(personnel)) front = C.passingDownFront;
  else {
    const opts = C.frontFor[personnel] ?? ["base"];
    front = opts[rng.int(opts.length)]!;
  }
  if (front === "base") front = defense?.baseFront ?? C.baseFront;
  // the opponent's observed run rate in this situation tilts run vs pass calls
  const rr = runRate(offTend, data, situation(s));
  const runBias = Math.max(1 / C.tendency.runBiasMax, Math.min(C.tendency.runBiasMax, rr / 0.45));
  const calls = data.defense.calls.filter((c) => !c.notFrom.includes(front)).map((c) => {
    let w = c.weight;
    if (d >= 3 && togo >= 7) { if (c.tags.includes("run")) w *= 0.2; if (c.tags.includes("blitz") || c.id === "cover2" || c.id === "cover4") w *= 1.6; }
    if (togo <= 2) { if (c.tags.includes("run")) w *= 2.5; if (c.id === "cover4" || c.tags.includes("prevent")) w *= 0.2; }
    if (d === 1) { if (c.tags.includes("run")) w *= 1.3; }
    if (c.tags.includes("run")) w *= runBias;
    if (c.tags.includes("prevent")) w *= prevent ? 8 : 0.1;
    if (c.tags.includes("blitz") && prevent) w *= 0.2;
    return { ...c, weight: w, orig: c };
  });
  return { call: weightedPick(calls, rng).orig, front };
}

/** Extra point or two-point try, from a standard chart. */
export function chooseTry(s: GameState, options: ("pat" | "twoPoint")[]): "pat" | "twoPoint" {
  if (!options.includes("pat")) return "twoPoint";
  if (s.ot) return "pat";
  const l = lead(s, s.possession); // already includes the 6 points
  if (s.quarter >= 4 && [-2, -5, -10, 1, 5, -13].includes(l)) return "twoPoint";
  return "pat";
}
