// Special teams at 30 Hz (M6): kick physics (gravity, drag, wind, curve, bounces), field goals and
// PATs through real uprights, kickoffs (deep / squib / onside) and punts with live 22-man coverage and
// returns, fair catches, muffs, loose-ball recoveries and blocked kicks. Fixed-point and seeded like
// the scrimmage engine, so a kick replays exactly from (state, units, seed, inputs).
//
// Frame: the kicking team kicks toward +y (its own goal line y = 0, the receiving goal line y = 100,
// end line y = 110). A return heads toward y = 0.
import type { GameData, PlayerCard, Tuning } from "@tdf/shared";
import * as F from "../fixed.js";
import type { Fx, V2 } from "../fixed.js";
import type { Rng } from "../rng.js";
import type { PlayOutcome } from "../rules.js";
import type { Roster } from "../roster.js";
import type { ActorView, KickKind, KickView, PlayResult, PlaySim, PlaySnapshot, StatEvent, Stats, UserInput } from "./play.js";

const { fx, mul, div, idiv, ONE, vsub, vadd, vlen, vnorm, vscale, vdist } = F;

export interface KickPlayInput {
  data: GameData;
  ratings: (id: number) => Stats;
  kicking: Roster; receiving: Roster;
  kickSide: 0 | 1;
  kind: KickKind;
  /** kickoff: the kick spot; punt / FG / PAT: the line of scrimmage (kicking frame) */
  spot: Fx; ballX: Fx;
  rng: Rng;
  /** wind in mph, as a vector in the kicking frame */
  wind: V2;
  /** last two minutes of the 4th quarter / overtime */
  pressure: boolean;
  /** a human kicks: the play waits for UserInput.kick */
  userKick?: boolean;
  /** a human returns (controls the returner; onside / loose balls: the nearest man) */
  userReturn?: boolean;
  /** a human on the kicking team in a loose-ball scramble (onside kick) */
  userKickTeam?: boolean;
  /** the return team's wall side (from the returner's point of view on the screen: L / M / R in the kicking frame) */
  returnSide?: "L" | "M" | "R";
  /** receiving team's call vs a punt / FG: all-out block, safe (fake watch), or normal */
  stDefense?: "block" | "safe" | "normal";
  record?: boolean;
}
export interface KickMeta {
  kind: KickKind; gross: number; returnYds: number; returner: number | null;
  blocked: boolean; touchback: boolean; fairCatch: boolean; outOfBounds: boolean; muffed: boolean; kickingRecovered: boolean;
  returnTd: boolean;
}
export interface KickPlayResult extends PlayResult { meta: KickMeta }
export interface KickSim extends PlaySim { result(): KickPlayResult }

type Task = "kick" | "block" | "cover" | "rush" | "jam" | "wall" | "return" | "deep" | "chase" | "idle";
interface A {
  i: number; c: PlayerCard; st: Stats; side: "O" | "D"; role: string; task: Task;
  pos: V2; vel: V2; maxSpeed: Fx; accel: Fx;
  laneX: Fx; engagedWith: number; shedTick: number; stunTil: number; lastTry: number; target: number;
}
type Ball = {
  state: "held" | "air" | "loose" | "dead";
  holder: number;
  p: V2; h: Fx; v: V2; vh: Fx; rolling: boolean;
};

const DEG = (d: number) => fx((d * Math.PI) / 180);

/** Ballistic step shared by the play and the AI's aiming / chance estimates. */
interface Flight { p: V2; h: Fx; v: V2; vh: Fx }
function flightStep(b: Flight, drag: Fx, acc: V2, g: Fx, dt: Fx) {
  b.v = { x: b.v.x + mul(acc.x - mul(drag, b.v.x), dt), y: b.v.y + mul(acc.y - mul(drag, b.v.y), dt) };
  b.vh = b.vh + mul(-g - mul(drag, b.vh), dt);
  b.p = vadd(b.p, vscale(b.v, dt));
  b.h = b.h + mul(b.vh, dt);
}

interface Launch { v: V2; vh: Fx; curve: V2 }
/** Launch vector for a kick: aim (radians from straight downfield, + = right), power 0..1, curve -1..1. */
function launch(T: Tuning, kind: KickKind, kickPower: number, aim: Fx, power: Fx, curve: Fx): Launch {
  const S = T.special;
  const vmax = S.speedBase + S.speedPer * (kickPower - 50);
  const mult = kind === "squib" ? S.squibMult : kind === "onside" ? S.onsideMult : 1;
  const speed = mul(fx(vmax * mult), F.lerp(fx(S.minPower), ONE, F.clamp(power, 0, ONE)));
  const elev = DEG(kind === "fieldGoal" ? S.elevFg : kind === "pat" ? S.elevPat : kind === "punt" ? S.elevPunt
    : kind === "kickoff" ? S.elevKickoff : kind === "squib" ? S.elevSquib : S.elevOnside);
  const [ce, se] = F.cosSin(elev);
  const ground = mul(speed, ce);
  const [ca, sa] = F.cosSin(aim);
  const dir = { x: sa, y: ca };
  // curve acts sideways (perpendicular to the launch direction)
  const side = { x: ca, y: -sa };
  return { v: vscale(dir, ground), vh: mul(speed, se), curve: vscale(side, mul(fx(S.curveAccel), F.clamp(curve, -ONE, ONE))) };
}
const dragOf = (T: Tuning, kind: KickKind) => fx(kind === "fieldGoal" || kind === "pat" ? T.special.dragFg : kind === "punt" ? T.special.dragPunt
  : kind === "kickoff" ? T.special.dragKickoff : kind === "squib" ? T.special.dragSquib : T.special.dragOnside);

/** Where a kick comes down (first time below `height` going down), and its hang time in seconds. */
export function predictFlight(data: GameData, kind: KickKind, kickPower: number, from: V2, aim: Fx, power: Fx, curve: Fx, windMph: V2, height = 0):
  { land: V2; hang: number; atPosts: { x: Fx; h: Fx } | null } {
  const T = data.tuning, hz = data.rules.tickHz, dt = idiv(ONE, hz);
  const L = launch(T, kind, kickPower, aim, power, curve);
  const b: Flight = { p: from, h: fx(0.6), v: L.v, vh: L.vh };
  const acc = vadd(vscale(windMph, fx(T.special.windAccel)), L.curve);
  let atPosts: { x: Fx; h: Fx } | null = null;
  for (let t = 1; t < hz * 10; t++) {
    const y0 = b.p.y;
    flightStep(b, dragOf(T, kind), acc, fx(T.special.gravity), dt);
    if (!atPosts && y0 < fx(110) && b.p.y >= fx(110)) atPosts = { x: b.p.x, h: b.h };
    if (b.vh < 0 && b.h <= fx(height)) return { land: b.p, hang: t / hz, atPosts };
  }
  return { land: b.p, hang: 10, atPosts };
}

/** Accuracy cone half-width (radians) and power error for a kicker. */
export function kickErrors(data: GameData, kickAccuracy: number, kind: KickKind, pressure: boolean, fgDist = 0): { aim: number; power: number } {
  const S = data.tuning.special;
  let aim = S.aimErrBase + S.aimErrPer * (99 - kickAccuracy);
  let power = S.powerErrBase + S.powerErrPer * (99 - kickAccuracy);
  if (pressure) { aim *= S.pressureMult; power *= S.pressureMult; }
  if ((kind === "fieldGoal") && fgDist >= S.longFgFrom) { aim *= S.longFgMult; power *= S.longFgMult; }
  return { aim, power };
}

/** The AI's kick: field goals aim through the middle with wind compensation and just enough leg;
 *  punts go long or to the coffin corner; kickoffs deep. Returns aim/power/curve (Fx). */
export function aiKick(data: GameData, kind: KickKind, kickPower: number, from: V2, windMph: V2, rng: Rng, opts: { target?: V2 } = {}): { aim: Fx; power: Fx; curve: Fx } {
  const W = fx(data.tuning.field.width);
  if (kind === "fieldGoal" || kind === "pat") {
    const goal = { x: W / 2, y: fx(110) };
    let aim = F.atan2(goal.x - from.x, goal.y - from.y);
    // the least power that clears the bar with a margin (more leg = less wind drift = keep it simple)
    let power = ONE;
    for (let p = 450; p <= 1000; p += 50) {
      const f = predictFlight(data, kind, kickPower, from, aim, fx(p / 1000), 0, windMph);
      if (f.atPosts && f.atPosts.h > fx(data.tuning.special.crossbar + 2.2)) { power = fx(p / 1000); break; }
    }
    for (let k = 0; k < 3; k++) {
      const f = predictFlight(data, kind, kickPower, from, aim, power, 0, windMph);
      if (!f.atPosts) break;
      aim -= div(f.atPosts.x - goal.x, F.max(fx(10), goal.y - from.y));
    }
    return { aim, power, curve: 0 };
  }
  if (kind === "punt" && opts.target) {
    const t = opts.target;
    const aim = F.atan2(t.x - from.x, t.y - from.y);
    let best = ONE, bd = fx(1e4);
    for (let p = 300; p <= 1000; p += 50) {
      const f = predictFlight(data, kind, kickPower, from, aim, fx(p / 1000), 0, windMph);
      const d = F.abs(f.land.y - t.y);
      if (d < bd) { bd = d; best = fx(p / 1000); }
    }
    return { aim, power: best, curve: 0 };
  }
  if (kind === "onside") return { aim: fx(((rng.int(2) ? 1 : -1) * (250 + rng.int(250))) / 1000), power: fx(0.6), curve: 0 };
  if (kind === "squib") return { aim: fx((rng.int(401) - 200) / 1000), power: fx(0.8), curve: 0 };
  return { aim: fx((rng.int(161) - 80) / 1000), power: ONE, curve: 0 };
}

/** Make chance (per-mille) of a field goal / PAT for this kicker and wind (deterministic estimate). */
export function kickChance(data: GameData, kickPower: number, kickAccuracy: number, kind: "fieldGoal" | "pat", ballOn: Fx, windMph: V2, pressure: boolean): number {
  const S = data.tuning.special, W = fx(data.tuning.field.width);
  const from = { x: W / 2, y: ballOn - fx(data.rules.spots.fgSnapDepth) };
  const dist = Math.round((fx(110) - from.y) / ONE);
  const base = aiKick(data, kind, kickPower, from, windMph, { int: () => 0 } as unknown as Rng);
  const e = kickErrors(data, kickAccuracy, kind, pressure, dist);
  let good = 0, n = 0;
  for (let ai = -8; ai <= 8; ai++) for (let pi = -3; pi <= 3; pi++) {
    const f = predictFlight(data, kind, kickPower, from, base.aim + fx((e.aim * ai) / 8), F.clamp(base.power + fx((e.power * pi) / 3), 0, ONE), 0, windMph);
    n++;
    if (f.atPosts && F.abs(f.atPosts.x - W / 2) <= fx(S.postsHalfWidth) && f.atPosts.h >= fx(S.crossbar)) good++;
  }
  return Math.round((1000 * good) / n);
}

/** Pick the special-teams units for a kick. */
function units(inp: KickPlayInput) {
  const R = (c: PlayerCard, k: string) => inp.ratings(c.id)[k] ?? 50;
  const all = (ro: Roster) => [...new Map([...Object.values(ro.starters), ...ro.bench].map((c) => [c.id, c])).values()];
  const pick = (ro: Roster, n: number, score: (c: PlayerCard) => number, taken: Set<number>) => {
    const list = all(ro).filter((c) => !taken.has(c.id) && !["K", "P", "QB"].includes(c.pos)).sort((a, b) => score(b) - score(a) || a.id - b.id).slice(0, n);
    for (const c of list) taken.add(c.id);
    return list;
  };
  return { R, all, pick };
}

export function createKick(inp: KickPlayInput): KickSim {
  const { data, rng, kind } = inp;
  const T: Tuning = data.tuning, S = T.special;
  const hz = data.rules.tickHz, DT = idiv(ONE, hz);
  const sec = (s: number) => Math.max(1, Math.round(s * hz));
  const W = fx(T.field.width);
  const bx = inp.ballX;
  const L = inp.spot;
  const recvSide = (inp.kickSide === 0 ? 1 : 0) as 0 | 1;
  const log: string[] = [];
  const stats: StatEvent[] = [];
  const { R: RC, pick } = units(inp);
  const isFg = kind === "fieldGoal" || kind === "pat";
  const isKickoff = kind === "kickoff" || kind === "squib" || kind === "onside";
  const stMode = inp.stDefense ?? "normal";
  const windAcc = vscale(inp.wind, fx(S.windAccel));
  const windMph = Math.round(vlen(inp.wind) / ONE);

  // ------------------------------------------------------------------ actors
  const actors: A[] = [];
  const mk = (c: PlayerCard, side: "O" | "D", role: string, task: Task, x: number, y: Fx): A => {
    const st = inp.ratings(c.id);
    const g = (k: string) => st[k] ?? 50;
    const a: A = {
      i: actors.length, c, st, side, role, task,
      pos: { x: F.clamp(bx + fx(x), fx(1), W - fx(1)), y }, vel: { x: 0, y: 0 },
      maxSpeed: fx(T.movement.speedBase + T.movement.speedPer * g("speed")),
      accel: fx(T.movement.accelBase + T.movement.accelPer * g("acceleration")),
      laneX: 0, engagedWith: -1, shedTick: 0, stunTil: 0, lastTry: -999, target: -1,
    };
    a.laneX = a.pos.x;
    actors.push(a);
    return a;
  };
  const takenK = new Set<number>(), takenR = new Set<number>();
  const kicker = isKickoff || isFg ? inp.kicking.starters.K! : inp.kicking.starters.P!;
  takenK.add(kicker.id);
  const coverScore = (c: PlayerCard) => RC(c, "speed") * 0.5 + RC(c, "tackle") * 0.3 + RC(c, "pursuit") * 0.2;
  const blockScore = (c: PlayerCard) => RC(c, "runBlock") * 0.35 + RC(c, "strength") * 0.25 + RC(c, "speed") * 0.4;
  const protScore = (c: PlayerCard) => RC(c, "passBlock") * 0.5 + RC(c, "strength") * 0.3 + RC(c, "speed") * 0.2;
  const rushScore = (c: PlayerCard) => RC(c, "blockShedding") * 0.4 + RC(c, "strength") * 0.3 + RC(c, "speed") * 0.3;
  // the returner: the best kick returner (bench counts)
  const recvAll = [...Object.values(inp.receiving.starters), ...Object.values(inp.receiving.depth ?? {}), ...inp.receiving.bench];
  const chosen = kind === "punt" ? inp.receiving.pr ?? inp.receiving.kr : inp.receiving.kr;
  const krCard = recvAll.find((c) => c.id === chosen) ?? recvAll.filter((c) => !["K", "P", "QB"].includes(c.pos))
    .reduce((b, c) => ((c.overallAt.KR ?? 0) > (b.overallAt.KR ?? 0) ? c : b));
  takenR.add(krCard.id);
  let returner: A;
  let kickerA: A;
  let holder: A | null = null;
  const cY = (dy: number) => L + fx(dy);
  if (isKickoff) {
    kickerA = mk(kicker, "O", "K", "kick", 0, cY(-4));
    const lanes = [-23, -18, -13, -8, -3.5, 3.5, 8, 13, 18, 23];
    const cov = pick(inp.kicking, 10, coverScore, takenK);
    cov.forEach((c, k) => mk(c, "O", "ST", "cover", lanes[k]!, cY(-1.5)));
    const front = pick(inp.receiving, 5, blockScore, takenR);
    [-16, -8, 0, 8, 16].forEach((x, k) => mk(front[k]!, "D", "ST", "wall", x, cY(kind === "onside" ? 11 : 12)));
    const mid = pick(inp.receiving, 4, blockScore, takenR);
    [-12, -4, 4, 12].forEach((x, k) => mk(mid[k]!, "D", "ST", "wall", x, cY(kind === "onside" ? 18 : 27)));
    const kr2 = pick(inp.receiving, 1, (c) => c.overallAt.KR ?? 0, takenR)[0]!;
    returner = mk(krCard, "D", "KR", "return", -5, F.min(cY(60), fx(107)));
    mk(kr2, "D", "ST", "wall", 5, F.min(cY(58), fx(105)));
  } else if (kind === "punt") {
    const ls = inp.kicking.starters.LS!;
    takenK.add(ls.id);
    mk(ls, "O", "LS", "block", 0, cY(-0.6));
    const line = pick(inp.kicking, 6, protScore, takenK);
    [-6.2, -4, -2, 2, 4, 6.2].forEach((x, k) => mk(line[k]!, "O", "ST", "block", x, cY(-0.8)));
    const pp = pick(inp.kicking, 1, protScore, takenK)[0]!;
    mk(pp, "O", "PP", "block", 0, cY(-5.5));
    const gun = pick(inp.kicking, 2, (c) => RC(c, "speed") * 0.7 + RC(c, "tackle") * 0.3, takenK);
    mk(gun[0]!, "O", "G", "cover", -21, cY(-0.8)); mk(gun[1]!, "O", "G", "cover", 21, cY(-0.8));
    kickerA = mk(kicker, "O", "P", "kick", 0, cY(-14));
    const nRush = stMode === "block" ? 8 : stMode === "safe" ? 5 : 6;
    const rush = pick(inp.receiving, nRush, rushScore, takenR);
    const xs = nRush === 8 ? [-7, -5, -3, -1, 1, 3, 5, 7] : nRush === 5 ? [-5, -2.5, 0, 2.5, 5] : [-6, -3.6, -1.2, 1.2, 3.6, 6];
    rush.forEach((c, k) => mk(c, "D", "ST", "rush", xs[k]!, cY(1)));
    const nJam = 10 - nRush;
    const jam = pick(inp.receiving, nJam, (c) => RC(c, "press") * 0.4 + RC(c, "speed") * 0.6, takenR);
    jam.forEach((c, k) => mk(c, "D", "ST", nJam === 5 && k === 4 ? "deep" : "jam", nJam === 5 && k === 4 ? 0 : (k % 2 ? 1 : -1) * (20 + (k >> 1) * 1.5), cY(nJam === 5 && k === 4 ? 12 : 1.2)));
    returner = mk(krCard, "D", "PR", "return", 0, F.min(cY(43), fx(104)));
  } else {
    // field goal / PAT: the line, two wings, the holder (punter) and the kicker
    const ls = inp.kicking.starters.LS!;
    takenK.add(ls.id);
    mk(ls, "O", "LS", "block", 0, cY(-0.6));
    const line = pick(inp.kicking, 8, protScore, takenK);
    [-2.2, 2.2, -4.4, 4.4, -6.6, 6.6].forEach((x, k) => mk(line[k]!, "O", "ST", "block", x, cY(-0.8)));
    mk(line[6]!, "O", "ST", "block", -7.6, cY(-1.8)); mk(line[7]!, "O", "ST", "block", 7.6, cY(-1.8));
    const hc = inp.kicking.starters.P!;
    takenK.add(hc.id);
    holder = mk(hc, "O", "H", "block", 0, cY(-7));
    kickerA = mk(kicker, "O", "K", "kick", -1.5, cY(-9.5));
    const nRush = stMode === "block" ? 10 : stMode === "safe" ? 7 : 9;
    const rush = pick(inp.receiving, nRush, rushScore, takenR);
    const xs = [-8, 8, -6, 6, -4, 4, -2, 2, 0, -9];
    rush.forEach((c, k) => mk(c, "D", "ST", "rush", xs[k]!, cY(1)));
    const back = pick(inp.receiving, 10 - nRush, (c) => RC(c, "zoneCoverage") + RC(c, "speed"), takenR);
    back.forEach((c, k) => mk(c, "D", "ST", "deep", (k % 2 ? 1 : -1) * (6 + 4 * (k >> 1)), cY(10)));
    returner = mk(krCard, "D", "R", "deep", 0, cY(12));
  }
  const K = actors.filter((a) => a.side === "O");
  const Rt = actors.filter((a) => a.side === "D");
  const R = (a: A, k: string) => a.st[k] ?? 50;

  // ------------------------------------------------------------------ ball and kick command
  const kickPoint: V2 = isKickoff ? { x: bx, y: L } : isFg ? { x: bx, y: L - fx(data.rules.spots.fgSnapDepth) } : { x: bx, y: L - fx(14) };
  const kAcc = R(kickerA, "kickAccuracy"), kPow = R(kickerA, "kickPower");
  const fgDist = Math.round((fx(110) - kickPoint.y) / ONE);
  const err = kickErrors(data, kAcc, kind, inp.pressure, fgDist);
  const ball: Ball = { state: "held", holder: isKickoff ? -1 : actors.find((a) => a.role === "LS")!.i, p: isKickoff ? kickPoint : { x: bx, y: L }, h: isKickoff ? 0 : fx(0.5), v: { x: 0, y: 0 }, vh: 0, rolling: false };
  let phase: KickView["phase"] = inp.userKick ? "setup" : "approach";
  let command: { aim: Fx; power: Fx; curve: Fx } | null = null;
  if (!inp.userKick) {
    let target: V2 | undefined;
    if (kind === "punt" && L / ONE >= data.coach.special.coffinFrom) {
      // coffin corner: aim for the sideline short of the goal line
      const side = rng.int(2) ? 1 : -1;
      target = { x: W / 2 + fx(side * (T.field.width / 2 - 6)), y: fx(data.coach.special.coffinTarget) };
    }
    command = aiKick(data, kind, kPow, kickPoint, inp.wind, rng, { target });
  }
  const approachTicks = sec(isKickoff ? S.kickoffApproach : kind === "punt" ? S.puntGetOff : S.fgOperation);
  let tick = 0, kickTick = -1, done = false;
  let curve: V2 = { x: 0, y: 0 };
  let good: boolean | null = null;
  let landing: V2 | null = null;
  let landTick = -1;
  let touchedByReturn = false, fairCatchCalled = false, kneelCalled = false, letItGo = false;
  let carrier: A | null = null;
  let catchTried = false;
  let ended: { endY: Fx; endX: Fx; reason: string } | null = null;
  const meta: KickMeta = { kind, gross: 0, returnYds: 0, returner: null, blocked: false, touchback: false, fairCatch: false, outOfBounds: false, muffed: false, kickingRecovered: false, returnTd: false };
  let catchY: Fx = 0;
  const moveUntil = { juke: -1, spin: -1, burst: -1, dive: -1 };
  const moveReady = { juke: 0, spin: 0, burst: 0, dive: 0 };
  let userMove: V2 | null = null;
  let userPlayer = -1;

  // ------------------------------------------------------------------ movement
  function steer(a: A, goal: V2, mult: Fx = ONE) {
    const to = vsub(goal, a.pos);
    const dist = vlen(to);
    let maxV = mul(a.maxSpeed, mult);
    if (a.engagedWith >= 0) maxV = mul(maxV, fx(T.movement.engagedSpeedMult));
    if (carrier === a) {
      maxV = mul(maxV, fx(T.movement.carryingSpeedMult));
      if (moveUntil.burst > tick) maxV = mul(maxV, fx(T.user.burstSpeedMult));
    }
    const want = dist < fx(0.3) ? { x: 0, y: 0 } : vscale(vnorm(to), dist < ONE ? mul(maxV, dist) : maxV);
    const dv = vsub(want, a.vel), dvl = vlen(dv), maxDv = mul(a.accel, DT);
    a.vel = dvl <= maxDv ? want : vadd(a.vel, vscale(vnorm(dv), maxDv));
  }
  function intercept(ch: A, tg: A): V2 {
    const sp = F.max(ch.maxSpeed, ONE), cap = fx(T.coverage.pursuitMaxTime);
    let t = F.min(div(vdist(ch.pos, tg.pos), sp), cap);
    for (let k = 0; k < 3; k++) t = F.min(div(vdist(ch.pos, vadd(tg.pos, vscale(tg.vel, t))), sp), cap);
    return vadd(tg.pos, vscale(tg.vel, t));
  }
  const ballGround = (): V2 => ball.state === "held" && ball.holder >= 0 ? actors[ball.holder]!.pos : ball.p;

  // ------------------------------------------------------------------ AI goals
  function goalFor(a: A): V2 {
    if (a.stunTil > tick) return a.pos;
    if (a.engagedWith >= 0) return actors[a.engagedWith]!.pos;
    if (userPlayer === a.i && userMove && (userMove.x !== 0 || userMove.y !== 0)) return vadd(a.pos, vscale(vnorm(userMove), fx(5)));
    if (carrier === a) return carrierGoal(a);
    if (phase === "setup") return a.pos;
    if (phase === "loose") return ball.p;
    if (carrier) {
      // a return is on: cover men pursue, return men block the nearest unblocked cover man
      if (a.side !== carrier.side) return intercept(a, carrier);
      return blockGoal(a);
    }
    const kicked = kickTick >= 0;
    switch (a.task) {
      case "kick":
        if (!kicked) return a.role === "K" && isKickoff ? kickPoint : a.role === "P" ? { x: bx, y: L - fx(14) } : { x: kickPoint.x - fx(0.8), y: kickPoint.y - fx(0.6) };
        return isFg ? a.pos : { x: a.pos.x, y: a.pos.y + fx(1) };
      case "block":
        if (kind === "punt" && kicked && tick > kickTick + sec(0.3)) return coverGoal(a);
        return a.pos;
      case "cover":
        if (kind === "punt" && !kicked) return { x: a.pos.x, y: a.pos.y + fx(2) };
        return coverGoal(a);
      case "rush":
        if (kind === "punt" && kicked) return wallGoal(a);
        return kickPoint;
      case "jam": {
        const g = nearest(K.filter((k) => k.role === "G"), a.pos);
        return g ? { x: g.pos.x, y: g.pos.y + fx(0.8) } : a.pos;
      }
      case "wall": return kicked ? wallGoal(a) : a.pos;
      case "return": return returnerGoal(a);
      case "deep": return a.pos;
      default: return a.pos;
    }
  }
  function nearest(list: A[], p: V2): A | null {
    let b: A | null = null, bd = fx(1e4);
    for (const a of list) { const d = vdist(a.pos, p); if (d < bd) { bd = d; b = a; } }
    return b;
  }
  function coverGoal(a: A): V2 {
    const tgt = landing ?? ball.p;
    // stay in the lane, then squeeze to the ball as it comes down
    const total = F.max(fx(5), tgt.y - kickPoint.y);
    const k = F.clamp(div(a.pos.y - kickPoint.y, total), 0, ONE);
    return { x: F.lerp(a.laneX, tgt.x, mul(k, k)), y: tgt.y - fx(2) };
  }
  const sideOff = inp.returnSide === "L" ? -1 : inp.returnSide === "R" ? 1 : 0;
  function wallGoal(a: A): V2 {
    const tgt = landing ?? ball.p;
    // set up between the coverage and the catch, shifted toward the wall side
    const lane = F.clamp(a.laneX + mul(tgt.x - a.laneX, fx(0.5)) + fx(sideOff * 6), fx(2), W - fx(2));
    return { x: lane, y: F.max(tgt.y - fx(14), F.min(a.pos.y, tgt.y - fx(6))) };
  }
  function blockGoal(a: A): V2 {
    let t = a.target >= 0 ? actors[a.target]! : null;
    if (!t || t.engagedWith >= 0 || t.stunTil > tick) {
      t = null; let bd = fx(14);
      for (const k of K) {
        if (k.engagedWith >= 0 || k.stunTil > tick) continue;
        if (carrier && k.pos.y > carrier.pos.y + fx(2)) continue; // already past the returner
        const d = vdist(k.pos, a.pos) + idiv(vdist(k.pos, carrier!.pos), 2);
        if (d < bd) { bd = d; t = k; }
      }
      a.target = t ? t.i : -1;
    }
    if (!t) return { x: a.pos.x, y: a.pos.y - fx(2) };
    return vadd(t.pos, vscale(vnorm(vsub(carrier!.pos, t.pos)), fx(1)));
  }
  function returnerGoal(a: A): V2 {
    if (ball.state === "air") {
      if (letItGo) return { x: landing!.x, y: F.min(landing!.y - fx(6), a.pos.y) };
      return landing ?? a.pos;
    }
    if (ball.state === "loose") return ball.p;
    return a.pos;
  }
  let laneDir: V2 | null = null, laneUntil = -1;
  function carrierGoal(a: A): V2 {
    if (inp.userReturn && userMove && (userMove.x !== 0 || userMove.y !== 0)) return vadd(a.pos, vscale(vnorm(userMove), fx(5)));
    if (tick < laneUntil && laneDir) return vadd(a.pos, vscale(laneDir, fx(5)));
    // early: run to the wall side; then pick the open lane (toward y = 0)
    let best: V2 = { x: a.pos.x, y: a.pos.y - fx(5) }, bestScore = -1e9;
    for (const deg of T.carrier.laneAngles) {
      const d = F.vfromAngle(DEG(-90 + deg), ONE);
      let score = (-d.y / ONE) * T.carrier.forwardWeight * 10;
      if (tick - catchTick < sec(1.2) && sideOff) score += (d.x / ONE) * sideOff * 8;
      for (const e of K) {
        if (e.engagedWith >= 0 || e.stunTil > tick) continue;
        const rel = vsub(e.pos, a.pos), along = F.vdot(rel, d);
        if (along < 0 || along > fx(10)) continue;
        const perp = F.abs(mul(rel.x, d.y) - mul(rel.y, d.x));
        if (perp < fx(3)) score -= ((fx(3) - perp) / ONE) * ((fx(10) - along) / ONE) * 1.5;
      }
      const end = vadd(a.pos, vscale(d, fx(4)));
      if (end.x < fx(2) || end.x > W - fx(2)) score -= 25;
      score += (rng.int(1000) / 1000 - 0.5) * T.carrier.visionNoisePerMissing * (99 - R(a, "bCVision")) * 10;
      if (score > bestScore) { bestScore = score; best = vadd(a.pos, vscale(d, fx(5))); }
    }
    laneDir = vnorm(vsub(best, a.pos));
    laneUntil = tick + Math.max(2, Math.round(T.carrier.replanTicksBase - T.carrier.replanPerAgility * R(a, "agility")));
    return best;
  }
  let catchTick = 0;

  // ------------------------------------------------------------------ contacts
  function engage() {
    const blockers = actors.filter((a) => a.engagedWith < 0 && a.stunTil <= tick &&
      ((a.side === "O" && (a.task === "block" || a.task === "kick") && kickTick < 0) ||
       (a.side === "D" && (a.task === "jam" && kickTick < 0 || (carrier && carrier.side === "D" && a !== carrier)))));
    for (const b of blockers) {
      const opp = b.side === "O" ? Rt : K;
      for (const d of opp) {
        if (d.engagedWith >= 0 || d.stunTil > tick || d === carrier || vdist(b.pos, d.pos) > fx(T.blocking.engageRange)) continue;
        if (b.side === "O" && d.task !== "rush") continue;
        if (b.task === "jam" && d.role !== "G") continue;
        const pass = b.side === "O";
        const blk = pass ? (R(b, "passBlock") * 2 + R(b, "strength")) / 3 : (R(b, "runBlock") + R(b, "impactBlocking") + R(b, "strength")) / 3;
        const shed = (R(d, "blockShedding") * 2 + R(d, "strength")) / 3;
        const base = pass ? T.blocking.passHoldBase : b.task === "jam" ? 0.9 : T.blocking.runHoldBase * 0.55;
        const per = pass ? T.blocking.passHoldPer : T.blocking.runHoldPer;
        const hold = Math.max(0.2, base + per * (blk - shed) + (rng.int(1000) / 1000 - 0.5) * 0.6);
        b.engagedWith = d.i; d.engagedWith = b.i;
        b.shedTick = d.shedTick = tick + sec(hold);
        break;
      }
    }
    for (const a of actors) if (a.engagedWith >= 0 && tick >= a.shedTick) {
      const o = actors[a.engagedWith]!;
      a.engagedWith = -1; if (o.engagedWith === a.i) o.engagedWith = -1;
      // the blocker is the one left standing a moment
      const blk = a.side === (carrier?.side ?? "D") ? a : o;
      blk.stunTil = tick + sec(T.blocking.shedStun);
    }
  }
  const clampPm = (p: number) => Math.round(Math.max(T.tackle.min, Math.min(T.tackle.max, p)));
  function tackles() {
    const c = carrier;
    if (!c) return;
    const near = (c.side === "D" ? K : Rt).filter((d) => d.engagedWith < 0 && d.stunTil <= tick && vdist(d.pos, c.pos) < fx(T.tackle.range));
    for (const d of near) {
      if (tick - d.lastTry < sec(0.5)) continue;
      d.lastTry = tick;
      const moves = [R(c, "breakTackle"), (R(c, "jukeMove") + R(c, "agility")) / 2, (R(c, "trucking") + R(c, "strength")) / 2, R(c, "stiffArm") * 0.92, (R(c, "spinMove") + R(c, "agility")) / 2];
      const best = Math.max(...moves), avg = moves.reduce((x, y) => x + y, 0) / moves.length;
      const elusive = best * T.tackle.elusiveMaxWeight + avg * (1 - T.tackle.elusiveMaxWeight);
      let bonus = 0;
      if (moveUntil.juke > tick) bonus = T.user.moveBonusBase + T.user.moveBonusPer * (R(c, "jukeMove") - 60);
      else if (moveUntil.spin > tick) bonus = T.user.moveBonusBase + T.user.moveBonusPer * (R(c, "spinMove") - 60);
      const p = clampPm(T.tackle.base + T.tackle.per * (R(d, "tackle") - elusive) + T.tackle.powerPer * (R(d, "hitPower") - R(c, "strength")) + (near.length - 1) * T.tackle.gangBonus - bonus);
      if (rng.int(1000) < p) {
        stats.push({ k: "tackle", id: d.c.id, team: d.side === "O" ? inp.kickSide : recvSide });
        const fp = Math.max(T.tackle.fumbleMin, Math.min(T.tackle.fumbleMax, T.tackle.fumbleBase + T.tackle.fumblePer * (R(d, "hitPower") - R(c, "carrying"))));
        if (rng.int(1000) < fp && rng.int(1000) >= T.tackle.fumbleOffenseRecover) {
          log.push(`FUMBLE by ${c.c.name}, recovered by ${d.c.name}`);
          stats.push({ k: "fumble", id: c.c.id, team: c.side === "D" ? recvSide : inp.kickSide }, { k: "fumbleLost", id: c.c.id, team: c.side === "D" ? recvSide : inp.kickSide });
          if (c.side === "D") { meta.kickingRecovered = true; }
          end(c.pos.y, c.pos.x, "fumble");
          return;
        }
        log.push(`${c.c.name} tackled by ${d.c.name}`);
        const fwd = Math.max(0, (-c.vel.y * (c.side === "D" ? 1 : -1)) / ONE);
        const ff = fwd < 0.3 ? 0 : Math.min(T.tackle.fallForwardMax, T.tackle.fallForwardBase + fwd * T.tackle.fallForwardPerSpeed * 0.4);
        end(c.pos.y + fx(ff) * (c.side === "D" ? -1 : 1), c.pos.x, "tackle");
        return;
      }
      d.stunTil = tick + sec(T.tackle.missStun);
      c.vel = vscale(c.vel, fx(1 - T.tackle.carrierSlowOnMiss));
    }
  }

  function end(y: Fx, x: Fx, reason: string) {
    if (ended) return;
    ended = { endY: y, endX: x, reason };
    phase = "dead";
    ball.state = "dead";
  }

  // ------------------------------------------------------------------ the kick
  function doKick() {
    kickTick = tick;
    phase = "flight";
    const cmd = command!;
    // a block? the rush against the protection, before the ball gets up
    if (!isKickoff) {
      const rushers = Rt.filter((d) => d.task === "rush");
      const best = Math.max(...rushers.map((d) => (R(d, "blockShedding") + R(d, "strength") + R(d, "speed")) / 3));
      const prot = K.filter((k) => k.task === "block").reduce((s, k) => s + (R(k, "passBlock") + R(k, "strength")) / 2, 0) / Math.max(1, K.filter((k) => k.task === "block").length);
      let p = S.blockBase + S.blockPer * (best - prot);
      p *= stMode === "block" ? S.blockModeMult : stMode === "safe" ? S.safeModeMult : 1;
      p *= kind === "punt" ? S.puntBlockMult : kind === "pat" ? S.patBlockMult : 1;
      if (rng.int(1000) < Math.max(1, Math.round(p))) {
        meta.blocked = true; good = false;
        const blocker = nearest(rushers, kickPoint)!;
        log.push(`BLOCKED by ${blocker.c.name}!`);
        ball.state = "loose"; ball.holder = -1;
        ball.p = vadd(kickPoint, { x: 0, y: fx(1) }); ball.h = fx(1.5);
        ball.v = { x: fx((rng.int(2001) - 1000) / 200), y: -fx(2 + rng.int(4)) }; ball.vh = fx(3);
        touchedByReturn = true;
        phase = "loose";
        return;
      }
    }
    const aErr = fx((err.aim * (rng.int(2001) - 1000)) / 1000);
    const pErr = fx((err.power * (rng.int(2001) - 1000)) / 1000);
    const Lh = launch(T, kind, kPow, cmd.aim + aErr, F.clamp(cmd.power + pErr, 0, ONE), cmd.curve);
    curve = Lh.curve;
    ball.state = "air"; ball.holder = -1;
    ball.p = kickPoint; ball.h = fx(isFg || isKickoff ? 0.2 : 1.0); ball.v = Lh.v; ball.vh = Lh.vh;
    const pr = predictFlight(data, kind, kPow, kickPoint, cmd.aim + aErr, F.clamp(cmd.power + pErr, 0, ONE), cmd.curve, inp.wind, S.catchHeight - 0.4);
    landing = pr.land; landTick = tick + Math.round(pr.hang * hz);
    meta.gross = Math.round((F.min(pr.land.y, fx(100)) - L) / ONE);
    log.push(`${kickerA.c.name} ${isFg ? "kicks" : kind === "punt" ? "punts" : kind === "onside" ? "onside kick" : kind === "squib" ? "squib kick" : "kicks off"}${isFg ? "" : ` (${Math.round((pr.land.y - kickPoint.y) / ONE)} yds in the air)`}`);
    // the return man decides how to handle a punt: let it go near the goal line, fair catch with
    // coverage close
    if (!isFg && kind !== "onside") {
      if (kind === "punt" && landing.y >= fx(91) && !inp.userReturn) letItGo = true;
    }
  }

  function airTick() {
    const y0 = ball.p.y;
    flightStep(ball, dragOf(T, kind), vadd(windAcc, curve), fx(S.gravity), DT);
    if (isFg && good === null && y0 < fx(110) && ball.p.y >= fx(110)) {
      good = F.abs(ball.p.x - W / 2) <= fx(S.postsHalfWidth) && ball.h >= fx(S.crossbar);
      log.push(`${fgDist}-yd ${kind === "pat" ? "extra point" : "field goal"} is ${good ? "GOOD" : "NO GOOD"}`);
    }
    if (isFg) {
      if (ball.h <= 0 || ball.p.y > fx(118)) {
        if (good === null) { good = false; log.push(`${fgDist}-yd ${kind === "pat" ? "extra point" : "field goal"} is NO GOOD (short)`); }
        end(L, bx, "fg");
      }
      return;
    }
    // catch
    if (!catchTried && ball.vh < 0 && ball.h <= fx(S.catchHeight) && !letItGo) {
      const ret = nearest(Rt, ball.p)!;
      if (vdist(ret.pos, ball.p) <= fx(S.catchRange) && ret.engagedWith < 0) {
        catchTried = true;
        const traffic = K.some((k) => vdist(k.pos, ret.pos) < fx(2));
        const p = S.catchBase + S.catchPer * (R(ret, "catching") - 70) - (traffic ? S.catchTraffic : 0);
        touchedByReturn = true;
        if (rng.int(1000) < p) { caught(ret); return; }
        meta.muffed = true;
        log.push(`MUFFED by ${ret.c.name}!`);
        ball.state = "loose"; ball.vh = fx(1.5); ball.v = { x: fx((rng.int(2001) - 1000) / 400), y: fx((rng.int(2001) - 1000) / 400) };
        phase = "loose";
        return;
      }
    }
    if (ball.p.x < 0 || ball.p.x > W) { outOfBounds(); return; }
    if (ball.h <= 0) { bounce(); phase = "loose"; }
  }
  function bounce() {
    ball.h = 0;
    const rest = kind === "onside" ? S.onsideRestitution : S.restitution;
    const r = (rng.int(1001) + 300) / 1000;
    ball.vh = mul(-ball.vh, fx(rest * r));
    const sp = vlen(ball.v);
    ball.v = { x: mul(ball.v.x, fx(S.friction)) + mul(sp, fx((S.scatter * (rng.int(2001) - 1000)) / 1000)), y: mul(ball.v.y, fx(S.friction)) };
    if (ball.vh < fx(1)) { ball.vh = 0; ball.rolling = true; }
  }
  function looseTick() {
    if (ball.rolling) {
      const sp = vlen(ball.v), dec = mul(fx(S.rollFriction), DT);
      ball.v = sp <= dec ? { x: 0, y: 0 } : vscale(vnorm(ball.v), sp - dec);
      ball.p = vadd(ball.p, vscale(ball.v, DT));
    } else {
      flightStep(ball, dragOf(T, kind), { x: 0, y: 0 }, fx(S.gravity), DT);
      if (ball.h <= 0) bounce();
    }
    if (ball.p.x < 0 || ball.p.x > W) { outOfBounds(); return; }
    if (ball.p.y >= fx(isKickoff || kind === "punt" ? 100 : 200) && !meta.blocked) {
      // into the end zone: touchback (the receiving team downs it)
      if (!touchedByReturn || isKickoff) { touchback(); return; }
    }
    if (ball.p.y <= fx(1) && meta.blocked) { end(fx(1), ball.p.x, "deadAtOne"); return; }
    if (ball.h > fx(1.3)) return;
    const traveled = ball.p.y - kickPoint.y;
    const canKick = isKickoff ? traveled >= fx(S.onsideTravel) || touchedByReturn : touchedByReturn;
    // a kicking-team player downs a dying punt nobody touched
    if (kind === "punt" && !touchedByReturn && !meta.blocked) {
      const k = nearest(K, ball.p)!;
      if (vdist(k.pos, ball.p) <= fx(S.downRange) && vlen(ball.v) < fx(4)) { log.push(`downed by ${k.c.name}`); end(ball.p.y, ball.p.x, "downed"); return; }
    }
    // recovery tries
    type Cand = { a: A; w: number };
    const cands: Cand[] = [];
    for (const a of actors) {
      if (a.stunTil > tick || vdist(a.pos, ball.p) > fx(S.recoverRange)) continue;
      if (a.side === "O" && !canKick) continue;
      if (isFg && a === kickerA) continue;
      const field = a.side === "D" && !meta.muffed && !meta.blocked;
      let p = field ? S.fieldBase + S.fieldPer * (R(a, "catching") - 70) : S.recoverBase + S.recoverPer * (R(a, "catching") - 60);
      if (a.i === userPlayer && moveUntil.dive > tick) p += S.diveBonus;
      cands.push({ a, w: p });
    }
    if (cands.length) {
      const roll = cands.map((c) => ({ c, r: rng.int(1000) })).filter((x) => x.r < x.c.w).sort((p, q) => p.r / p.c.w - q.r / q.c.w);
      const win = roll[0]?.c.a;
      if (win) {
        if (win.side === "O") {
          // a blocked punt or field goal recovered by the kickers behind the line is just dead (their down is used up)
          meta.kickingRecovered = !meta.blocked;
          log.push(`recovered by ${win.c.name} (${kind === "onside" ? "onside kick!" : "kicking team"})`);
          end(ball.p.y, ball.p.x, "kickRecovery");
          return;
        }
        touchedByReturn = true;
        if (kind === "onside") { log.push(`${win.c.name} recovers the onside kick`); end(ball.p.y, ball.p.x, "recovered"); return; }
        caught(win);
        return;
      }
    }
    if (ball.rolling && vlen(ball.v) < fx(0.3) && cands.length === 0) {
      // nobody wants it: dead where it stopped (receiving team's ball)
      const near = nearest(Rt, ball.p)!;
      if (vdist(near.pos, ball.p) > fx(3) || kind === "punt") { log.push("the ball comes to rest"); end(ball.p.y, ball.p.x, "dead"); }
    }
  }
  function outOfBounds() {
    meta.outOfBounds = true;
    if (isKickoff && !touchedByReturn) { log.push("kick out of bounds"); end(fx(60), W / 2, "kickOob"); return; }
    log.push("out of bounds");
    end(F.min(ball.p.y, fx(99)), ball.p.x < 0 ? 0 : W, "oob");
  }
  function touchback() {
    meta.touchback = true;
    log.push("touchback");
    end(fx(105), W / 2, "touchback");
  }
  function caught(a: A) {
    ball.state = "held"; ball.holder = a.i;
    carrier = a; catchY = a.pos.y; catchTick = tick;
    phase = "return";
    meta.returner = a.c.id;
    if (meta.blocked) { log.push(`${a.c.name} scoops it up`); return; }
    if (fairCatchCalled) {
      meta.fairCatch = true; log.push(`fair catch by ${a.c.name}`);
      end(a.pos.y, a.pos.x, "fairCatch"); return;
    }
    log.push(`caught by ${a.c.name}`);
    if (isKickoff && a.pos.y >= fx(100)) {
      const deep = a.pos.y >= fx(100 + S.kneelDepth);
      if (kneelCalled || (!inp.userReturn && deep)) { touchback(); return; }
    }
    if (!inp.userReturn && kind === "punt" && !meta.muffed) {
      // fair catch when the coverage is on top of him
      const k = nearest(K, a.pos)!;
      const eta = div(vdist(k.pos, a.pos), F.max(k.maxSpeed, ONE));
      if (eta < fx(S.fairCatchEta) || a.pos.y >= fx(95)) { meta.fairCatch = true; log.push(`(fair catch)`); end(a.pos.y, a.pos.x, "fairCatch"); }
    }
  }

  // ------------------------------------------------------------------ human input
  function applyUser(u: UserInput | null | undefined) {
    userMove = u?.move ?? null;
    if (!u) return;
    if (phase === "setup" && inp.userKick && u.kick) {
      command = { aim: fx(u.kick.aim / 1000), power: fx(Math.max(0, Math.min(1000, u.kick.power)) / 1000), curve: fx(Math.max(-1000, Math.min(1000, u.kick.curve)) / 1000) };
      phase = "approach";
      return;
    }
    if (u.action === "fairCatch" && inp.userReturn && ball.state === "air") { fairCatchCalled = true; log.push("fair catch signal"); }
    if (u.action === "kneel" && inp.userReturn) {
      kneelCalled = true;
      if (carrier && carrier.side === "D" && carrier.pos.y >= fx(100) && isKickoff) touchback();
    }
    if (u.action === "dive" && userPlayer >= 0 && tick >= moveReady.dive) { moveUntil.dive = tick + sec(0.4); moveReady.dive = tick + sec(1); }
    const c = carrier;
    if (c && inp.userReturn && c.side === "D" && (u.action === "juke" || u.action === "spin" || u.action === "burst") && tick >= moveReady[u.action]) {
      const k = u.action;
      moveUntil[k] = tick + sec(k === "burst" ? T.user.burstSeconds : T.user.moveSeconds);
      moveReady[k] = tick + sec(k === "burst" ? T.user.burstCooldown : T.user.moveCooldown);
      if (k !== "burst" && userMove) {
        const side = vnorm({ x: -userMove.y, y: userMove.x });
        c.vel = vadd(c.vel, vscale(side, fx(T.user.cutSideSpeed * (tick % 2 === 0 ? 1 : -1))));
      }
    }
  }
  function pickUserPlayer() {
    // loose-ball scramble: control the nearest man of your team; a return: the carrier
    if (carrier && inp.userReturn && carrier.side === "D") { userPlayer = carrier.i; return; }
    if (phase === "loose" && (inp.userReturn || inp.userKickTeam)) {
      const mine = inp.userReturn ? Rt : K;
      userPlayer = nearest(mine, ball.p)?.i ?? -1;
      return;
    }
    userPlayer = inp.userReturn && returner ? returner.i : -1;
  }

  // ------------------------------------------------------------------ main loop
  const maxTicks = sec(S.maxSeconds);
  function step(input?: UserInput | null): boolean {
    if (done) return true;
    applyUser(input);
    if (phase === "setup") return false;
    if (ended) { done = true; return true; }
    pickUserPlayer();
    // the snap and the hold (punt/FG), or the kicker's run-up
    if (phase === "approach") {
      if (!isKickoff) {
        // the snap travels back to the punter / holder
        const depth = kind === "punt" ? 14 : 7, snapT = sec(kind === "punt" ? S.puntSnap : 0.4);
        if (tick < snapT) { ball.state = "air"; ball.p = { x: bx, y: L - mul(fx(depth), idiv(tick * ONE, snapT)) }; ball.h = fx(1); }
        else { ball.state = "held"; ball.holder = (kind === "punt" ? kickerA : holder!).i; }
      }
      if (tick >= approachTicks) doKick();
    } else if (phase === "flight") airTick();
    else if (phase === "loose") looseTick();
    if (ended) { done = true; tick++; return true; }
    for (const a of actors) steer(a, goalFor(a));
    for (const a of actors) a.pos = vadd(a.pos, vscale(a.vel, DT));
    engage();
    if (phase === "return" && carrier) {
      ball.p = carrier.pos;
      const c = carrier;
      if (c.pos.x < 0 || c.pos.x > W) { log.push(`${c.c.name} out of bounds`); end(c.pos.y, c.pos.x, "oob"); }
      else if (c.side === "D" && c.pos.y <= 0) { meta.returnTd = true; log.push(`${c.c.name} takes it to the house!`); end(fx(-1), c.pos.x, "td"); }
      else tackles();
    }
    tick++;
    if (!ended && tick >= maxTicks) end(ball.state === "held" && carrier ? carrier.pos.y : ball.p.y, ball.p.x, "time");
    if (ended) done = true;
    return done;
  }

  function snapshot(): PlaySnapshot {
    const view: KickView = {
      kind, phase, awaitingKick: phase === "setup", cone: fx(err.aim), spot: kickPoint, target: { x: W / 2, y: fx(110) },
      wind: inp.wind, windMph, canFairCatch: Boolean(inp.userReturn && ball.state === "air" && !isFg && !fairCatchCalled),
      canKneel: Boolean(inp.userReturn && isKickoff && carrier && carrier.side === "D" && carrier.pos.y >= fx(100)),
      userPlayer, good,
    };
    const hb = ball.state === "held" && ball.holder >= 0 ? actors[ball.holder]!.pos : ball.p;
    return {
      tick, done, los: L,
      actors: actors.map((a): ActorView => ({ x: a.pos.x, y: a.pos.y, vx: a.vel.x, vy: a.vel.y, side: a.side, role: a.role, num: a.c.num, id: a.c.id, down: false })),
      ball: { x: hb.x, y: hb.y, h: ball.state === "held" ? fx(1) : ball.h, state: ball.state === "loose" ? "loose" : ball.state, holder: ball.holder },
      qbCanThrow: false, carrier: carrier ? carrier.i : -1, userCarrier: Boolean(inp.userReturn && carrier && carrier.side === "D"),
      userDefender: -1, canKeep: false, presnap: phase === "setup", routes: [], assign: [],
      cooldowns: { juke: Math.max(0, moveReady.juke - tick), spin: Math.max(0, moveReady.spin - tick), burst: Math.max(0, moveReady.burst - tick) },
      log, kick: view,
    };
  }

  let cached: KickPlayResult | null = null;
  function result(): KickPlayResult {
    if (cached) return cached;
    if (!done) throw new Error("kick still running");
    const e = ended ?? { endY: ball.p.y, endX: ball.p.x, reason: "time" };
    const playKind = isKickoff ? "kickoff" : kind;
    // gross = line of scrimmage to where the kick was fielded or died (touchback: the goal line)
    if (!meta.blocked && !isFg) {
      const at = meta.touchback ? fx(100) : carrier && carrier.side === "D" ? catchY : e.endY;
      meta.gross = Math.round((F.min(at, fx(100)) - L) / ONE);
    }
    let endY = e.endY;
    if (carrier && carrier.side === "D" && !meta.fairCatch && !meta.touchback) {
      meta.returnYds = Math.max(0, Math.round((catchY - F.max(endY, 0)) / ONE));
      if (!meta.blocked) stats.push({ k: kind === "punt" ? "pr" : "kr", id: carrier.c.id, team: recvSide, att: 1, yds: meta.returnYds, td: meta.returnTd ? 1 : 0 });
      // a tackle in his own end zone after a catch there is a touchback, not a safety
      if (endY >= fx(100)) { endY = fx(105); meta.touchback = true; }
    }
    const outcome: PlayOutcome = {
      play: playKind as PlayOutcome["play"],
      endY: isFg ? L : endY,
      elapsedTicks: Math.max(0, tick - Math.max(0, kickTick)) + (isKickoff ? 0 : sec(1)),
      good: isFg ? Boolean(good) : undefined,
      kickingTeamRecovered: meta.kickingRecovered || undefined,
      kickOutOfBounds: e.reason === "kickOob" || undefined,
    };
    if (isFg && meta.blocked) {
      outcome.blocked = true;
      if (carrier && carrier.side === "D") { outcome.endY = endY; outcome.defenseTd = meta.returnTd; }
    }
    cached = { outcome, stats, endX: F.clamp(e.endX, fx(1), W - fx(1)), log, meta };
    return cached;
  }
  return { step, snapshot, result, assignments: () => [] };
}
