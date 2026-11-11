// The 30 Hz play engine: all 22 players move and decide every tick using Q16.16 fixed-point
// maths and the seeded Rng, so a play is fully reproducible from (state, calls, seed).
//
// Frame: x = 0 at the offense's left sideline .. field width; y = yards from the offense's own
// goal line (attacking toward +y). The line of scrimmage is y = ballOn.
import type { PlayerCard, DefenseCall, GameData, OffensePlay, Tuning } from "@tdf/shared";
import * as F from "../fixed.js";
import type { Fx, V2 } from "../fixed.js";
import { Rng } from "../rng.js";
import type { Foul, PlayOutcome } from "../rules.js";
import { slotPlayer, type Roster } from "../roster.js";
import { abilityKit, type AbilityKit, type PlayActives } from "./abilities.js";

const { fx, mul, div, idiv, ONE, vsub, vadd, vlen, vnorm, vscale, vdist } = F;

export type Stats = Record<string, number>;
export interface StatEvent {
  k: "pass" | "rush" | "rec" | "tackle" | "sack" | "int" | "fumble" | "fumbleLost" | "defended" | "kr" | "pr";
  id: number; team: 0 | 1;
  yds?: number; att?: number; comp?: number; td?: number; target?: number;
}

export type MotionKind = "jet" | "across" | "orbit" | "short" | "return";
/** Offensive pre-snap adjustments. motion: undefined = the play's own motion (if any), null = none. */
export interface PreSnapOffense {
  motion?: { role: string; kind: MotionKind } | null;
  /** shift: Y to the other side, Y flexed out to the slot, Z in tight */
  shift?: "yOther" | "yFlex" | "zTight" | null;
  /** hot routes: role -> route id */
  hot?: Record<string, string>;
  /** slide protection toward the offense's left or right */
  slide?: "L" | "R" | null;
  /** keep these eligibles in to block */
  keepIn?: string[];
}
/** Defensive pre-snap alignment (what the offense sees; assignments stay the call's, except spy/double). */
export interface PreSnapDefense {
  dl?: "over" | "under" | "pinch" | "spread" | null;
  lb?: "in" | "out" | null;
  /** show blitz: linebackers and the box safety walk up to the line (then play their call) */
  show?: boolean;
  /** safety look: one-high or two-high regardless of the call */
  safeties?: "one" | "two" | null;
  corners?: "press" | "bail" | null;
  /** turn this defender into a QB spy */
  spy?: string | null;
  /** bracket this offensive role with an extra underneath defender */
  double?: string | null;
}
/** Routes a hot route may use. */
export const HOT_ROUTES = ["go", "slant", "out", "in", "curl", "comeback", "post", "corner", "drag", "fade", "wheel", "flat", "block"] as const;

export interface PlayInput {
  data: GameData;
  ratings: (id: number) => Stats;
  offense: Roster; defense: Roster;
  offSide: 0 | 1;
  ballOn: Fx; ballX: Fx;
  toGo: Fx;
  play: OffensePlay; call: DefenseCall;
  /** offensive formation id (default: the play's first), personnel id (default: the formation's first) */
  formation?: string; personnel?: string;
  /** defensive front id (default base43) */
  front?: string;
  flip: boolean;
  /** how hard the defense bites on play action (1 = normal; the game raises it for run-heavy offenses) */
  paBiteMult?: number;
  rng: Rng;
  twoPoint?: boolean;
  record?: boolean;
  /** a human controls the offense: the QB waits for throwAt, the carrier follows move */
  userOffense?: boolean;
  /** a human controls one defender (defensive control mode) */
  userDefense?: boolean;
  preOff?: PreSnapOffense;
  preDef?: PreSnapDefense;
  /** armed active abilities (one per side), and the abilities ruleset (default on) */
  actives?: PlayActives;
  abilities?: boolean;
}
export interface Frame { t: number; p: number[]; ball: [number, number, number] } // positions as [x,y,...] in Fx

/** Per-tick input from a human controlling the offense (all optional). Coordinates are field Fx. */
export interface UserInput {
  /** desired run direction for the ball carrier (any length; zero/undefined = AI steering) */
  move?: V2 | null;
  /** throw now at this field point; power 0..1 (0 = soft lob, 1 = bullet) */
  throwAt?: { x: Fx; y: Fx; power: number } | null;
  /** offense: juke/spin/burst/scramble, keep (read option); defense: dive, strip, swat, switch */
  action?: "juke" | "spin" | "burst" | "scramble" | "keep" | "dive" | "strip" | "swat" | "switch" | "fairCatch" | "kneel" | null;
  /** kicks: aim (radians x 1000 from straight downfield, + = right), power 0..1000, curve -1000..1000 */
  kick?: { aim: number; power: number; curve: number } | null;
  /** snap the ball (when the play is waiting in its pre-snap phase, e.g. during motion) */
  snap?: boolean;
}
export interface ActorView { x: Fx; y: Fx; vx: Fx; vy: Fx; side: "O" | "D"; role: string; num: number | null; id: number; down: boolean }
export interface PlaySnapshot {
  tick: number; done: boolean; los: Fx;
  actors: ActorView[];
  ball: { x: Fx; y: Fx; h: Fx; state: "held" | "air" | "dead" | "loose"; holder: number };
  qbCanThrow: boolean; carrier: number; userCarrier: boolean;
  /** actor index the human controls on defense (-1 = none) */
  userDefender: number;
  /** read option: the QB still has the choice to keep */
  canKeep: boolean;
  /** still before the snap (motion running) */
  presnap: boolean;
  /** at the snap / before it: offensive routes and defensive assignments, for the pre-snap overlay */
  routes: { i: number; pts: V2[] }[];
  assign: { i: number; task: string; at?: V2; r?: Fx; target?: number }[];
  /** special-teams plays only */
  kick?: KickView;
  cooldowns: { juke: number; spin: number; burst: number };
  log: string[];
  /** ability pop-ups so far: actor index, text, tick */
  fx?: { i: number; text: string; tick: number }[];
}
export type KickKind = "fieldGoal" | "pat" | "kickoff" | "squib" | "onside" | "punt";
export interface KickView {
  kind: KickKind;
  phase: "setup" | "approach" | "flight" | "loose" | "return" | "dead";
  /** waiting for the human kicker's flick */
  awaitingKick: boolean;
  /** half-width of the accuracy cone (radians, Fx) and the kick spot / goal-post target (field Fx) */
  cone: Fx; spot: V2; target: V2;
  /** wind in this play's frame (yd/s per axis, Fx) and mph */
  wind: V2; windMph: number;
  canFairCatch: boolean; canKneel: boolean;
  /** onside / loose-ball scramble: the player the human controls (-1 none) */
  userPlayer: number;
  /** field goal / PAT: result shown once decided */
  good: boolean | null;
}
export interface PlaySim {
  /** one tick. `input` = the human's input (offense / kicking team when both sides are human);
   *  `defInput` = the defending / receiving human's input when both sides are human (online) */
  step(input?: UserInput | null, defInput?: UserInput | null): boolean;
  snapshot(): PlaySnapshot;
  result(): PlayResult;
  /** each defender's assignment at the snap: rush, man:<role>, spy, or the zone name */
  assignments(): { role: string; task: string }[];
}
export interface PlayResult { outcome: PlayOutcome; stats: StatEvent[]; endX: Fx; frames?: Frame[]; log: string[]; debug?: { tries: number; missed: number; minDist: number };
  /** which sides' armed actives were actually on the field (momentum is only spent for those) */
  activesUsed?: { O: boolean; D: boolean } }

type Task = "block" | "route" | "qb" | "carry" | "rush" | "man" | "zone" | "spy" | "pull" | "lead" | "idle";
interface Actor {
  i: number; c: PlayerCard; st: Stats; side: "O" | "D"; role: string;
  /** defensive class (DL, EDGE, LB, NB, CB, S); "" on offense */
  cls: string;
  /** abilities: passives, the armed active, signature boosts */
  ab: AbilityKit;
  /** engagements so far (relentless) */
  engagements: number;
  pos: V2; vel: V2; maxSpeed: Fx; accel: Fx;
  task: Task;
  // blocking
  blockTarget: number; engagedWith: number; shedTick: number; stunTil: number;
  // routes
  route: V2[]; routeIdx: number; settle: boolean; isBlocker: boolean;
  /** blocks (pass pro) until this tick, then runs the route */
  releaseAt: number;
  /** stalk blocker: blocks defensive backs, not rushers */
  stalk: boolean;
  /** zone combo: help on this defender until comboUntil, then climb to blockTarget */
  comboOn: number; comboUntil: number;
  /** play action: this defender bites on the fake until this tick */
  biteUntil: number;
  /** pressed at the line: can't get into the route until this tick */
  jamUntil: number;
  // coverage
  manTarget: number; zone: { at: V2; r: Fx; deep: boolean } | null; zoneName: string; reactTicks: number;
  lastTackleTry: number;
  history: V2[];
  brake: boolean;
}

interface Ball {
  state: "held" | "air" | "dead" | "loose";
  holder: number;
  from: V2; to: V2; t0: number; t1: number; target: number; thrower: number;
}

const DEG = (d: number) => fx((d * Math.PI) / 180);

/** Run a whole play with AI on both sides. */
export function simulatePlay(inp: PlayInput): PlayResult {
  const p = createPlay(inp);
  while (!p.step()) { /* advance */ }
  return p.result();
}

/** Set up a play that advances one 30 Hz tick per step(), optionally driven by human input. */
export function createPlay(inp: PlayInput): PlaySim {
  const { data, rng } = inp;
  const T: Tuning = data.tuning;
  const hz = data.rules.tickHz;
  const DT = idiv(ONE, hz);
  const sec = (s: number) => Math.max(1, Math.round(s * hz));
  const W = fx(T.field.width);
  const log: string[] = [];
  const stats: StatEvent[] = [];
  const fxLog: { i: number; text: string; tick: number }[] = [];
  const curTickRef = { t: 0 };
  /** an ability fired: pop-up over the player, and a log line */
  const pop = (a: { i: number; c: PlayerCard }, text: string) => { fxLog.push({ i: a.i, text, tick: curTickRef.t }); log.push(`* ${a.c.name}: ${text}`); };
  const defSide = (inp.offSide === 0 ? 1 : 0) as 0 | 1;

  const off = data.formations.offense.find((f) => f.id === (inp.formation ?? inp.play.formations[0]))
    ?? data.formations.offense.find((f) => inp.play.formations.includes(f.id))!;
  const persId = inp.personnel && off.personnel.includes(inp.personnel) ? inp.personnel : off.personnel[0]!;
  const pers = data.formations.personnel[persId]!;
  const dfm = data.formations.defense.find((f) => f.id === (inp.front ?? "base43")) ?? data.formations.defense[0]!;
  const flipX = inp.flip ? -1 : 1;
  const los = inp.ballOn;
  const bx = inp.ballX;
  const kind = inp.play.kind;
  const isPass = kind === "pass";
  const isRpo = kind === "rpo";
  const scheme = inp.play.block ?? "zone";
  const isDraw = kind === "run" && scheme === "draw";
  const isOption = kind === "run" && Boolean(inp.play.option);
  const gapRun = kind === "run" && (scheme === "power" || scheme === "counter");
  /** the line pass-protects at the snap (passes, draws) */
  const passSet = isPass || isDraw;
  const S = T.schemes;

  // ------------------------------------------------------------------ actors
  const actors: Actor[] = [];
  const AB = T.abilities;
  const abOn = inp.abilities !== false;
  const activesUsed = { O: false, D: false };
  const mk = (c: PlayerCard, side: "O" | "D", role: string, at: V2, cls = ""): Actor => {
    const armedFor = inp.actives?.[side];
    const armed = armedFor && armedFor.player === c.id ? armedFor.ability : null;
    if (armed && abOn) activesUsed[side] = true;
    const ab = abilityKit(c, data, armed, abOn);
    const base = inp.ratings(c.id);
    const st = Object.keys(ab.boosts).length ? { ...base, ...Object.fromEntries(Object.entries(ab.boosts).map(([k, v]) => [k, Math.min(99, (base[k] ?? 50) + v)])) } : base;
    const g = (k: string) => st[k] ?? 50;
    return {
      i: actors.length, c, st, side, role, cls, ab, engagements: 0, pos: at, vel: { x: 0, y: 0 },
      maxSpeed: fx(T.movement.speedBase + T.movement.speedPer * g("speed")),
      accel: fx(T.movement.accelBase + T.movement.accelPer * g("acceleration")),
      task: "idle", blockTarget: -1, engagedWith: -1, shedTick: 0, stunTil: 0,
      route: [], routeIdx: 0, settle: false, isBlocker: false, releaseAt: 0, stalk: false, comboOn: -1, comboUntil: 0, biteUntil: 0, jamUntil: 0,
      manTarget: -1, zone: null, zoneName: "", reactTicks: 0, lastTackleTry: -999, history: [], brake: false,
    };
  };
  const place = (dx: number, dy: number, mirror: number): V2 => ({
    x: F.clamp(bx + fx(dx * mirror), fx(1), W - fx(1)), y: los + fx(dy),
  });
  const roleIdx = new Map<string, number>();
  const takenO = new Set<number>();
  for (const role of ["QB", "LT", "LG", "C", "RG", "RT", "X", "Y", "Z", "H", "RB"]) {
    const slot = pers[role] ?? role;
    const card = slotPlayer(inp.offense, slot, data, takenO);
    takenO.add(card.id);
    let [dx, dy] = off.spots[role]!;
    const sh = inp.preOff?.shift;
    if (sh === "yOther" && role === "Y") dx = -dx;
    if (sh === "yFlex" && role === "Y") { dx = (dx >= 0 ? 1 : -1) * 9; dy = -1.5; }
    if (sh === "zTight" && role === "Z") dx = (dx >= 0 ? 1 : -1) * 9;
    const a = mk(card, "O", role, place(dx, dy, flipX));
    roleIdx.set("O:" + role, a.i);
    actors.push(a);
  }
  const O = actors.filter((a) => a.side === "O");
  const ELIG = O.filter((a) => ["X", "Y", "Z", "H", "RB"].includes(a.role));
  // strength: the side with more eligibles (ties go to the Y)
  let leftN = 0, rightN = 0;
  for (const e of ELIG) { if (e.pos.x < bx - fx(0.5)) leftN++; else if (e.pos.x > bx + fx(0.5)) rightN++; }
  const yAct = actors[roleIdx.get("O:Y")!]!;
  const m = rightN > leftN ? 1 : leftN > rightN ? -1 : yAct.pos.x >= bx ? 1 : -1;
  /** x relative to the ball in the strength-right frame */
  const fr = (a: { pos: V2 } | V2) => (("pos" in a ? a.pos.x : a.x) - bx) * m;
  const wideOn = (side: number, nth: number) => {
    const list = ELIG.filter((e) => fr(e) * side > fx(3)).sort((p, q) => F.abs(fr(q)) - F.abs(fr(p)));
    return list[nth] ?? null;
  };
  const takenD = new Set<number>();
  for (const [role, r] of Object.entries(dfm.roles)) {
    const card = slotPlayer(inp.defense, r.slot, data, takenD);
    takenD.add(card.id);
    let at = place(r.at[0], r.at[1], m);
    if (r.alignOn) {
      const side = r.at[0] * m >= 0 ? 1 : -1;
      const over = wideOn(side * m, r.alignOn === "wide" ? 0 : 1);
      if (over && (r.alignOn === "wide" || F.abs(over.pos.x - bx) > fx(5))) at = { x: over.pos.x + (r.alignOn === "slot" ? fx(-0.8 * side * m) : 0), y: at.y };
    }
    const a = mk(card, "D", role, at, r.cls);
    roleIdx.set("D:" + role, a.i);
    actors.push(a);
  }
  const D = actors.filter((a) => a.side === "D");
  const P5 = T.presnap;
  alignDefense();
  /** pre-snap looks: line and linebacker shifts, corner depth, blitz look, safety rotation */
  function alignDefense() {
    const pd = inp.preDef;
    if (!pd) return;
    const out = (d: Actor) => (d.pos.x >= bx ? 1 : -1);
    const setX = (d: Actor, x: Fx) => { d.pos = { x: F.clamp(x, fx(1), W - fx(1)), y: d.pos.y }; };
    for (const d of D) {
      if (d.cls === "DL" || d.cls === "EDGE") {
        const k = fx(P5.dlShift);
        if (pd.dl === "over") setX(d, d.pos.x + k * m);
        if (pd.dl === "under") setX(d, d.pos.x - k * m);
        if (pd.dl === "pinch") setX(d, d.pos.x - k * out(d));
        if (pd.dl === "spread") setX(d, d.pos.x + mul(k, fx(1.5)) * out(d));
      }
      if (d.cls === "LB") {
        if (pd.lb === "in") setX(d, d.pos.x - fx(P5.lbShift) * out(d));
        if (pd.lb === "out") setX(d, d.pos.x + fx(P5.lbShift) * out(d));
      }
      if (d.cls === "CB" && pd.corners) d.pos = { x: d.pos.x, y: los + fx(pd.corners === "press" ? P5.pressDepth : P5.bailDepth) };
    }
    const safeties = D.filter((d) => d.cls === "S").sort((p, q) => q.pos.y - p.pos.y);
    if (pd.safeties === "two" && safeties.length >= 2) {
      const [a1, a2] = [...safeties.slice(0, 2)].sort((p, q) => p.pos.x - q.pos.x);
      a1!.pos = { x: bx - fx(9), y: los + fx(13) }; a2!.pos = { x: bx + fx(9), y: los + fx(13) };
    }
    if (pd.safeties === "one" && safeties.length >= 1) {
      safeties[0]!.pos = { x: bx, y: los + fx(14) };
      if (safeties[1]) safeties[1].pos = { x: bx + fx(5.5 * m), y: los + fx(8) };
    }
    if (pd.show) for (const d of D) {
      const box = d.cls === "LB" || (d.cls === "S" && d !== safeties[0] && pd.safeties !== "two");
      if (box) d.pos = { x: d.pos.x, y: los + fx(P5.showDepth) };
    }
  }
  const byRole = (side: "O" | "D", role: string) => actors[roleIdx.get(side + ":" + role)!]!;
  const R = (a: Actor, k: string) => a.st[k] ?? 50;
  const qb = byRole("O", "QB");
  const carrierRole = inp.play.carrier ?? "RB";
  const runner = kind === "pass" ? null : byRole("O", carrierRole);
  // a lead blocker only from the backfield (an H split out in this formation just blocks normally)
  const leadCand = inp.play.lead && inp.play.lead !== carrierRole ? byRole("O", inp.play.lead) : null;
  const leadBlocker = leadCand && leadCand.pos.y < los - fx(2.5) ? leadCand : null;

  // ------------------------------------------------------------------ pre-snap motion
  const motionPlan = inp.preOff && "motion" in inp.preOff ? inp.preOff.motion ?? null : inp.play.motion ?? null;
  const mover = motionPlan && ["X", "Y", "Z", "H", "RB"].includes(motionPlan.role) ? byRole("O", motionPlan.role) : null;
  const motionKind = motionPlan?.kind ?? "short";
  const motionPath: V2[] = [];
  if (mover) {
    const sgn = mover.pos.x >= bx ? 1 : -1, toward = -sgn, Y0 = mover.pos.y;
    const P = (x: Fx, y: Fx): V2 => ({ x: F.clamp(x, fx(1.5), W - fx(1.5)), y });
    if (motionKind === "jet") motionPath.push(P(bx + fx(3 * sgn), los - fx(2.2)), P(bx - fx(16 * sgn), los - fx(2.2)));
    if (motionKind === "across") motionPath.push(P(bx - (mover.pos.x - bx), Y0));
    if (motionKind === "orbit") motionPath.push(P(bx + fx(3 * sgn), los - fx(3)), P(bx - fx(sgn), los - fx(5.5)), P(bx + fx(6 * sgn), los - fx(3.5)));
    if (motionKind === "short") motionPath.push(P(mover.pos.x + fx(3 * toward), Y0));
    if (motionKind === "return") motionPath.push(P(mover.pos.x + fx(4 * toward), Y0), P(mover.pos.x, Y0));
  }
  let snapped = !mover;
  let preTick = 0, motionIdx = 0;
  const jetRunner = Boolean(mover && runner === mover);
  let jetBoostUntil = -1;

  // ------------------------------------------------------------------ assignments
  const OL_ROLES = ["LT", "LG", "C", "RG", "RT"];
  const aimSide = (inp.play.aim?.[0] ?? 1) * flipX >= 0 ? 1 : -1;
  const pullers: Actor[] = [];
  if (!passSet && (scheme === "power" || scheme === "counter")) {
    pullers.push(byRole("O", aimSide > 0 ? "LG" : "RG"));
    if (scheme === "counter") pullers.push(byRole("O", aimSide > 0 ? "LT" : "RT"));
  }
  const setRoute = (a: Actor, routeId: string) => {
    const [rid, force] = routeId.split(":") as [string, string | undefined];
    const rdef = data.routes.routes[rid]!;
    if (rdef.block) { a.task = "block"; a.isBlocker = true; a.stalk = rdef.block === "stalk"; return; }
    const sx = force ? (force === "L" ? -1 : 1) * flipX : a.pos.x >= bx ? 1 : -1;
    a.route = rdef.points.map(([o, d]) => ({ x: F.clamp(a.pos.x + fx(o * sx), fx(0.5), W - fx(0.5)), y: a.pos.y + fx(d) }));
    a.settle = Boolean(rdef.settle);
    a.task = "route";
    if (rdef.delay) { a.releaseAt = sec(rdef.delay); a.isBlocker = true; }
  };
  const routeIds = new Map<number, string>();
  for (const a of O) {
    if (OL_ROLES.includes(a.role)) { a.task = pullers.includes(a) ? "pull" : "block"; a.isBlocker = true; continue; }
    if (a.role === "QB" && a !== runner) { a.task = "qb"; continue; }
    if (a === runner) { a.task = "carry"; continue; }
    if (a === leadBlocker) { a.task = "lead"; a.isBlocker = true; continue; }
    let routeId = inp.play.routes?.[a.role];
    if ((isPass || isRpo) && routeId) {
      const hot = inp.preOff?.hot?.[a.role];
      if (hot && (HOT_ROUTES as readonly string[]).includes(hot)) routeId = hot;
      if (inp.preOff?.keepIn?.includes(a.role)) routeId = "block";
      routeIds.set(a.i, routeId);
      setRoute(a, routeId); continue;
    }
    a.task = "block"; a.isBlocker = true;
    // wide receivers on runs block the nearest defensive back
    if (!passSet && ["X", "Z"].includes(a.role) || (!passSet && F.abs(a.pos.x - bx) > fx(8))) a.stalk = true;
  }
  if (qb === runner) qb.task = isDraw ? "qb" : "carry";
  // pullers: step back, run along the line to the hole, turn up into it
  const holeX = bx + fx((inp.play.aim?.[0] ?? 0) * flipX);
  for (const [k, pl] of pullers.entries()) {
    pl.route = [{ x: holeX - fx(aimSide * (1.2 - k * 1.2)), y: los - fx(S.pullStep) }, { x: holeX + fx(aimSide * k), y: los + fx(1.5) }];
  }
  if (leadBlocker) leadBlocker.route = [{ x: holeX, y: los - fx(0.5) }, { x: holeX, y: los + fx(2) }];

  // ------------------------------------------------------------------ defensive call -> assignments
  let assignmentsAtSnap: { role: string; task: string }[] = [];
  compileCall();
  presnapOverrides();
  // jam: a defender reroutes the receiver he's on at the line
  for (const d of D) {
    const jm = d.ab.mag("jam");
    if (!jm) continue;
    const r = d.task === "man" ? actors[d.manTarget]! : nearestTo(O.filter((o) => o.task === "route"), d.pos);
    if (r && vdist(r.pos, d.pos) < fx(AB.jamRangeYds) && d.ab.once("jam")) { r.jamUntil = Math.max(r.jamUntil, sec(jm)); pop(d, "JAM!"); }
  }
  // hard count: the line freezes at the snap
  const hc = qb.ab.once("hard_count");
  // (frozen linemen still get blocked: hcFreezeTil marks them for the blocking assignments)
  // he draws the line offside (a free play: the offense takes the better of the play and 5 yards), or it freezes
  const hcOffside = hc > 0 && new Rng((rng.getState()[1] ^ 0x85ebca6b) >>> 0).int(100) < hc;
  const hcFreezeTil = hc && !hcOffside ? sec(AB.hardCountFreeze) : -1;
  if (hc) { pop(qb, hcOffside ? "OFFSIDE! FREE PLAY" : "HARD COUNT!"); if (!hcOffside) for (const d of D) if (d.cls === "DL" || d.cls === "EDGE") d.stunTil = hcFreezeTil; }
  function presnapOverrides() {
    const pd = inp.preDef;
    if (!pd) return;
    if (pd.spy) {
      const d = D.find((x) => x.role === pd.spy);
      if (d) { d.task = "spy"; d.zone = null; d.manTarget = -1; }
    }
    if (pd.double) {
      const r = O.find((x) => x.role === pd.double);
      let best: Actor | null = null, bd = fx(1e4);
      if (r) for (const d of D) if (d.task === "zone" && d.zone && !d.zone.deep) { const dd = vdist(d.pos, r.pos); if (dd < bd) { bd = dd; best = d; } }
      if (r && best) { best.task = "man"; best.manTarget = r.i; best.zone = null; best.reactTicks = sec(T.coverage.manReactBase + T.coverage.manReactPerMissing * (99 - R(best, "manCoverage"))); }
    }
    if (pd.corners === "press") {
      for (const d of D) {
        if (d.cls !== "CB") continue;
        const r = d.task === "man" ? actors[d.manTarget]! : O.filter((o) => o.task === "route").sort((p, q) => vdist(p.pos, d.pos) - vdist(q.pos, d.pos))[0];
        if (!r || r.task !== "route" || F.abs(r.pos.x - d.pos.x) > fx(2.5)) continue;
        const jam = Math.min(P5.jamMax, Math.max(0, P5.jamBase + P5.jamPer * (R(d, "press") - R(r, "release"))));
        r.jamUntil = Math.max(r.releaseAt, sec(jam));
        // a receiver who wins off the line leaves a pressed corner turning late
        if (R(r, "release") > R(d, "press") + 5) d.reactTicks += sec(P5.pressBeatPenalty);
      }
    }
    assignmentsAtSnap = D.map((d) => ({ role: d.role, task: d.task === "man" ? `man:${actors[d.manTarget]!.role}` : d.task === "zone" ? d.zoneName : d.task }));
  }
  function compileCall() {
    const call = inp.call;
    const free = new Set(D);
    const sel = (opts: readonly string[], pool: Iterable<Actor>): Actor | null => {
      const list = [...pool];
      for (const o of opts) {
        const named = list.find((d) => d.role === o);
        if (named) return named;
        const [cls, pick] = o.split(":") as [string, string | undefined];
        const c = list.filter((d) => d.cls === cls);
        if (!c.length) continue;
        const by = (f: (d: Actor) => number) => c.reduce((b, d) => (f(d) < f(b) ? d : b));
        switch (pick) {
          case "L": case "W": return by((d) => fr(d));
          case "R": case "S": return by((d) => -fr(d));
          case "M": return by((d) => F.abs(fr(d)));
          case "deep": return by((d) => -d.pos.y);
          case "low": return by((d) => d.pos.y);
          default: return c[0]!;
        }
      }
      return null;
    };
    const rushSet = new Set(dfm.rush.map((r) => byRole("D", r)));
    for (const b of call.blitz) { const d = sel(b, [...free].filter((x) => !rushSet.has(x))); if (d) rushSet.add(d); }
    for (const dr of call.drop) { const d = sel(dr, rushSet); if (d && rushSet.size > 3) rushSet.delete(d); }
    for (const d of rushSet) { d.task = "rush"; free.delete(d); }
    const zoneAt = (id: string) => {
      const z = data.defense.zones[id]!;
      return { at: { x: F.clamp(bx + fx(z.at[0] * m), fx(2), W - fx(2)), y: los + fx(z.at[1]) }, r: fx(z.r), deep: Boolean(z.deep) };
    };
    for (const dz of call.deep) {
      const d = sel(dz.who, free);
      if (!d) continue;
      d.task = "zone"; d.zone = zoneAt(dz.zone); d.zoneName = dz.zone; free.delete(d);
    }
    if (call.spy) { const d = sel(call.spy, free); if (d) { d.task = "spy"; free.delete(d); } }
    if (call.man) {
      // greedy matching: corners take the wide receivers, then the closest fits for the rest
      const recv = [...ELIG];
      const cost = (d: Actor, r: Actor) => {
        const wide = F.abs(r.pos.x - bx) > fx(12);
        const back = r.pos.y < los - fx(3);
        const pref = d.cls === "CB" ? (back ? 12 : 0) : d.cls === "NB" ? (wide ? 4 : 0) : d.cls === "LB" ? (wide ? 14 : back ? 0 : 3) : d.cls === "S" ? (wide ? 6 : 1) : 20;
        return F.abs(d.pos.x - r.pos.x) / ONE + 0.4 * F.abs(d.pos.y - r.pos.y) / ONE + pref;
      };
      const pairs: { d: Actor; r: Actor; c: number }[] = [];
      for (const d of free) for (const r of recv) pairs.push({ d, r, c: cost(d, r) });
      pairs.sort((p, q) => p.c - q.c || p.d.i - q.d.i || p.r.i - q.r.i);
      const usedR = new Set<number>();
      for (const pr of pairs) {
        if (!free.has(pr.d) || usedR.has(pr.r.i)) continue;
        pr.d.task = "man"; pr.d.manTarget = pr.r.i; usedR.add(pr.r.i); free.delete(pr.d);
      }
    }
    const left = [...free].sort((p, q) => fr(p) - fr(q) || p.i - q.i);
    const zones = call.under.slice(0, left.length);
    while (zones.length < left.length) zones.push("robber");
    zones.sort((p, q) => data.defense.zones[p]!.at[0] - data.defense.zones[q]!.at[0]);
    left.forEach((d, k) => { d.task = "zone"; d.zone = zoneAt(zones[k]!); d.zoneName = zones[k]!; });
    assignmentsAtSnap = D.map((d) => ({ role: d.role, task: d.task === "man" ? `man:${actors[d.manTarget]!.role}` : d.task === "zone" ? d.zoneName : d.task }));
    const qbSig = O.find((o) => o.role === "QB" && o.ab.signature === "QB");
    const fgYds = O.find((o) => o.role === "QB")?.ab.mag("field_general") ?? 0;
    const firstRead = inp.play.kind !== "run" && inp.play.read?.[0] ? O.find((o) => o.role === inp.play.read![0] && o.task === "route") ?? null : null;
    const fgZoneMan = firstRead ? nearestTo(D.filter((d) => d.task === "zone"), firstRead.pos) : null;
    if (qbSig) pop(qbSig, qbSig.c.signature?.name ?? "SIGNATURE");
    for (const d of D) {
      d.reactTicks = sec(T.coverage.reactBase + T.coverage.reactPerMissing * (99 - R(d, "playRecognition")));
      // mirroring a receiver is a man-coverage skill, not general play recognition
      if (d.task === "man") d.reactTicks = sec(T.coverage.manReactBase + T.coverage.manReactPerMissing * (99 - R(d, "manCoverage")));
      if (abOn) {
        d.reactTicks = Math.max(0, d.reactTicks - sec(d.ab.mag("radar")));
        const sh = d.ab.mag("shadow"); if (sh && d.task === "man") d.reactTicks = Math.min(d.reactTicks, sec(sh * AB.coverageLagPerYd * AB.shadowLagMult));
        const r = d.task === "man" ? actors[d.manTarget] : null;
        if (r && r.side === "O") {
          d.reactTicks += sec(r.ab.mag("route_tech") * AB.coverageLagPerYd);
          const sl = r.ab.once("shake_loose"); if (sl) { r.jamUntil = 0; d.reactTicks += sec(sl * AB.coverageLagPerYd); pop(r, "SHAKE LOOSE!"); }
          const rid = (inp.play.routes?.[r.role] ?? "").split(":")[0] ?? "";
          const gr = ["go", "seam", "fade"].includes(rid) ? r.ab.once("go_route") : 0;
          if (gr) { d.reactTicks += sec(gr * AB.routeLagPerStep); pop(r, "GO ROUTE!"); }
        }
        if (d.zone?.deep) {
          const dt = Math.max(0, ...O.filter((o) => o.task === "route").map((o) => o.ab.mag("deep_threat")));
          if (dt) d.zone = { ...d.zone, at: { x: d.zone.at.x, y: d.zone.at.y + fx(dt) } };
        }
        // QB signature: every receiver gets a few yards on his man / zone defender
        if (qbSig && d.task !== "rush") d.reactTicks += sec(AB.qbSignatureSepYds * AB.coverageLagPerYd);
        // field general: his first read gets open (the man on him, or the zone defender nearest him, reacts late)
        if (fgYds && AB.fieldGeneralLagMult && firstRead && d.task !== "rush" && (d.manTarget === firstRead.i || (d.task === "zone" && d === fgZoneMan))) d.reactTicks += sec(fgYds * AB.coverageLagPerYd * AB.fieldGeneralLagMult);
        if (d.ab.signature === "LB") d.reactTicks = 0;
      }
      // play action: second-level defenders step up on the fake; low play recognition bites longer
      if (inp.play.pa && d.task !== "rush" && d.ab.signature !== "LB") {
        const k = (T.pa.biteBase + T.pa.bitePerMissing * (99 - R(d, "playRecognition"))) * (inp.paBiteMult ?? 1) * (d.cls === "CB" ? T.pa.cornerMult : d.cls === "S" ? T.pa.safetyMult : 1);
        d.biteUntil = sec(T.pa.fakeSeconds + k);
      }
    }
  }
  const rushers = () => D.filter((d) => d.task === "rush");

  /** Claim one defender per blocker (no two blockers on the same man until everyone is covered). */
  const claimed = new Map<number, number>(); // defender -> blocker
  let optionKey: Actor | null = null;
  function claimTarget(b: Actor): Actor | null {
    const pp = passSet && !screenOn;
    const box = (d: Actor) => F.abs(d.pos.x - b.pos.x) < fx(pp ? 9 : 7) && d.pos.y - los < fx(pp ? 6 : 8);
    const cands = D.filter((d) => (pp && !b.stalk ? d.task === "rush" : true) && d !== optionKey && box(d) && (d.stunTil <= 0 || d.stunTil === hcFreezeTil));
    const free = cands.filter((d) => !claimed.has(d.i));
    const pool = free.length ? free : cands;
    let best: Actor | null = null, bd = fx(1e4);
    for (const d of pool) {
      // linemen first, then second-level players (LBs) a bit further away
      const level = d.pos.y - los > fx(3) ? fx(2.5) : 0;
      const dd = vdist(b.pos, d.pos) + level;
      if (dd < bd) { bd = dd; best = d; }
    }
    if (best) { b.blockTarget = best.i; if (!claimed.has(best.i)) claimed.set(best.i, b.i); }
    if (inp.record) log.push(`block: ${b.role} -> ${best ? best.role : "none"}`);
    return best;
  }

  // ------------------------------------------------------------------ ball
  // the QB holds it on passes, RPOs, draws and options until he throws or hands off
  const qbHolds = isPass || isRpo || isDraw || isOption || runner === qb || jetRunner;
  const ball: Ball = { state: "held", holder: (qbHolds ? qb : runner!).i, from: qb.pos, to: qb.pos, t0: 0, t1: 0, target: -1, thrower: -1 };
  let qbHasBall = isPass || isRpo;     // QB can still throw (and be sacked)
  let runRecognizedAt = passSet ? 1 << 30 : 0;
  /** tick the QB hands off (draw, option mesh, RPO decision); -1 = no handoff pending */
  let handoffAt = isDraw ? sec(S.drawHandoff) : isOption ? sec(S.optionMesh) : isRpo ? sec(S.rpoMesh) : jetRunner ? sec(P5.jetHandoff) : -1;
  /** the run starts (for run-read timing) */
  let runStart = isDraw ? 1 << 30 : 0;
  let keepPressed = false;
  let kept = false;
  // option: the backside end is left unblocked and read; he either crashes on the back or plays the QB
  if (isOption) {
    const back = D.filter((d) => (d.cls === "EDGE" || d.cls === "DL") && (d.pos.x - bx) * aimSide < 0 && d.pos.y - los < fx(3));
    optionKey = back.sort((p, q) => F.abs(q.pos.x - bx) - F.abs(p.pos.x - bx))[0] ?? null;
  }
  const keyCrashes = optionKey ? rng.int(1000) < S.keyCrashPerMille : false;
  const optionKeyX = optionKey ? optionKey.pos.x : bx;
  let screenOn = false;
  const screenTarget = inp.play.screen ? byRole("O", inp.play.read?.[0] ?? "RB") : null;
  // RPO: the conflict defender is the nearest second-level player to the first read
  const rpoRead = isRpo ? byRole("O", inp.play.read?.[0] ?? "X") : null;
  let rpoConflict: Actor | null = null;
  if (rpoRead) {
    let bd = fx(S.rpoConflictRange);
    for (const d of D) if (d.task !== "rush" && d.cls !== "CB") { const dd = vdist(d.pos, rpoRead.pos); if (dd < bd) { bd = dd; rpoConflict = d; } }
  }
  let scramble = false;
  type End = { reason: string; y: Fx; x: Fx; oob?: boolean; incomplete?: boolean; td?: "O" | "D"; sack?: boolean };
  type Turnover = "interception" | "fumble" | null;
  let ended = null as End | null;
  let turnover = null as Turnover;
  let fumbleBackToOffense = false;
  let throwInfo = null as { qb: Actor; target: Actor; airYds: Fx } | null;
  let completion = null as { rec: Actor; at: Fx } | null;
  let closeIncomplete = false;
  let pressureAtThrow = false;
  let pressureSince = -1;
  let misreadRolled = false;
  const gun = los - qb.pos.y > fx(3);
  const dropYds = isDraw ? S.drawDrop : isOption ? 0 : (inp.play.drop ?? 0);
  const dropDepth = fx(Math.max(0, dropYds - (gun ? 4 : 0)));
  const boot = Boolean(inp.play.boot);
  const dropPoint = boot ? { x: F.clamp(qb.pos.x - fx(T.pa.bootWidth * flipX), fx(3), W - fx(3)), y: los - fx(T.pa.bootDepth) } : { x: qb.pos.x, y: qb.pos.y - dropDepth };
  const dropDist = vdist(qb.pos, dropPoint) / ONE;
  const fakeSecs = inp.play.pa ? T.pa.fakeSeconds : 0;
  // timing follows the called drop (a shotgun 5-step is still a 5-step rhythm)
  const readStart = sec(((isPass ? (inp.play.drop ?? 3) : 1) + (boot ? T.pa.bootWidth / 2 : 0)) / T.qb.dropSpeed + T.qb.readStartAfterDrop + fakeSecs);
  void dropDist;
  const fakePoint = { x: qb.pos.x + fx(2 * flipX), y: los - fx(1.5) };
  const runner0 = byRole("O", "RB");
  let handedOff = false;
  const frames: Frame[] = [];
  const dbg = { tries: 0, missed: 0, minDist: 1e9 };

  const carrier = (): Actor | null => (ball.state === "held" ? actors[ball.holder]! : null);
  const opponents = (a: Actor) => (a.side === "O" ? D : O);

  // ------------------------------------------------------------------ movement
  function steer(a: Actor, goal: V2, speedMult: Fx = ONE) {
    const to = vsub(goal, a.pos);
    const dist = vlen(to);
    if (a.brake) {
      // break down for a cut or a settle point: never arrive faster than you can stop
      const sp = vlen(a.vel);
      const stopDist = div(mul(sp, sp), F.max(mul(a.accel, fx(2)), ONE));
      if (stopDist > dist) speedMult = mul(speedMult, F.max(fx(0.2), div(dist, F.max(stopDist, ONE))));
    }
    let maxV = mul(a.maxSpeed, speedMult);
    if (abOn) {
      const holder = ball.state === "held" && ball.holder === a.i;
      if (holder && a.side === "O" && a.pos.y > los) {
        const af = a.ab.mag("afterburner");
        if (af) { if (afterburnerAt < 0) { afterburnerAt = curTick; pop(a, "AFTERBURNER!"); } if (curTick - afterburnerAt < sec(AB.afterburnerSeconds)) maxV += fx(af * T.movement.speedPer); }
      }
      if (holder && a === pickSixer) maxV = mul(maxV, fx(1 + a.ab.mag("pick_six") / 100));
      const c0 = ball.state === "held" ? actors[ball.holder]! : null;
      if (c0 && c0.side !== a.side && !(c0 === qb && qbHasBall)) maxV += fx(a.ab.mag("closing_speed") * T.movement.speedPer * AB.closingSpeedMult);
      if (a.task === "pull" && a.ab.mag("pull_lead")) maxV = mul(maxV, fx(1 + a.ab.mag("pull_lead") / 100));
    }
    if (a === runner && curTick < jetBoostUntil && ball.holder === a.i) maxV = mul(maxV, fx(P5.jetBoost));
    // gap runs: the back is patient while the pullers get there
    if (gapRun && a === runner && curTick - runStart < sec(S.gapPatience)) maxV = mul(maxV, fx(S.gapPatienceMult));
    if (a.engagedWith >= 0) maxV = mul(maxV, fx(T.movement.engagedSpeedMult));
    if (ball.state === "held" && ball.holder === a.i) {
      maxV = mul(maxV, fx(completion && completion.rec === a ? T.movement.receiverCarrySpeedMult : T.movement.carryingSpeedMult));
      if (moveUntil.burst > curTick) maxV = mul(maxV, fx(T.user.burstSpeedMult));
      // cutting hard costs speed (less for agile backs)
      const sp = vlen(a.vel);
      if (sp > fx(3) && dist > fx(0.5)) {
        const cosA = div(F.vdot(a.vel, to), mul(sp, dist));
        if (cosA < fx(0.5)) maxV = mul(maxV, fx(Math.min(1, T.carrier.sharpTurnSpeedMult + T.carrier.sharpTurnAgilityPer * R(a, "agility"))));
      }
    }
    // arrive: slow down inside 1 yard of the goal
    const want = dist < fx(0.3) ? { x: 0, y: 0 } : vscale(vnorm(to), dist < ONE ? mul(maxV, dist) : maxV);
    const dv = vsub(want, a.vel);
    const dvl = vlen(dv);
    const carrying = ball.state === "held" && ball.holder === a.i && completion !== null && completion.rec === a; // re-accelerating after a catch
    const maxDv = mul(carrying ? mul(a.accel, fx(T.movement.carryingAccelMult)) : a.accel, DT);
    a.vel = dvl <= maxDv ? want : vadd(a.vel, vscale(vnorm(dv), maxDv));
  }
  function integrate(a: Actor) {
    a.pos = vadd(a.pos, vscale(a.vel, DT));
    a.history.push(a.pos);
    if (a.history.length > hz) a.history.shift();
  }
  const delayedPos = (a: Actor, ticks: number) => a.history[Math.max(0, a.history.length - 1 - ticks)] ?? a.pos;
  /** What a defender with reaction lag `ticks` believes: the receiver's last seen spot, projected along
   *  his then-current path. Straight-line running is anticipated; cuts are noticed late. */
  function anticipate(r: Actor, ticks: number, extra = 0.15): V2 {
    const seen = delayedPos(r, ticks);
    const before = delayedPos(r, ticks + 6);
    const vel = vscale(vsub(seen, before), fx(hz / 6));
    return vadd(seen, vscale(vel, fx(ticks / hz + extra)));
  }
  /** Pursuit angle: the point where the chaser can meet the target if it keeps its course
   *  (fixed-point iteration on t = |target(t) - chaser| / speed), capped so a faster carrier
   *  is cut off further downfield instead of chased from behind. */
  function intercept(chaser: Actor, target: Actor): V2 {
    const sp = F.max(chaser.maxSpeed, fx(1));
    const cap = fx(T.coverage.pursuitMaxTime);
    let t = F.min(div(vdist(chaser.pos, target.pos), sp), cap);
    for (let k = 0; k < 4; k++) {
      const p = vadd(target.pos, vscale(target.vel, mul(t, fx(T.coverage.pursuitLead))));
      t = F.min(div(vdist(chaser.pos, p), sp), cap);
    }
    return vadd(target.pos, vscale(target.vel, mul(t, fx(T.coverage.pursuitLead))));
  }

  // ------------------------------------------------------------------ AI
  function blockerGoal(a: Actor, now: number): V2 {
    // zone combo: help on the down lineman first, then climb to the linebacker
    if (a.comboOn >= 0) {
      if (now < a.comboUntil && actors[a.comboOn]!.engagedWith >= 0) return actors[a.comboOn]!.pos;
      if (a.engagedWith === a.comboOn) disengage(a);
      a.comboOn = -1;
    }
    if (a.stalk && a.engagedWith < 0) {
      // stalk block: the nearest defensive back to the ball (or to the screen), stay between him and it
      const focus = (carrier()?.side === "O" && carrier() !== qb ? carrier()! : screenTarget ?? a).pos;
      let t = a.blockTarget >= 0 ? actors[a.blockTarget]! : null;
      if (!t || t.stunTil > now || vdist(t.pos, focus) > fx(12)) {
        t = null; let bd = fx(14);
        for (const d of D) {
          if (d.engagedWith >= 0 || d.stunTil > now || (claimed.has(d.i) && claimed.get(d.i) !== a.i)) continue;
          const dd = vdist(d.pos, a.pos) + idiv(vdist(d.pos, focus), 2);
          if (dd < bd) { bd = dd; t = d; }
        }
        a.blockTarget = t ? t.i : -1;
        if (t) claimed.set(t.i, a.i);
      }
      if (!t) return vadd(focus, { x: 0, y: fx(4) });
      return vadd(t.pos, vscale(vnorm(vsub(focus, t.pos)), fx(1.0)));
    }
    if (a.engagedWith >= 0) {
      const d = actors[a.engagedWith]!;
      // stay between the defender and the ball
      const protect = carrier()?.pos ?? qb.pos;
      return vadd(d.pos, vscale(vnorm(vsub(protect, d.pos)), fx(0.9)));
    }
    if (a.stunTil > now) return a.pos;
    let tgt = a.blockTarget >= 0 ? actors[a.blockTarget]! : null;
    if (!tgt) tgt = claimTarget(a);
    if (!tgt) return passSet && !screenOn ? { x: a.pos.x, y: F.max(qb.pos.y + fx(1.5), a.pos.y - fx(0.5)) } : { x: a.pos.x, y: a.pos.y + fx(2) };
    const protect = carrier()?.pos ?? qb.pos;
    return vadd(tgt.pos, vscale(vnorm(vsub(protect, tgt.pos)), fx(1.0)));
  }

  function separation(r: Actor, flight: Fx): Fx {
    const p = predictRoute(r, flight);
    let best = fx(30);
    for (const d of D) {
      const s = vdist(d.pos, p) - mul(mul(d.maxSpeed, flight), fx(T.qb.closingFactor));
      if (s < best) best = s;
    }
    return best;
  }
  const ballSpeed = () => T.throw.ballSpeedBase + T.throw.ballSpeedPer * R(qb, "throwPower") + qb.ab.mag("cannon") * AB.cannonSpeedPerYd;
  const flightTo = (p: V2) => div(vdist(qb.pos, p), fx(ballSpeed()));
  /** Throw error radius (yards) with the passer's and target's abilities. */
  function throwErr(yds: number, pressure: boolean, target: Actor | null): number {
    const accKey = yds <= T.throw.shortMax ? "throwAccuracyShort" : yds <= T.throw.midMax ? "throwAccuracyMid" : "throwAccuracyDeep";
    let acc = R(qb, accKey);
    if (yds > T.throw.midMax) { const m = qb.ab.once("moonshot"); if (m) { acc += m; noTip = true; pop(qb, "MOONSHOT!"); } }
    else if (yds < AB.dartMaxYds) { const d = qb.ab.once("dart"); if (d) { acc += d; dartCatch = true; pop(qb, "DART!"); } }
    if (pressure) acc = Math.round((acc + R(qb, "throwUnderPressure")) / 2);
    let err = T.throw.errBase + T.throw.errPerMissingAcc * (99 - Math.min(99, acc)) * (1 + yds * T.throw.errPerYard);
    if (pressure) {
      const poise = qb.ab.mag("pocket_poise") / 100;
      err *= 1 + (T.throw.pressureErrMult - 1) * (1 - poise);
      const sv = target?.ab.mag("safety_valve") ?? 0;
      if (sv) err *= 1 - sv / 100;
    }
    if (scramble || boot) err *= (2 - Math.min(99, R(qb, "throwOnTheRun") + (curTickRef.t < escapeUntil ? escapeBonus : 0)) / 99) * (T.throw.onRunErrMult / 1.35);
    return err;
  }
  let noTip = false, dartCatch = false, escapeUntil = -1, escapeBonus = 0;

  function tryThrow(now: number) {
    const t = now / hz;
    const reads = (inp.play.read ?? []).map((role) => byRole("O", role)).filter((r) => r.task === "route" && now >= r.releaseAt);
    if (!reads.length) return;
    // pressure only registers after the QB has had time to feel it (awareness); until then a free
    // rusher can get home for a sack
    const raw = rushers().some((d) => d.engagedWith < 0 && vdist(d.pos, qb.pos) < fx(T.qb.pressureRange));
    if (!raw) pressureSince = -1; else if (pressureSince < 0) pressureSince = now;
    const pressure = raw && now - pressureSince >= sec(T.qb.pressureReactBase + T.qb.pressureReactPerMissing * (99 - R(qb, "awareness")));
    if (now < readStart && !pressure) return;
    // screens: get it out as soon as the target has released
    if (inp.play.tags.includes("screen")) {
      const r = reads[0]!;
      if (now >= r.releaseAt + sec(T.schemes.screenThrowAfter)) return throwTo(r, now, pressure);
      return;
    }
    const span = Math.max(0.1, T.qb.maxHold - readStart / hz);
    const k = Math.min(1, Math.max(0, (t - readStart / hz) / span));
    // a high-awareness QB anticipates and throws into tighter windows
    const need = (T.qb.openSepStart + (T.qb.openSepEnd - T.qb.openSepStart) * k) * Math.max(0.6, 1 - T.qb.windowPerAwareness * (R(qb, "awareness") - 75));
    // the QB has progressed this far through his reads; earlier reads stay available
    const progressed = Math.min(reads.length - 1, Math.max(0, Math.floor((now - readStart) / sec(T.qb.readWindow))));
    let pick: Actor | null = null, best: Actor | null = null, bestSep = fx(-99);
    for (let j = 0; j < reads.length; j++) {
      const r = reads[j]!;
      let sep = separation(r, flightTo(r.pos));
      const deep = r.pos.y - los > fx(15) ? T.qb.openSepDeepBonus : 0;
      if (!pick && j <= progressed && sep > fx(need + deep)) pick = r;
      // misread: once per read, a QB may think a covered man is open (lower awareness = more often)
      else if (!pick && j === progressed && !misreadRolled) {
        misreadRolled = true;
        const p = Math.round(1000 * (T.qb.misreadBase + T.qb.misreadPerMissing * (99 - R(qb, "awareness"))));
        if (rng.int(1000) < p) {
          // he doesn't see the lurking defender: throws to the most tightly covered man he has looked at
          let worst = r, ws = fx(1e3);
          for (let k = 0; k <= progressed; k++) { const rr = reads[k]!; const sp = separation(rr, flightTo(rr.pos)); if (sp < ws) { ws = sp; worst = rr; } }
          pick = worst;
          log.push(`${qb.c.name} misreads the coverage`);
        }
      }
      if (sep > bestSep) { bestSep = sep; best = r; }
    }
    if (pick) return throwTo(pick, now, pressure);
    const fast = R(qb, "speed") >= T.qb.scrambleSpeedMin;
    const late = t > readStart / hz + T.qb.scrambleAfter;
    if (pressure || t > T.qb.maxHold) {
      if (best && bestSep > fx(0.5)) return throwTo(best, now, pressure);
      if (fast && late) return startScramble(now);
      if (R(qb, "awareness") >= T.qb.throwAwayAwareness || t > T.qb.maxHold + 1) return throwAway(now);
      return; // holds it: sack risk
    }
    if (fast && late && t > readStart / hz + T.qb.scrambleAfter + 0.5) startScramble(now);
  }

  /** Where a receiver will be after `t` seconds if he keeps running his route (settling at the end). */
  function predictRoute(r: Actor, t: Fx): V2 {
    let pos = r.pos, left = mul(t, r.maxSpeed);
    let dir = vnorm(r.vel);
    for (let k = r.routeIdx; k < r.route.length && left > 0; k++) {
      const wp = r.route[k]!;
      const seg = vdist(pos, wp);
      // a hard cut (> ~75 degrees) costs time to plant and turn
      const nd = vnorm(vsub(wp, pos));
      if ((dir.x !== 0 || dir.y !== 0) && F.vdot(dir, nd) < fx(0.26)) left -= mul(fx(T.qb.cutCost), r.maxSpeed);
      if (left <= 0) return pos;
      if (seg >= left) return vadd(pos, vscale(nd, left));
      left -= seg; pos = wp; dir = nd;
    }
    if (left <= 0 || r.settle || r.route.length === 0) return pos;
    const last = r.route[r.route.length - 1] ?? r.pos, prev = r.route[r.route.length - 2] ?? r.pos;
    const endDir = vnorm(vsub(last, prev));
    return vadd(pos, vscale(endDir.x === 0 && endDir.y === 0 ? vnorm(r.vel) : endDir, left));
  }

  function throwTo(r: Actor, now: number, pressure: boolean) {
    let flight = flightTo(r.pos);
    let aim = predictRoute(r, flight);
    flight = flightTo(aim);
    aim = predictRoute(r, flight);
    const dist = vdist(qb.pos, aim);
    const yds = dist / ONE;
    const err = throwErr(yds, pressure, r);
    const errFx = mul(fx(err), fx(rng.int(1000) / 1000));
    const angle = fx(((rng.int(360) - 180) * Math.PI) / 180);
    aim = vadd(aim, F.vfromAngle(angle, errFx));
    aim = { x: F.clamp(aim.x, fx(-1), W + fx(1)), y: aim.y };
    const ticks = Math.max(3, Math.round(mul(flightTo(aim), fromIntHz(hz)) / ONE));
    Object.assign(ball, { state: "air", from: qb.pos, to: aim, t0: now, t1: now + ticks, target: r.i, thrower: qb.i });
    qbHasBall = false; pressureAtThrow = pressure;
    throwInfo = { qb, target: r, airYds: aim.y - los };
    log.push(`${qb.c.name} throws to ${r.c.name} (${Math.round((aim.y - los) / ONE)} air yds${pressure ? ", under pressure" : ""})`);
  }
  function throwAway(now: number) {
    const aim = { x: qb.pos.x < W / 2 ? fx(-3) : W + fx(3), y: qb.pos.y + fx(8) };
    Object.assign(ball, { state: "air", from: qb.pos, to: aim, t0: now, t1: now + sec(0.8), target: -1, thrower: qb.i });
    qbHasBall = false;
    throwInfo = { qb, target: qb, airYds: 0 };
    log.push(`${qb.c.name} throws it away`);
  }
  function startScramble(now: number) {
    scramble = true; qbHasBall = false;
    qb.task = "carry";
    runRecognizedAt = now + sec(0.3);
    log.push(`${qb.c.name} scrambles`);
  }

  /** Ball carrier: pick the open lane with the most room, biased upfield; re-plans every few ticks. */
  let laneGoal: V2 | null = null, laneDir: V2 | null = null, laneUntil = -1, laneOwner = -1;
  function carrierGoal(a: Actor, now: number): V2 {
    if (inp.userOffense && a.side === "O" && userMove && (userMove.x !== 0 || userMove.y !== 0)) return vadd(a.pos, vscale(vnorm(userMove), fx(5)));
    if (laneOwner === a.i && now < laneUntil && laneDir) return vadd(a.pos, vscale(laneDir, fx(5)));
    const g = pickLane(a, now);
    laneOwner = a.i;
    laneUntil = now + Math.max(2, Math.round(T.carrier.replanTicksBase - T.carrier.replanPerAgility * R(a, "agility")));
    laneDir = vnorm(vsub(g, a.pos));
    laneGoal = g;
    return g;
  }
  function pickLane(a: Actor, now: number): V2 {
    const dir = a.side === "O" ? 1 : -1;
    if (a.side === "O" && !completion && !scramble && now - runStart < sec(T.carrier.followAimFor) && inp.play.aim) {
      const [ax, ay] = inp.play.aim;
      // a QB who keeps on the read option heads the other way (inside on a veer)
      if (kept && a === qb) {
        if (F.abs(ax) > 6) return { x: bx + fx(aimSide * 1.5), y: los + fx(4) };
        // bend around the read end: get outside him first, then turn upfield
        const kx = optionKey ? optionKeyX - fx(aimSide * 3) : bx - fx(aimSide * 7);
        return a.pos.y < los - fx(0.5) ? { x: kx, y: los - fx(0.3) } : { x: kx - fx(aimSide), y: los + fx(5) };
      }
      return { x: bx + fx(ax * flipX), y: los + fx(ay) };
    }
    const look = fx(T.carrier.lookAhead), perpW = fx(T.carrier.lanePerp);
    const noise = T.carrier.visionNoisePerMissing * Math.max(0, 99 - R(a, "bCVision") - a.ab.mag("vision"));
    let best: V2 = { x: a.pos.x, y: a.pos.y + look * dir }, bestScore = -1e9;
    for (const deg of T.carrier.laneAngles) {
      const d = F.vfromAngle(DEG(90 * dir - deg * dir), ONE);
      let score = (d.y * dir) / ONE * T.carrier.forwardWeight * 10;
      for (const e of opponents(a)) {
        if (e.engagedWith >= 0 || e.stunTil > now) continue;
        const rel = vsub(e.pos, a.pos);
        const along = F.vdot(rel, d);
        if (along < 0 || along > look) continue;
        const perp = F.abs(mul(rel.x, d.y) - mul(rel.y, d.x));
        if (perp < perpW) score -= ((perpW - perp) / ONE) * ((look - along) / ONE) * 1.5;
      }
      const end = vadd(a.pos, vscale(d, fx(4)));
      const m = fx(T.carrier.sidelineMargin);
      if (end.x < m || end.x > W - m) score -= 25;
      score += (rng.int(1000) / 1000 - 0.5) * noise * 10;
      if (score > bestScore) { bestScore = score; best = vadd(a.pos, vscale(d, fx(5))); }
    }
    return best;
  }

  function defenderGoal(d: Actor, now: number): V2 {
    const g = defenderGoalInner(d, now);
    if (inp.record && (globalThis as { __TDF_DEBUG_ROLE?: string }).__TDF_DEBUG_ROLE === d.role && now % 6 === 0) log.push(`t=${(now / hz).toFixed(1)} ${d.role} goal (${(g.x / ONE).toFixed(1)},${(g.y / ONE).toFixed(1)}) branch=${lastBranch}`);
    return g;
  }
  let lastBranch = "";
  function defenderGoalInner(d: Actor, now: number): V2 {
    if (d.engagedWith >= 0) { lastBranch = "engaged"; const tgt = carrier() ?? qb; return tgt.pos; }
    if (d.stunTil > now) { lastBranch = "stunned"; return d.pos; }
    // during a mesh (option, RPO, draw) the threat is the back as much as the QB
    const c = handoffAt >= 0 && runner && runner !== qb && !isDraw ? runner : carrier();
    // option key: crash on the back or squeeze the QB
    if (d === optionKey && handoffAt >= 0) return keyCrashes ? intercept(d, runner!) : qb.pos;
    // play action: step up on the fake
    if (d.biteUntil > now && ball.state === "held" && carrier() === qb) { lastBranch = "bite"; return { x: d.pos.x + (fakePoint.x > d.pos.x ? fx(0.6) : -fx(0.6)), y: F.max(los + fx(1), d.pos.y - fx(T.pa.biteStep)) }; }
    // ball in the air: break on it after a reaction delay
    if (ball.state === "air" && ball.target >= 0) {
      const react = sec(T.coverage.ballReactBase + T.coverage.ballReactPerMissing * (99 - R(d, "awareness")));
      if (now - ball.t0 >= react) { lastBranch = "ball"; return ball.to; }
    }
    const pursuing = c && (c.side === "D" ? true : c !== qb || scramble || !(isPass || (isRpo && qbHasBall))) && (now >= runRecognizedAt || c.side === "D" || completion);
    if (c && c.side === "O" && (c.task === "carry" || handoffAt >= 0) && !isPass && !completion && !scramble && !(isDraw && !handedOff)) {
      const read = sec(T.coverage.runReadBase + T.coverage.runReadPerMissing * (99 - R(d, "playRecognition")));
      if (now - runStart >= read) return intercept(d, c);
      // still reading: second-level players flow with the ball at their depth, the rest play their assignment
      if (d.task !== "rush" && (d.cls === "LB" || d.pos.y - los < fx(7))) { lastBranch = "flow"; return { x: c.pos.x, y: F.max(los + fx(1.5), d.pos.y - fx(0.4)) }; }
      if (d.task !== "rush") return assignmentGoal(d, now);
    }
    if (pursuing && c && c.side !== d.side) { lastBranch = "pursue"; return intercept(d, c); }
    return assignmentGoal(d, now);
  }
  function assignmentGoal(d: Actor, now: number): V2 {
    const c = carrier();
    if (d.task === "rush") return qbHasBall ? qb.pos : c ? intercept(d, c) : qb.pos;
    if (d.task === "spy") {
      lastBranch = "spy";
      if (c === qb && (scramble || qb.task === "carry")) return intercept(d, qb);
      return { x: qb.pos.x, y: F.max(los + fx(4), d.pos.y - fx(0.3)) };
    }
    if (d.task === "man") {
      const r = actors[d.manTarget]!;
      // his man stayed in to block: green-dog rush
      if (r.task === "block" && r.isBlocker && !r.stalk && now > d.reactTicks + sec(0.4) && passSet) { d.task = "rush"; return qb.pos; }
      // what the defender has seen (reaction lag), and where that says the receiver is heading
      const seen = delayedPos(r, d.reactTicks);
      const before = delayedPos(r, d.reactTicks + 6);
      const vel = vscale(vsub(seen, before), fx(hz / 6));
      const ahead = anticipate(r, d.reactTicks);
      const cushion = fx(T.coverage.manCushion);
      const inside = seen.x > bx ? -fx(0.5) : fx(0.5);
      lastBranch = "man";
      // vertical stem: bail, staying over the top of where he is heading; never come up toward the line
      let y = vel.y > fx(1) ? ahead.y + fx(T.coverage.manBailCushion) : ahead.y + cushion;
      if (y < d.pos.y && vel.y > -fx(0.5)) y = d.pos.y;
      return { x: ahead.x + inside, y };
    }
    if (d.task === "zone" && d.zone) {
      const z = d.zone;
      let threat: Actor | null = null, td = z.r + fx(T.coverage.zoneSwitchRange);
      if (z.deep) {
        // deep zones: the deepest receivers in my horizontal band; with two vertical threats,
        // split them (sit between) so I can break on either throw
        const band = O.filter((o) => o.task === "route" && F.abs(delayedPos(o, d.reactTicks).x - z.at.x) <= z.r + fx(2))
          .sort((p, q) => delayedPos(q, d.reactTicks).y - delayedPos(p, d.reactTicks).y);
        const a1 = band[0], a2 = band[1];
        if (a1 && a2 && delayedPos(a2, d.reactTicks).y - los > fx(5)) {
          const s1 = anticipate(a1, d.reactTicks), s2 = anticipate(a2, d.reactTicks);
          lastBranch = "zone-split";
          return { x: idiv(s1.x + s2.x, 2), y: F.max(F.max(s1.y, s2.y) + fx(T.coverage.deepCushion), z.at.y) };
        }
        threat = a1 ?? null;
      } else {
        for (const o of O) {
          if (o.task !== "route") continue;
          const dd = vdist(delayedPos(o, d.reactTicks), z.at);
          if (dd < td) { td = dd; threat = o; }
        }
      }
      if (!threat) {
        lastBranch = "zone-empty";
        if (z.deep) return z.at;
        // nobody to cover yet: drift toward the landmark with eyes on the QB
        const to = vsub(z.at, d.pos), dist = vlen(to);
        return dist < fx(0.5) ? z.at : vadd(d.pos, vscale(vnorm(to), fx(T.coverage.zoneDriftStep)));
      }
      lastBranch = "zone:" + threat.role;
      const seen = anticipate(threat, d.reactTicks);
      // deep zones: stay over the top of the deepest threat (turn and run, no backpedal)
      if (z.deep) return { x: F.lerp(z.at.x, seen.x, fx(0.75)), y: F.max(seen.y + fx(T.coverage.deepCushion), z.at.y) };
      // underneath zones: carry a receiver who runs vertically through my zone (trail just
      // underneath and inside him) until he is past the zone's depth limit, then hand him off
      const carryLimit = z.at.y + z.r + fx(3);
      if (seen.y > d.pos.y - fx(1) && seen.y < carryLimit) {
        const inside = seen.x > bx ? -fx(0.8) : fx(0.8);
        return { x: seen.x + inside, y: seen.y - fx(0.8) };
      }
      if (seen.y >= carryLimit) return { x: F.lerp(z.at.x, seen.x, fx(0.5)), y: z.at.y + z.r };
      return vadd(seen, vscale(vnorm(vsub(qb.pos, seen)), fx(1.5)));
    }
    return d.pos;
  }

  function offenseGoal(a: Actor, now: number): V2 {
    const c = carrier();
    // mesh: the QB rides the ball while the back runs his path
    if (handoffAt >= 0 && a === qb) return isDraw ? dropPoint : a.pos;
    if (handoffAt >= 0 && a === runner && runner !== qb) { const [ax, ay] = inp.play.aim ?? [0, 3]; return { x: bx + fx(ax * flipX), y: los + fx(ay) }; }
    if (c === a && !(a === qb && qbHasBall)) return carrierGoal(a, now);
    if (a.side === "O" && c && c.side === "D") return intercept(a, c);   // turnover: chase
    if (a.task === "pull" || a.task === "lead") {
      // pulling guard / lead back: run the path to the hole, then block whoever shows up there
      const wp = a.route[a.routeIdx];
      if (wp && vdist(a.pos, wp) < fx(1.6)) a.routeIdx++;
      const nx = a.route[a.routeIdx];
      if (nx) return nx;
      a.task = "block"; a.blockTarget = -1;
      return blockerGoal(a, now);
    }
    if (a.task === "block") {
      if (inp.play.pa && a === runner0 && now < sec(T.pa.fakeSeconds)) return fakePoint;
      return blockerGoal(a, now);
    }
    if (a.task === "qb") {
      if (!qbHasBall) return a.pos;
      if (now < readStart) return dropPoint;
      // slide away from the nearest free rusher
      let near: Actor | null = null, nd = fx(4);
      for (const d of rushers()) { const dd = vdist(d.pos, a.pos); if (d.engagedWith < 0 && dd < nd) { nd = dd; near = d; } }
      if (near && R(a, "agility") >= T.qb.evadeAgilityMin) return vadd(a.pos, vscale(vnorm(vsub(a.pos, near.pos)), fx(T.qb.evadeStep)));
      return a.pos;
    }
    if (a.task === "route") {
      if (now < a.releaseAt) return blockerGoal(a, now);
      if (now < a.jamUntil) return a.pos;
      if (a.isBlocker) {
        // release from the block into the route
        a.isBlocker = false;
        disengage(a);
      }
      if (ball.state === "air" && ball.target === a.i) return ball.to;
      if (completion && c && c.side === "O") return blockerGoalFree(a);  // block downfield after a catch
      if (a.routeIdx < a.route.length) {
        const wp = a.route[a.routeIdx]!;
        if (vdist(a.pos, wp) < fx(0.9)) { a.routeIdx++; a.brake = false; return offenseGoal(a, now); }
        // brake into the last point of a settle route, or into a hard cut
        const next = a.route[a.routeIdx + 1];
        const isLast = a.routeIdx === a.route.length - 1;
        const sharp = next ? F.vdot(vnorm(vsub(wp, a.pos)), vnorm(vsub(next, wp))) < fx(0.26) : false;
        a.brake = (isLast && a.settle) || sharp;
        return wp;
      }
      a.brake = false;
      if (a.settle) return a.pos;
      const last = a.route[a.route.length - 1] ?? a.pos;
      const prev = a.route[a.route.length - 2] ?? { x: last.x, y: last.y - ONE };
      return vadd(a.pos, vscale(vnorm(vsub(last, prev)), fx(5)));
    }
    return a.pos;
  }
  function blockerGoalFree(a: Actor): V2 {
    let best: Actor | null = null, bd = fx(8);
    for (const d of D) { const dd = vdist(a.pos, d.pos); if (dd < bd) { bd = dd; best = d; } }
    return best ? best.pos : a.pos;
  }

  // ------------------------------------------------------------------ contacts
  function engage(now: number) {
    for (const b of O) {
      if (!b.isBlocker || b.engagedWith >= 0 || b.stunTil > now) continue;
      const pulling = b.task === "pull" || b.task === "lead";
      if (pulling && b.routeIdx === 0) continue;
      if (inp.play.pa && b === runner0 && now < sec(T.pa.fakeSeconds)) continue;
      const want = b.comboOn >= 0 && now < b.comboUntil ? b.comboOn : b.blockTarget;
      const passing = passSet && !scramble && !handedOff && !screenOn && !b.stalk;
      for (const d of D) {
        if (d.stunTil > now || vdist(b.pos, d.pos) > fx(T.blocking.engageRange)) continue;
        if (want >= 0 && want !== d.i && !pulling) continue;
        if (pulling && (d.engagedWith >= 0 || d.pos.y < los - fx(1))) continue;
        if (passSet && !b.stalk && !screenOn && d.task !== "rush" && !scramble && !handedOff) continue;
        if (d.ab.mag("blitz") && now < sec(d.ab.mag("blitz"))) continue;
        const blk = passing ? (R(b, "passBlock") * 2 + R(b, "passBlockPower") + R(b, "passBlockFinesse")) / 4
          : (R(b, "runBlock") * 2 + R(b, "runBlockPower") + R(b, "impactBlocking")) / 4;
        const rush = passing ? (Math.max(R(d, "powerMoves"), R(d, "finesseMoves")) * 2 + R(d, "blockShedding") + R(d, "strength")) / 4
          : (R(d, "blockShedding") * 2 + R(d, "strength") + R(d, "playRecognition")) / 4;
        const base = passing ? T.blocking.passHoldBase : T.blocking.runHoldBase;
        const per = passing ? T.blocking.passHoldPer : T.blocking.runHoldPer;
        const jit = passing ? T.blocking.passHoldJitter : T.blocking.runHoldJitter;
        let hold = base + per * (blk - rush) + (rng.int(1000) / 1000 - 0.5) * 2 * jit;
        if (abOn) hold = blockAbilities(b, d, hold, passing);
        if (d.engagedWith >= 0) {
          // double team: extend the existing block instead
          const first = actors[d.engagedWith]!;
          first.shedTick += Math.round((first.shedTick - now) * (T.blocking.doubleTeamMult - 1));
          d.shedTick = first.shedTick;
          b.engagedWith = d.i; b.shedTick = d.shedTick;
          break;
        }
        hold = Math.max(0.15, hold);
        d.engagements++;
        // pancake: the defender goes down instead
        const pk = b.ab.once("pancake");
        // (the blocker stays on him: the block holds through the time he is down)
        if (pk) { pop(b, "PANCAKE!"); d.stunTil = now + sec(pk); hold += pk; }
        if (pulling) { b.task = "block"; b.blockTarget = d.i; claimed.set(d.i, b.i); }
        b.engagedWith = d.i; d.engagedWith = b.i;
        if (inp.record) log.push(`t=${(now / hz).toFixed(2)} engage ${b.role}-${d.role} hold ${hold.toFixed(2)}s`);
        b.shedTick = d.shedTick = now + sec(hold);
        break;
      }
    }
    for (const d of D) {
      if (d.engagedWith >= 0 && now >= d.shedTick) {
        const b = actors[d.engagedWith]!;
        d.engagedWith = -1;
        for (const x of O) if (x.engagedWith === d.i) { x.engagedWith = -1; x.stunTil = now + sec(T.blocking.shedStun); x.blockTarget = -1; }
        claimed.delete(d.i);
        void b;
      }
    }
  }

  /** Abilities on a block: the blocker's (anchor, mirror, road grader, brick wall, seal, lead) and the rusher's. */
  function blockAbilities(b: Actor, d: Actor, hold: number, passing: boolean): number {
    const power = R(d, "powerMoves") >= R(d, "finesseMoves");
    if (passing) {
      hold *= 1 + AB.passProHoldPer * b.ab.mag(power ? "anchor" : "mirror") / 100;
      const br = d.ab.once("bull_rush"); if (br) { hold *= Math.max(AB.bullRushMinHold, 1 - br * AB.bullRushPerYd); pop(d, "BULL RUSH!"); }
      const sw = d.ab.once("swim"); if (sw) { hold = Math.max(AB.swimMinHold, hold - sw); pop(d, "SWIM!"); }
    } else {
      hold += b.ab.mag("road_grader") * AB.roadGraderHoldPerYd;
      hold *= 1 - d.ab.mag("run_plug") / 100;
      if (b.role === "Y" || b.role === "H") { const se = b.ab.once("seal_edge"); if (se) { hold += se; pop(b, "SEAL!"); } }
    }
    if (b === leadBlocker) { const lb = b.ab.once("lead_block"); if (lb) { hold += lb; pop(b, "LEAD BLOCK!"); } }
    if (d.engagements > 0) hold *= 1 - d.ab.mag("relentless") / 100;
    const bw = b.ab.mag("brick_wall") || (OL_ROLES.includes(b.role) && olWall ? AB.olSignatureHold : 0);
    if (bw) hold = Math.max(hold, bw);
    if (d.ab.signature === "DL") hold = Math.min(hold, AB.dlSignatureHold);
    return hold;
  }
  const olWall = O.some((o) => OL_ROLES.includes(o.role) && o.ab.signature === "OL");

  /** a blocker lets go (route release, combo climb, screen release) */
  function disengage(b: Actor) {
    if (b.engagedWith < 0) return;
    const d = actors[b.engagedWith]!;
    b.engagedWith = -1;
    if (d.engagedWith === b.i) d.engagedWith = O.find((x) => x.engagedWith === d.i)?.i ?? -1;
  }

  /** Carrier abilities that beat the next tackle: ankle breaker, cyclone, stiff arm, battering ram, RB signature.
   *  Returns how long the tackler is down (seconds), or 0. */
  function carrierEscape(c: Actor, d: Actor, now: number): number {
    if (!abOn) return 0;
    if (c.ab.signature === "RB" && sigMisses < AB.rbSignatureMisses) { sigMisses++; pop(c, c.c.signature?.name ?? "SIGNATURE"); return AB.rbSignatureStun; }
    const ak = c.ab.once("ankle_breaker"); if (ak) { pop(c, "ANKLE BREAKER!"); return ak; }
    const cy = c.ab.once("cyclone"); if (cy) { pop(c, "CYCLONE!"); c.vel = vscale(c.vel, fx(1 + cy / 100)); return AB.cycloneStun; }
    const sa = c.ab.once("stiff_arm"); if (sa) { pop(c, "STIFF ARM!"); c.vel = vadd(c.vel, vscale(vnorm(vsub(c.pos, d.pos)), fx(sa))); return AB.stiffArmStun; }
    const br = c.ab.mag("battering_ram");
    if (br && carryStart >= 0 && now - carryStart < sec(AB.ramSeconds) && ramTrucks < AB.ramMaxTrucks && R(d, "strength") < br) { ramTrucks++; pop(c, "TRUCKED!"); return AB.ramStun; }
    return 0;
  }
  let sigMisses = 0, ramTrucks = 0, carryStart = -1, carryHolder = -1;

  function tackles(now: number) {
    const c = carrier();
    if (!c) return;
    for (const e of opponents(c)) { const dd = vdist(e.pos, c.pos) / ONE; if (dd < dbg.minDist) dbg.minDist = dd; }
    const defenders = opponents(c);
    const near = defenders.filter((d) => d.engagedWith < 0 && d.stunTil <= now && vdist(d.pos, c.pos) < fx(T.tackle.range));
    for (const d of near) {
      if (now - d.lastTackleTry < sec(0.5)) continue;
      if (attempt(d, c, now, near.length - 1, 0)) return;
    }
  }
  /** One tackle (or sack) attempt; bonus = extra per-mille (a human dive). Returns true if the play ended. */
  function attempt(d: Actor, c: Actor, now: number, gang: number, bonus: number): boolean {
    {
      d.lastTackleTry = now;
      const U = T.userDefense;
      const strip = d.i === udef && stripUntil > now;
      if (c === qb && qbHasBall) {
        // sack attempt
        let p = clampPm(T.tackle.sackBase - T.tackle.sackPer * (R(c, "breakSack") - 60) + T.tackle.per * (R(d, "tackle") - 70) / 2);
        if (d.ab.signature === "DL") p += AB.dlSignatureSack;
        // escape: the QB slips the next sack and rolls out
        const es = c.ab.once("escape");
        if (es) { pop(c, "ESCAPE!"); d.stunTil = now + sec(AB.escapeStun); escapeUntil = now + sec(AB.escapeSeconds); escapeBonus = es; return false; }
        if (rng.int(1000) < p) {
          stats.push({ k: "sack", id: d.c.id, team: defSide }, { k: "tackle", id: d.c.id, team: defSide });
          log.push(`SACK by ${d.c.name}`);
          const ss = d.ab.once("strip_sack");
          if (ss && rng.int(100) < ss) {
            pop(d, "STRIP SACK!");
            stats.push({ k: "fumble", id: c.c.id, team: inp.offSide });
            if (rng.int(1000) >= T.tackle.fumbleOffenseRecover) { stats.push({ k: "fumbleLost", id: c.c.id, team: inp.offSide }); turnover = "fumble"; log.push("FUMBLE, recovered by the defense"); }
          }
          ended = { reason: "sack", y: c.pos.y, x: c.pos.x, sack: true };
          return true;
        }
        d.stunTil = now + sec(T.tackle.missStun);
        return false;
      }
      const moves = [R(c, "breakTackle"), (R(c, "jukeMove") + R(c, "agility")) / 2, (R(c, "trucking") + R(c, "strength")) / 2,
        R(c, "stiffArm") * 0.92, (R(c, "spinMove") + R(c, "agility")) / 2];
      const best = Math.max(...moves), avg = moves.reduce((x, y) => x + y, 0) / moves.length;
      const elusive = best * T.tackle.elusiveMaxWeight + avg * (1 - T.tackle.elusiveMaxWeight);
      // ability escapes: the next tackle attempt simply misses
      const autoMiss = carrierEscape(c, d, now);
      if (autoMiss) { d.stunTil = now + sec(autoMiss); return false; }
      // a well-timed juke or spin (human-controlled carrier) makes this tackle harder
      let moveBonus = 0;
      if (moveUntil.juke > now) moveBonus = T.user.moveBonusBase + T.user.moveBonusPer * (R(c, "jukeMove") - 60);
      else if (moveUntil.spin > now) moveBonus = T.user.moveBonusBase + T.user.moveBonusPer * (R(c, "spinMove") - 60);
      let p = clampPm(T.tackle.base + T.tackle.per * (R(d, "tackle") - elusive) + T.tackle.powerPer * (R(d, "hitPower") - R(c, "strength")) +
        gang * T.tackle.gangBonus - moveBonus + bonus - (strip ? U.stripTacklePenalty : 0));
      const st2 = d.ab.mag("sure_tackler");
      if (st2) p = Math.round(1000 - (1000 - p) * (1 - st2 / 100));
      dbg.tries++;
      if (rng.int(1000) < p) {
        stats.push({ k: "tackle", id: d.c.id, team: c.side === "O" ? defSide : inp.offSide });
        // fumble?
        let fp = Math.max(T.tackle.fumbleMin, Math.min(T.tackle.fumbleMax, T.tackle.fumbleBase + T.tackle.fumblePer * (R(d, "hitPower") - R(c, "carrying"))));
        if (strip) fp = Math.round(fp * U.stripFumbleMult);
        const lo = d.ab.once("lights_out"); if (lo) { fp = Math.max(fp, lo * AB.lightsOutFumblePer); pop(d, "LIGHTS OUT!"); }
        fp = Math.round(fp * (1 - c.ab.mag("ball_security") / 100));
        if (rng.int(1000) < fp) {
          const offenseKeeps = rng.int(1000) < (c.side === "O" ? T.tackle.fumbleOffenseRecover : 1000 - T.tackle.fumbleOffenseRecover);
          stats.push({ k: "fumble", id: c.c.id, team: c.side === "O" ? inp.offSide : defSide });
          log.push(`FUMBLE by ${c.c.name}, recovered by ${offenseKeeps ? "his team" : "the opponent"}`);
          if (!offenseKeeps) {
            stats.push({ k: "fumbleLost", id: c.c.id, team: c.side === "O" ? inp.offSide : defSide });
            // offense fumbles -> turnover; a returner fumbling back to the offense cancels the turnover
            turnover = c.side === "O" ? "fumble" : null;
            fumbleBackToOffense = c.side === "D";
          }
        }
        log.push(`${c.c.name} tackled by ${d.c.name}`);
        // momentum: a back running downhill falls forward
        const dirY = c.side === "O" ? 1 : -1;
        const fwd = Math.max(0, (c.vel.y * dirY) / ONE);
        // yards after contact: momentum plus the carrier's power against the tackler's
        const power = (R(c, "trucking") + R(c, "strength") + R(c, "breakTackle")) / 3 - (R(d, "hitPower") + R(d, "tackle")) / 2;
        const extra = fwd < 0.3 ? 0 : Math.max(0, Math.min(T.tackle.fallForwardMax,
          T.tackle.fallForwardBase + fwd * T.tackle.fallForwardPerSpeed * 0.5 + power * T.tackle.afterContactPowerPer + gang * -0.6));
        const ff = completion && completion.rec === c ? extra * T.tackle.fallForwardReceiverMult : extra;
        ended = { reason: "tackle", y: c.pos.y + fx(ff) * dirY, x: c.pos.x };
        return true;
      }
      d.stunTil = now + sec(bonus > 0 ? U.diveMissStun : T.tackle.missStun);
      c.vel = vscale(c.vel, fx(1 - T.tackle.carrierSlowOnMiss));
      dbg.missed++;
      return false;
    }
  }
  const clampPm = (p: number) => Math.round(Math.max(T.tackle.min, Math.min(T.tackle.max, p)));

  let pickSixer: Actor | null = null;
  function nearestTo(list: Actor[], p: V2): Actor | null { let b: Actor | null = null, bd = fx(1e4); for (const a of list) { const d = vdist(a.pos, p); if (d < bd) { bd = d; b = a; } } return b; }
  function resolveCatch(now: number) {
    const L = ball.to;
    if (ball.target < 0 || L.x < 0 || L.x > W) {
      ended = { reason: "incomplete", y: los, x: bx, incomplete: true };
      if (throwInfo) stats.push({ k: "pass", id: throwInfo.qb.c.id, team: inp.offSide, att: 1, comp: 0, yds: 0 });
      return;
    }
    let r = actors[ball.target]!;
    if (userThrow) {
      // a human throws to a spot: whoever on offense is closest to where it lands goes up for it
      let best = r, bd = vdist(r.pos, L);
      for (const o of O) if (o.task === "route" && vdist(o.pos, L) < bd) { bd = vdist(o.pos, L); best = o; }
      r = best;
    }
    const reach = fx(T.catch.reach), contest = fx(T.catch.contestRange);
    let def: Actor | null = null, dd = contest;
    for (const d of D) { const x = vdist(d.pos, L); if (x < dd) { dd = x; def = d; } }
    // a human defender who timed a swat/jump near the catch point
    const ud = udef >= 0 ? actors[udef]! : null;
    const swat = Boolean(ud && swatUntil >= now && vdist(ud.pos, L) <= fx(T.userDefense.swatRange));
    if (swat && ud) { def = ud; dd = F.min(vdist(ud.pos, L), contest - 1); }
    const inReach = vdist(r.pos, L) <= reach;
    const att = { k: "pass" as const, id: qb.c.id, team: inp.offSide, att: 1 };
    // the coverage defender's lockdown: the throw is broken up
    if (def && !noTip) {
      const lk = def.manTarget === r.i || def === nearestTo(D, L) ? def.ab.mag("lockdown") : 0;
      if (lk && rng.int(100) < lk) {
        pop(def, "LOCKDOWN!");
        stats.push({ k: "rec", id: r.c.id, team: inp.offSide, target: 1 }, { k: "defended", id: def.c.id, team: defSide }, { ...att, comp: 0, yds: 0 });
        throwInfo = null; ended = { reason: "incomplete", y: los, x: bx, incomplete: true }; log.push("incomplete");
        return;
      }
    }
    stats.push({ k: "rec", id: r.c.id, team: inp.offSide, target: 1 });
    let pCatch = 0;
    if (inReach) {
      pCatch = T.catch.baseCatch + T.catch.catchPer * (R(r, "catching") - 60);
      // ball placement: a throw that makes the receiver reach is harder to catch
      pCatch -= T.catch.placementPenalty * (vdist(r.pos, L) / reach);
      // over-the-shoulder catches get harder with depth (spectacular-catch skill offsets it)
      const airYds = (L.y - los) / ONE;
      if (airYds > T.catch.deepCatchFrom) pCatch -= (airYds - T.catch.deepCatchFrom) * T.catch.deepCatchPenaltyPerYard * (1.4 - R(r, "spectacularCatch") / 99);
      if (def) {
        let skill = (R(r, "catchInTraffic") + R(r, "spectacularCatch")) / 2;
        const sky = r.ab.once("skywalker"); if (sky) { skill += sky; pop(r, "SKYWALKER!"); }
        const tt = r.ab.once("toe_tap"); if (tt) { skill += tt; pop(r, "TOE TAP!"); }
        const cov = (Math.max(R(def, "manCoverage"), R(def, "zoneCoverage")) + R(def, "playRecognition")) / 2;
        const closeness = 1 - dd / contest;
        pCatch -= (T.catch.contestPenalty - T.catch.contestSkillPer * (skill - cov)) * closeness;
      }
      if (swat) pCatch -= T.userDefense.swatCatchPenalty;
      // sticky hands: fewer drops; signature moves: WR = any ball in reach, TE = jump balls over shorter men
      const sh = r.ab.mag("sticky_hands");
      if (sh) pCatch = 1000 - (1000 - pCatch) * (1 - AB.stickyHandsMult * sh / 100);
      if (r.ab.signature === "WR" || (r.ab.signature === "TE" && (!def || def.c.htIn < 74))) { pCatch = 1000; pop(r, r.c.signature?.name ?? "SIGNATURE"); }
    }
    const roll = rng.int(1000);
    if (roll < Math.max(0, Math.min(r.ab.signature ? 1000 : 980, pCatch))) {
      // a missile from the closest defender can still jar it loose
      const ms = def && dd < fx(AB.missileRangeYds) ? def.ab.once("missile") : 0;
      if (ms && rng.int(100) < ms) {
        pop(def!, "MISSILE!");
        stats.push({ k: "defended", id: def!.c.id, team: defSide }, { ...att, comp: 0, yds: 0 });
        throwInfo = null; ended = { reason: "incomplete", y: los, x: bx, incomplete: true }; log.push("incomplete (jarred loose)");
        return;
      }
      ball.state = "held"; ball.holder = r.i;
      r.vel = vscale(r.vel, fx(dartCatch ? AB.dartCatchSpeedKeep : T.catch.catchSpeedKeep)); // securing the catch costs speed
      completion = { rec: r, at: r.pos.y };
      log.push(`caught by ${r.c.name}`);
      return;
    }
    if (def && vdist(def.pos, L) <= contest) {
      // a defender in the contest window can jump the throw; the closer he is, the likelier
      const closeness = 1 - dd / contest;
      const deepMult = (L.y - los) / ONE > T.catch.deepCatchFrom ? T.catch.deepIntMult : 1;
      let pInt = (T.catch.intBase + T.catch.intPer * (R(def, "catching") - 50) + (inReach ? 0 : 60)) * (0.35 + 0.65 * closeness) * deepMult + (swat ? T.userDefense.swatIntBonus : 0);
      pInt *= 1 + def.ab.mag("ball_hawk") / 100;
      const ps = def.ab.once("pick_six"); if (ps) { pInt = Math.max(pInt, AB.pickSixIntBase + ps * AB.pickSixIntPer); pickSixer = def; pop(def, "PICK SIX?"); }
      const zd = def.task === "zone" && def.zone && !def.zone.deep && F.abs(L.x - bx) < fx(AB.zoneDropRangeYds) ? def.ab.once("zone_drop") : 0;
      if (zd) pInt = Math.max(pInt, zd * AB.zoneDropIntPer);
      if (def.ab.signature === "DB" && def.zone && vdist(def.zone.at, L) < def.zone.r) pInt = Math.max(pInt, AB.dbSignatureInt);
      if (noTip) pInt = 0;
      if (rng.int(1000) < pInt) {
        ball.state = "held"; ball.holder = def.i;
        turnover = "interception";
        stats.push({ ...att, comp: 0, yds: 0 }, { k: "int", id: def.c.id, team: defSide });
        throwInfo = null;
        log.push(`INTERCEPTED by ${def.c.name}`);
        return;
      }
      stats.push({ k: "defended", id: def.c.id, team: defSide });
    }
    closeIncomplete = Boolean(def && dd < fx(1.0) && inReach);
    stats.push({ ...att, comp: 0, yds: 0 });
    throwInfo = null;
    ended = { reason: "incomplete", y: los, x: bx, incomplete: true };
    log.push("incomplete");
  }

  // at the snap: global nearest-pair matching (closest blocker/defender pairs first), so tackles take
  // ends, guards take tackles and the centre climbs to a linebacker instead of everyone doubling the DL
  {
    const blockers = O.filter((b) => b.isBlocker && b.task !== "pull" && b.task !== "lead");
    const back = (d: Actor) => d.cls === "CB" || d.cls === "S" || d.cls === "NB";
    const eligible = (b: Actor, d: Actor) => {
      if (d === optionKey) return false;
      const depth = d.pos.y - los;
      if (b.stalk) return back(d) && depth > fx(2) && F.abs(d.pos.x - b.pos.x) < fx(9);
      if (passSet && d.task !== "rush") return false;
      return F.abs(d.pos.x - b.pos.x) < fx(passSet ? 9 : 8) && depth < fx(9);
    };
    const pairs: { b: Actor; d: Actor; dist: Fx }[] = [];
    for (const b of blockers) for (const d of D) if (eligible(b, d)) {
      const level = d.pos.y - los > fx(3) ? fx(1.5) : 0;
      // slide protection: linemen look toward the slide side first
      const sd = inp.preOff?.slide === "L" ? -1 : inp.preOff?.slide === "R" ? 1 : 0;
      const slide = sd && passSet && OL_ROLES.includes(b.role) && (d.pos.x - b.pos.x) * sd < 0 ? fx(P5.slideBias) : 0;
      pairs.push({ b, d, dist: vdist(b.pos, d.pos) + level + slide });
    }
    pairs.sort((p, q) => p.dist - q.dist || p.b.i - q.b.i || p.d.i - q.d.i);
    const usedB = new Set<number>();
    for (const pr of pairs) {
      if (usedB.has(pr.b.i) || claimed.has(pr.d.i)) continue;
      usedB.add(pr.b.i); claimed.set(pr.d.i, pr.b.i); pr.b.blockTarget = pr.d.i;
      if (inp.record) log.push(`block: ${pr.b.role} -> ${pr.d.role}`);
    }
    // leftover blockers help on the nearest claimed rusher (double team)
    for (const b of blockers) if (!usedB.has(b.i) && !b.stalk) claimTarget(b);
    // zone runs: a lineman assigned to a linebacker first combos the down lineman next to him
    if (!passSet && scheme === "zone") {
      for (const b of blockers) {
        if (!OL_ROLES.includes(b.role) || b.blockTarget < 0) continue;
        const t = actors[b.blockTarget]!;
        if (t.pos.y - los <= fx(3)) continue;
        let help: Actor | null = null, hd = fx(3.2);
        for (const d of D) {
          if (d.pos.y - los > fx(2.5) || !claimed.has(d.i) || claimed.get(d.i) === b.i) continue;
          const dx = F.abs(d.pos.x - b.pos.x);
          if (dx < hd) { hd = dx; help = d; }
        }
        if (help) { b.comboOn = help.i; b.comboUntil = sec(S.comboSeconds); }
      }
    }
  }

  // ------------------------------------------------------------------ human input
  let userMove: V2 | null = null;
  let userThrow = false;
  let curTick = 0;
  const moveUntil = { juke: -1, spin: -1, burst: -1 };
  const moveReady = { juke: 0, spin: 0, burst: 0 };
  // defensive control mode
  let udef = -1, udefMove: V2 | null = null, stripUntil = -1, swatUntil = -1, defReady = 0, manualAt = -999;
  let lastBallKey = "";
  if (inp.userDefense) udef = nearestDefender({ x: bx, y: los + fx(5) }, -1, true);
  function nearestDefender(p: V2, except: number, offLine = false): number {
    let best = -1, bd = fx(1e4);
    for (const d of D) {
      if (d.i === except || (offLine && (d.cls === "DL" || d.cls === "EDGE"))) continue;
      const dd = vdist(d.pos, p);
      if (dd < bd) { bd = dd; best = d.i; }
    }
    return best;
  }
  const ballSpot = (): V2 => ball.state === "air" ? ball.to : (carrier()?.pos ?? qb.pos);
  function applyDefense(u: UserInput | null | undefined, now: number) {
    if (udef < 0) return;
    const key = `${ball.state}:${ball.holder}`;
    if (key !== lastBallKey) {
      // the ball changed hands (throw, catch, handoff): switch to the man nearest it unless the player just switched
      if (lastBallKey && now - manualAt > sec(T.userDefense.manualHold)) udef = nearestDefender(ballSpot(), -1);
      lastBallKey = key;
    }
    udefMove = u?.move ?? null;
    const act = u?.action;
    if (!act) return;
    if (act === "switch") { udef = nearestDefender(ballSpot(), udef); manualAt = now; return; }
    if (now < defReady) return;
    const d = actors[udef]!;
    if (d.stunTil > now || d.engagedWith >= 0) return;
    defReady = now + sec(T.userDefense.actionCooldown);
    if (act === "swat") { swatUntil = now + sec(T.userDefense.swatSeconds); log.push(`${d.c.name} goes up for it`); return; }
    if (act === "strip") { stripUntil = now + sec(T.userDefense.stripSeconds); return; }
    if (act === "dive") {
      const c = carrier();
      if (c && c.side === "O" && vdist(c.pos, d.pos) <= fx(T.userDefense.diveRange)) {
        log.push(`${d.c.name} dives`);
        attempt(d, c, now, 0, T.userDefense.diveBonus);
      } else {
        d.stunTil = now + sec(T.userDefense.diveWhiffStun);
      }
    }
  }
  function applyUser(u: UserInput | null | undefined, now: number, du?: UserInput | null) {
    if (!inp.userOffense) { applyDefense(du !== undefined ? du : u, now); userMove = null; return; }
    if (inp.userDefense) applyDefense(du, now);
    if (!u) { userMove = null; return; }
    userMove = u.move ?? null;
    if (u.throwAt && qbHasBall) userThrowAt(u.throwAt, now);
    const c = carrier();
    if (u.action === "keep" && isOption && handoffAt >= 0) { keepPressed = true; return; }
    if (u.action === "scramble" && qbHasBall && !isRpo) { startScramble(now); return; }
    if ((u.action === "juke" || u.action === "spin" || u.action === "burst") && c && c.side === "O" && !(c === qb && qbHasBall) && now >= moveReady[u.action]) {
      const k = u.action;
      moveUntil[k] = now + sec(k === "burst" ? T.user.burstSeconds : T.user.moveSeconds);
      moveReady[k] = now + sec(k === "burst" ? T.user.burstCooldown : T.user.moveCooldown);
      if (k !== "burst" && userMove) {
        // the cut itself: a quick sidestep across the run direction
        const side = vnorm({ x: -userMove.y, y: userMove.x });
        c.vel = vadd(c.vel, vscale(side, fx(T.user.cutSideSpeed * (now % 2 === 0 ? 1 : -1))));
      }
      log.push(`${c.c.name} ${k === "juke" ? "jukes" : k === "spin" ? "spins" : "bursts"}`);
    }
  }
  /** A human throw: ball flies to the chosen spot; QB accuracy still moves it. */
  function userThrowAt(t: { x: Fx; y: Fx; power: number }, now: number) {
    const raw = rushers().some((d) => d.engagedWith < 0 && vdist(d.pos, qb.pos) < fx(T.qb.pressureRange));
    let aim: V2 = { x: t.x, y: t.y };
    const yds = vdist(qb.pos, aim) / ONE;
    let tgt0: Actor | null = null, bd0 = fx(1e4);
    for (const o of O) if (o.task === "route") { const dd = vdist(o.pos, aim); if (dd < bd0) { bd0 = dd; tgt0 = o; } }
    const err = throwErr(yds, raw, tgt0);
    aim = vadd(aim, F.vfromAngle(fx(((rng.int(360) - 180) * Math.PI) / 180), mul(fx(err), fx(rng.int(1000) / 1000))));
    const power = Math.max(0, Math.min(1, t.power));
    const speed = fx(ballSpeed() * (T.user.lobSpeedMult + (1 - T.user.lobSpeedMult) * power));
    const ticks = Math.max(3, Math.round(mul(div(vdist(qb.pos, aim), speed), fromIntHz(hz)) / ONE));
    let target = O.find((o) => o.task === "route") ?? qb, bd = fx(1e4);
    for (const o of O) if (o.task === "route") { const dd = vdist(o.pos, aim); if (dd < bd) { bd = dd; target = o; } }
    Object.assign(ball, { state: "air", from: qb.pos, to: aim, t0: now, t1: now + ticks, target: target.i, thrower: qb.i });
    ballApex = fx(T.user.lobApex * (1 - power) + T.user.bulletApex * power);
    qbHasBall = false; pressureAtThrow = raw; userThrow = true;
    throwInfo = { qb, target, airYds: aim.y - los };
    log.push(`${qb.c.name} throws (${Math.round((aim.y - los) / ONE)} air yds${raw ? ", under pressure" : ""})`);
  }
  let ballApex = fx(2.5);
  let afterburnerAt = -1;

  /** The mesh resolves: hand off, keep (read option) or throw (RPO). */
  function handoff(now: number) {
    handoffAt = -1; handedOff = true;
    const misread = () => rng.int(1000) < Math.round(1000 * (S.readMisreadBase + S.readMisreadPerMissing * (99 - R(qb, "awareness"))));
    if (isOption) {
      let keep = keyCrashes;
      if (inp.userOffense) keep = keepPressed; else if (misread()) keep = !keep;
      if (keep) {
        kept = true; qb.task = "carry"; runStart = now; laneOwner = -1;
        // a key who crashed on the back is out of position for a moment
        if (optionKey && keyCrashes) optionKey.stunTil = now + sec(S.keyCommit);
        if (runner && runner !== qb) { runner.task = "block"; runner.isBlocker = true; }
        log.push(`${qb.c.name} keeps it`);
        return;
      }
    }
    if (isRpo && qbHasBall) {
      if (!inp.userOffense && rpoRead && rpoConflict) {
        let bit = rpoConflict.pos.y - los < fx(S.rpoConflictDepth) || rpoConflict.vel.y < -fx(1);
        if (misread()) bit = !bit;
        if (bit && rpoRead.task === "route") { throwTo(rpoRead, now, false); return; }
      }
      qbHasBall = false;
    }
    if (!runner) return;
    if (isDraw) {
      runRecognizedAt = now + sec(S.drawRecognize);
      // rushers feel the draw and fight off their pass sets
      if (runner !== qb) for (const d of D) if (d.engagedWith >= 0) d.shedTick = Math.min(d.shedTick, now + sec(S.drawShedBase + S.drawShedPerMissing * (99 - R(d, "playRecognition"))));
      for (const b of O) if (b.engagedWith >= 0) b.shedTick = actors[b.engagedWith]!.shedTick;
    }
    runStart = now;
    if (runner === qb) { qb.task = "carry"; laneOwner = -1; return; }
    ball.holder = runner.i; runner.task = "carry"; laneOwner = -1;
    if (isDraw || isOption) log.push(`handoff to ${runner.c.name}`);
  }

  /** Before the snap: only the motion man moves (and a man defender who follows him). */
  function presnapStep(input: UserInput | null | undefined) {
    preTick++;
    const mv = mover!;
    const wp = motionPath[motionIdx];
    if (wp && vdist(mv.pos, wp) < fx(0.9)) motionIdx++;
    const goal = motionPath[motionIdx] ?? mv.pos;
    steer(mv, goal, fx(motionKind === "jet" ? P5.jetMult : P5.jogMult));
    for (const d of D) {
      if (d.task === "man" && d.manTarget === mv.i) steer(d, { x: mv.pos.x + (mv.pos.x > bx ? -fx(0.6) : fx(0.6)), y: d.pos.y }, fx(P5.followMult));
      else d.vel = { x: 0, y: 0 };
    }
    for (const a of actors) integrate(a);
    let go = Boolean(input?.snap);
    if (!inp.userOffense) {
      // the AI snaps a jet as the man reaches the ball, other motions when they are set
      if (motionKind === "jet") go ||= preTick > 3 && F.abs(mv.pos.x - bx) < fx(P5.jetSnapDistance);
      else go ||= motionIdx >= motionPath.length && vlen(mv.vel) < fx(1);
    }
    if (preTick >= sec(P5.motionMaxSeconds) && !inp.userOffense) go = true;
    if (go) doSnap();
  }
  function doSnap() {
    snapped = true;
    const mv = mover!;
    const rid = routeIds.get(mv.i);
    if (rid && mv.task === "route") { mv.routeIdx = 0; setRoute(mv, rid); }
    if (jetRunner && vlen(mv.vel) > mul(mv.maxSpeed, fx(0.6))) jetBoostUntil = sec(P5.jetBoostSeconds);
    log.push(`${mv.c.name} in ${motionKind} motion`);
  }

  // ------------------------------------------------------------------ main loop (one tick per step)
  const maxTicks = sec(T.field.maxPlaySeconds);
  let tick = 0;
  let done = false;
  function step(input?: UserInput | null, defInput?: UserInput | null): boolean {
    if (done) return true;
    if (!snapped) { presnapStep(input); return false; }
    if (tick >= maxTicks || ended) { done = true; return true; }
    curTick = tick;
    applyUser(input, tick, defInput);
    if (ended) { done = true; return true; }
    if (handoffAt >= 0 && tick >= handoffAt) handoff(tick);
    if (inp.play.screen && !screenOn && tick >= sec(S.screenRelease)) {
      // screen: the line lets its rushers go and releases to block in front of the catch
      screenOn = true;
      claimed.clear();
      for (const b of O) if (OL_ROLES.includes(b.role)) { disengage(b); b.stalk = true; b.blockTarget = -1; }
    }
    for (const a of actors) {
      let goal: V2;
      let mult: Fx = ONE;
      if (a.side === "O") goal = offenseGoal(a, tick);
      else {
        const c = carrier();
        goal = c === a ? carrierGoal(a, tick) : defenderGoal(a, tick);
        if (a.i === udef && udefMove && (udefMove.x !== 0 || udefMove.y !== 0) && c !== a) goal = vadd(a.pos, vscale(vnorm(udefMove), fx(5)));
        if (d_backpedal(a) && a.i !== udef) mult = fx(T.movement.backpedalMult);
      }
      steer(a, goal, mult);
    }
    for (const a of actors) integrate(a);
    curTickRef.t = tick;
    { const c0 = ball.state === "held" ? actors[ball.holder]! : null; if (c0 && !(c0 === qb && qbHasBall) && carryHolder !== c0.i) { carryStart = tick; carryHolder = c0.i; } }
    engage(tick);
    if (qbHasBall && !inp.userOffense && !isRpo) tryThrow(tick);
    if (ball.state === "air" && tick >= ball.t1) resolveCatch(tick);
    if (ended) { done = true; return true; }
    const c = carrier();
    if (c) {
      if (c.pos.x < 0 || c.pos.x > W) { ended = { reason: "oob", y: c.pos.y, x: c.pos.x, oob: true }; done = true; return true; }
      if (c.side === "O" && c.pos.y >= fx(100)) { ended = { reason: "td", y: c.pos.y, x: c.pos.x, td: "O" }; done = true; return true; }
      if (c.side === "D" && c.pos.y <= 0) { ended = { reason: "td", y: c.pos.y, x: c.pos.x, td: "D" }; done = true; return true; }
      tackles(tick);
    }
    if (inp.record) {
      const p: number[] = [];
      for (const a of actors) p.push(a.pos.x, a.pos.y);
      const bp = ball.state === "air" ? F.lerp(ball.from.x, ball.to.x, div(fromIntHz(tick - ball.t0), fromIntHz(Math.max(1, ball.t1 - ball.t0)))) : (carrier()?.pos.x ?? 0);
      const by = ball.state === "air" ? F.lerp(ball.from.y, ball.to.y, div(fromIntHz(tick - ball.t0), fromIntHz(Math.max(1, ball.t1 - ball.t0)))) : (carrier()?.pos.y ?? 0);
      frames.push({ t: tick, p, ball: [bp, by, ball.state === "air" ? 1 : 0] });
    }
    tick++;
    if (tick >= maxTicks || ended) done = true;
    return done;
  }

  function snapshot(): PlaySnapshot {
    let bx2: Fx, by2: Fx, h: Fx = 0;
    if (ball.state === "air") {
      const u = div(fromIntHz(Math.min(tick, ball.t1) - ball.t0), fromIntHz(Math.max(1, ball.t1 - ball.t0)));
      bx2 = F.lerp(ball.from.x, ball.to.x, u); by2 = F.lerp(ball.from.y, ball.to.y, u);
      h = mul(mul(ballApex, fx(4)), mul(u, ONE - u));
    } else {
      const c = actors[ball.holder]!;
      bx2 = c.pos.x; by2 = c.pos.y; h = fx(1);
    }
    const c = carrier();
    const endedNow = ended as End | null;
    const downId = endedNow && (endedNow.reason === "tackle" || endedNow.reason === "sack") && c ? c.i : -1;
    return {
      tick, done, los,
      actors: actors.map((a) => ({ x: a.pos.x, y: a.pos.y, vx: a.vel.x, vy: a.vel.y, side: a.side, role: a.role, num: a.c.num, id: a.c.id, down: a.i === downId })),
      ball: { x: bx2, y: by2, h, state: ball.state, holder: ball.holder },
      qbCanThrow: qbHasBall,
      carrier: c ? c.i : -1,
      userCarrier: Boolean(inp.userOffense && c && c.side === "O" && !(c === qb && qbHasBall) && handoffAt < 0),
      userDefender: udef,
      canKeep: isOption && handoffAt >= 0 && Boolean(inp.userOffense),
      presnap: !snapped,
      routes: tick === 0 ? O.filter((o) => o.task === "route" && o.route.length).map((o) => ({ i: o.i, pts: o.route })) : [],
      assign: tick === 0 ? D.map((d) => ({ i: d.i, task: d.task === "man" ? "man" : d.task, at: d.zone?.at, r: d.zone?.r, target: d.task === "man" ? d.manTarget : undefined })) : [],
      cooldowns: { juke: Math.max(0, moveReady.juke - tick), spin: Math.max(0, moveReady.spin - tick), burst: Math.max(0, moveReady.burst - tick) },
      log, fx: fxLog,
    };
  }

  /** Backpedalling (slower) only while the receiver is still well in front; then he turns and runs. */
  function d_backpedal(a: Actor) {
    if (a.side !== "D" || completion || ball.state === "air" || a.vel.y <= 0) return false;
    if (a.task === "zone") return !a.zone?.deep;
    if (a.task === "man") return actors[a.manTarget]!.pos.y < a.pos.y - fx(3);
    return false;
  }

  // ------------------------------------------------------------------ outcome
  let cached: PlayResult | null = null;
  function result(): PlayResult {
  if (cached) return cached;
  if (!done) throw new Error("play still running");
  const fin: End = (ended as End | null) ?? (() => { const c = carrier(); return { reason: "time", y: c ? c.pos.y : los, x: c ? c.pos.x : bx }; })();
  turnover = turnover as Turnover;
  const c = carrier();
  const endY = fin.incomplete ? los : fin.y;
  // offense-frame end spot; if the defense carried it, turnover is already set
  if (c && c.side === "D" && !turnover && !fumbleBackToOffense) turnover = "interception";
  const gained = (endY - los) / ONE;
  // stats for the offense
  if (!fin.incomplete && !turnover) {
    if (completion && throwInfo) {
      stats.push({ k: "pass", id: qb.c.id, team: inp.offSide, att: 1, comp: 1, yds: Math.round(gained), td: endY >= fx(100) ? 1 : 0 });
      stats.push({ k: "rec", id: completion.rec.c.id, team: inp.offSide, yds: Math.round(gained), td: endY >= fx(100) ? 1 : 0 });
    } else if (fin.sack) {
      stats.push({ k: "pass", id: qb.c.id, team: inp.offSide, att: 0, yds: 0 });
    } else if (c && c.side === "O") {
      stats.push({ k: "rush", id: c.c.id, team: inp.offSide, att: 1, yds: Math.round(gained), td: endY >= fx(100) ? 1 : 0 });
    }
  } else if (turnover === "fumble" && completion && throwInfo) {
    stats.push({ k: "pass", id: qb.c.id, team: inp.offSide, att: 1, comp: 1, yds: Math.round((completion.at - los) / ONE) });
  }

  // penalties (pre-snap fouls are rolled by the caller; live fouls here)
  let foul: Foul | null = null;
  const P = T.penalties;
  const olSkill = O.filter((a) => a.isBlocker).reduce((s, a) => s + (isPass ? R(a, "passBlock") : R(a, "runBlock")), 0) / Math.max(1, O.filter((a) => a.isBlocker).length);
  if (rng.int(1000) < P.holdingOffense.perMille + (P.holdingOffense.skillPer ?? 0) * (75 - olSkill)) {
    foul = { name: "Holding", on: "O", yards: P.holdingOffense.yards ?? 10, kind: "live" };
  } else if (isPass && closeIncomplete && rng.int(1000) < P.passInterference.onCloseIncompletePerMille) {
    foul = { name: "Pass interference", on: "D", yards: 0, kind: "live", spotY: F.clamp(ball.to.y, los + ONE, fx(99)), autoFirst: true };
  } else if (isPass && rng.int(1000) < P.holdingDefense.perMille) {
    foul = { name: "Defensive holding", on: "D", yards: P.holdingDefense.yards ?? 5, kind: "live", autoFirst: true };
  } else if (isPass && (pressureAtThrow || fin.sack) && rng.int(1000) < P.roughing.perMille * 4) {
    foul = { name: "Roughing the passer", on: "D", yards: P.roughing.yards ?? 15, kind: "live", autoFirst: true, addedToEnd: true };
  }
  if (hcOffside && (!foul || foul.on === "O")) foul = { name: "Offside (hard count)", on: "D", yards: 5, kind: "live" };
  if (inp.twoPoint) foul = null;

  const outcome: PlayOutcome = {
    play: inp.twoPoint ? "twoPoint" : "scrimmage",
    endY,
    incomplete: Boolean(fin.incomplete),
    outOfBounds: Boolean(fin.oob),
    turnover,
    good: inp.twoPoint ? (!fin.incomplete && !turnover && endY >= fx(100)) : undefined,
    elapsedTicks: tick,
    foul,
  };
  const res: PlayResult = { outcome, stats, endX: F.clamp(fin.x, fx(1), W - fx(1)), log, debug: dbg, activesUsed };
  if (inp.record) res.frames = frames;
  cached = res;
  return res;
  }
  return { step, snapshot, result, assignments: () => assignmentsAtSnap };
}


const fromIntHz = (n: number) => n * ONE;
