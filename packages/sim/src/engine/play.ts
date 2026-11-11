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
import type { Roster } from "../roster.js";

const { fx, mul, div, idiv, ONE, vsub, vadd, vlen, vnorm, vscale, vdist } = F;

export type Stats = Record<string, number>;
export interface StatEvent {
  k: "pass" | "rush" | "rec" | "tackle" | "sack" | "int" | "fumble" | "fumbleLost" | "defended";
  id: number; team: 0 | 1;
  yds?: number; att?: number; comp?: number; td?: number; target?: number;
}

export interface PlayInput {
  data: GameData;
  ratings: (id: number) => Stats;
  offense: Roster; defense: Roster;
  offSide: 0 | 1;
  ballOn: Fx; ballX: Fx;
  toGo: Fx;
  play: OffensePlay; call: DefenseCall;
  flip: boolean;
  rng: Rng;
  twoPoint?: boolean;
  record?: boolean;
  /** a human controls the offense: the QB waits for throwAt, the carrier follows move */
  userOffense?: boolean;
}
export interface Frame { t: number; p: number[]; ball: [number, number, number] } // positions as [x,y,...] in Fx

/** Per-tick input from a human controlling the offense (all optional). Coordinates are field Fx. */
export interface UserInput {
  /** desired run direction for the ball carrier (any length; zero/undefined = AI steering) */
  move?: V2 | null;
  /** throw now at this field point; power 0..1 (0 = soft lob, 1 = bullet) */
  throwAt?: { x: Fx; y: Fx; power: number } | null;
  action?: "juke" | "spin" | "burst" | "scramble" | null;
}
export interface ActorView { x: Fx; y: Fx; vx: Fx; vy: Fx; side: "O" | "D"; role: string; num: number | null; id: number; down: boolean }
export interface PlaySnapshot {
  tick: number; done: boolean; los: Fx;
  actors: ActorView[];
  ball: { x: Fx; y: Fx; h: Fx; state: "held" | "air" | "dead" | "loose"; holder: number };
  qbCanThrow: boolean; carrier: number; userCarrier: boolean;
  cooldowns: { juke: number; spin: number; burst: number };
  log: string[];
}
export interface PlaySim {
  step(input?: UserInput | null): boolean;
  snapshot(): PlaySnapshot;
  result(): PlayResult;
}
export interface PlayResult { outcome: PlayOutcome; stats: StatEvent[]; endX: Fx; frames?: Frame[]; log: string[]; debug?: { tries: number; missed: number; minDist: number } }

type Task = "block" | "route" | "qb" | "carry" | "rush" | "man" | "zone" | "pursue" | "idle";
interface Actor {
  i: number; c: PlayerCard; st: Stats; side: "O" | "D"; role: string;
  pos: V2; vel: V2; maxSpeed: Fx; accel: Fx;
  task: Task;
  // blocking
  blockTarget: number; engagedWith: number; shedTick: number; stunTil: number;
  // routes
  route: V2[]; routeIdx: number; settle: boolean; isBlocker: boolean;
  // coverage
  manTarget: number; zone: { at: V2; r: Fx; deep: boolean } | null; reactTicks: number;
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
  const defSide = (inp.offSide === 0 ? 1 : 0) as 0 | 1;

  const off = data.formations.offense.find((f) => inp.play.formations.includes(f.id))!;
  const dfm = data.formations.defense.find((f) => f.id === inp.call.formation)!;
  const flipX = inp.flip ? -1 : 1;
  const los = inp.ballOn;
  const bx = inp.ballX;

  // ------------------------------------------------------------------ actors
  const actors: Actor[] = [];
  const mk = (c: PlayerCard, side: "O" | "D", role: string, at: V2): Actor => {
    const st = inp.ratings(c.id);
    const g = (k: string) => st[k] ?? 50;
    return {
      i: actors.length, c, st, side, role, pos: at, vel: { x: 0, y: 0 },
      maxSpeed: fx(T.movement.speedBase + T.movement.speedPer * g("speed")),
      accel: fx(T.movement.accelBase + T.movement.accelPer * g("acceleration")),
      task: "idle", blockTarget: -1, engagedWith: -1, shedTick: 0, stunTil: 0,
      route: [], routeIdx: 0, settle: false, isBlocker: false,
      manTarget: -1, zone: null, reactTicks: 0, lastTackleTry: -999, history: [], brake: false,
    };
  };
  const place = (dx: number, dy: number, mirror: number): V2 => ({
    x: F.clamp(bx + fx(dx * mirror), fx(1), W - fx(1)), y: los + fx(dy),
  });
  const roleIdx = new Map<string, number>();
  for (const [role, slot] of Object.entries(data.formations.roles.offense)) {
    const [dx, dy] = off.spots[role]!;
    const a = mk(inp.offense.starters[slot]!, "O", role, place(dx, dy, flipX));
    roleIdx.set("O:" + role, a.i);
    actors.push(a);
  }
  for (const [role, slot] of Object.entries(data.formations.roles.defense)) {
    const [dx, dy] = dfm.spots[role]!;
    let at = place(dx, dy, 1);
    const alignOn = dfm.alignOn?.[role];
    if (alignOn) at = { x: actors[roleIdx.get("O:" + alignOn)!]!.pos.x, y: los + fx(dy) };
    const a = mk(inp.defense.starters[slot]!, "D", role, at);
    roleIdx.set("D:" + role, a.i);
    actors.push(a);
  }
  const O = actors.filter((a) => a.side === "O");
  const D = actors.filter((a) => a.side === "D");
  const byRole = (side: "O" | "D", role: string) => actors[roleIdx.get(side + ":" + role)!]!;
  const R = (a: Actor, k: string) => a.st[k] ?? 50;
  const qb = byRole("O", "QB");

  // ------------------------------------------------------------------ assignments
  const isPass = inp.play.kind === "pass";
  const OL_ROLES = ["LT", "LG", "C", "RG", "RT"];
  for (const a of O) {
    if (OL_ROLES.includes(a.role)) { a.task = "block"; a.isBlocker = true; continue; }
    if (a.role === "QB") { a.task = "qb"; continue; }
    if (isPass) {
      const routeId = inp.play.routes?.[a.role] ?? "block";
      const rdef = data.routes.routes[routeId]!;
      if (rdef.block) { a.task = "block"; a.isBlocker = true; continue; }
      const sx = a.pos.x >= bx ? 1 : -1;
      a.route = rdef.points.map(([o, d]) => ({ x: F.clamp(a.pos.x + fx(o * sx), fx(0.5), W - fx(0.5)), y: a.pos.y + fx(d) }));
      a.settle = Boolean(rdef.settle);
      a.task = "route";
    } else {
      a.task = a.role === inp.play.carrier ? "carry" : "block";
      if (a.task === "block") a.isBlocker = true;
    }
  }
  for (const d of D) {
    const asg = inp.call.roles[d.role]!;
    d.reactTicks = sec(T.coverage.reactBase + T.coverage.reactPerMissing * (99 - R(d, "playRecognition")));
    if (asg === "rush" || asg === "spy") d.task = "rush";
    else if ("man" in asg) {
      d.task = "man"; d.manTarget = byRole("O", asg.man).i;
      // mirroring a receiver is a man-coverage skill, not general play recognition
      d.reactTicks = sec(T.coverage.manReactBase + T.coverage.manReactPerMissing * (99 - R(d, "manCoverage")));
    }
    else {
      const z = data.defense.zones[asg.zone]!;
      d.task = "zone";
      d.zone = { at: { x: F.clamp(bx + fx(z.at[0]), fx(2), W - fx(2)), y: los + fx(z.at[1]) }, r: fx(z.r), deep: Boolean(z.deep) };
    }
  }
  const rushers = () => D.filter((d) => d.task === "rush");

  /** Claim one defender per blocker (no two blockers on the same man until everyone is covered). */
  const claimed = new Map<number, number>(); // defender -> blocker
  function claimTarget(b: Actor): Actor | null {
    const box = (d: Actor) => F.abs(d.pos.x - b.pos.x) < fx(isPass ? 9 : 7) && d.pos.y - los < fx(isPass ? 6 : 8);
    const cands = D.filter((d) => (isPass ? d.task === "rush" : true) && box(d) && d.stunTil <= 0);
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
  const carrierStart = isPass ? qb : actors[roleIdx.get("O:" + inp.play.carrier)!]!;
  const ball: Ball = { state: "held", holder: carrierStart.i, from: carrierStart.pos, to: carrierStart.pos, t0: 0, t1: 0, target: -1, thrower: -1 };
  let qbHasBall = isPass;              // QB still deciding (sack possible, throw possible)
  let runRecognizedAt = isPass ? 1 << 30 : 0;
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
  const dropDepth = fx(Math.max(0, (inp.play.drop ?? 0) - (los - qb.pos.y > fx(3) ? 4 : 0)));
  const dropPoint = { x: qb.pos.x, y: qb.pos.y - dropDepth };
  const readStart = sec((inp.play.drop ?? 3) / T.qb.dropSpeed + T.qb.readStartAfterDrop);
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
    if (a.engagedWith >= 0) {
      const d = actors[a.engagedWith]!;
      // stay between the defender and the ball
      const protect = carrier()?.pos ?? qb.pos;
      return vadd(d.pos, vscale(vnorm(vsub(protect, d.pos)), fx(0.9)));
    }
    if (a.stunTil > now) return a.pos;
    let tgt = a.blockTarget >= 0 ? actors[a.blockTarget]! : null;
    if (!tgt) tgt = claimTarget(a);
    if (!tgt) return isPass ? { x: a.pos.x, y: F.max(qb.pos.y + fx(1.5), a.pos.y - fx(0.5)) } : { x: a.pos.x, y: a.pos.y + fx(2) };
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
  const flightTo = (p: V2) => div(vdist(qb.pos, p), fx(T.throw.ballSpeedBase + T.throw.ballSpeedPer * R(qb, "throwPower")));

  function tryThrow(now: number) {
    const t = now / hz;
    const reads = (inp.play.read ?? []).map((role) => byRole("O", role));
    // pressure only registers after the QB has had time to feel it (awareness); until then a free
    // rusher can get home for a sack
    const raw = rushers().some((d) => d.engagedWith < 0 && vdist(d.pos, qb.pos) < fx(T.qb.pressureRange));
    if (!raw) pressureSince = -1; else if (pressureSince < 0) pressureSince = now;
    const pressure = raw && now - pressureSince >= sec(T.qb.pressureReactBase + T.qb.pressureReactPerMissing * (99 - R(qb, "awareness")));
    if (now < readStart && !pressure) return;
    const span = Math.max(0.1, T.qb.maxHold - readStart / hz);
    const k = Math.min(1, Math.max(0, (t - readStart / hz) / span));
    // a high-awareness QB anticipates and throws into tighter windows
    const need = (T.qb.openSepStart + (T.qb.openSepEnd - T.qb.openSepStart) * k) * Math.max(0.6, 1 - T.qb.windowPerAwareness * (R(qb, "awareness") - 75));
    // the QB has progressed this far through his reads; earlier reads stay available
    const progressed = Math.min(reads.length - 1, Math.max(0, Math.floor((now - readStart) / sec(T.qb.readWindow))));
    let pick: Actor | null = null, best: Actor | null = null, bestSep = fx(-99);
    for (let j = 0; j < reads.length; j++) {
      const r = reads[j]!;
      const sep = separation(r, flightTo(r.pos));
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
    const accKey = yds <= T.throw.shortMax ? "throwAccuracyShort" : yds <= T.throw.midMax ? "throwAccuracyMid" : "throwAccuracyDeep";
    let acc = R(qb, accKey);
    if (pressure) acc = Math.round((acc + R(qb, "throwUnderPressure")) / 2);
    let err = T.throw.errBase + T.throw.errPerMissingAcc * (99 - acc) * (1 + yds * T.throw.errPerYard);
    if (pressure) err *= T.throw.pressureErrMult;
    if (scramble) err *= (2 - R(qb, "throwOnTheRun") / 99) * (T.throw.onRunErrMult / 1.35);
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
    if (a.side === "O" && !isPass && now < sec(T.carrier.followAimFor) && inp.play.aim) {
      const [ax, ay] = inp.play.aim;
      return { x: bx + fx(ax * flipX), y: los + fx(ay) };
    }
    const look = fx(T.carrier.lookAhead), perpW = fx(T.carrier.lanePerp);
    const noise = T.carrier.visionNoisePerMissing * (99 - R(a, "bCVision"));
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
    const c = carrier();
    // ball in the air: break on it after a reaction delay
    if (ball.state === "air" && ball.target >= 0) {
      const react = sec(T.coverage.ballReactBase + T.coverage.ballReactPerMissing * (99 - R(d, "awareness")));
      if (now - ball.t0 >= react) { lastBranch = "ball"; return ball.to; }
    }
    const pursuing = c && (c.side === "D" ? true : c !== qb || scramble || !isPass) && (now >= runRecognizedAt || c.side === "D" || completion);
    if (c && c.side === "O" && c.task === "carry" && !isPass) {
      const read = sec(T.coverage.runReadBase + T.coverage.runReadPerMissing * (99 - R(d, "playRecognition")));
      if (now >= read) return intercept(d, c);
    }
    if (pursuing && c && c.side !== d.side) { lastBranch = "pursue"; return intercept(d, c); }
    if (d.task === "rush") return qbHasBall ? qb.pos : c ? intercept(d, c) : qb.pos;
    if (d.task === "man") {
      const r = actors[d.manTarget]!;
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
      if (!threat) { lastBranch = "zone-empty"; return z.at; }
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
    if (c === a && !(a === qb && qbHasBall)) return carrierGoal(a, now);
    if (a.side === "O" && c && c.side === "D") return intercept(a, c);   // turnover: chase
    if (a.task === "block") return blockerGoal(a, now);
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
      for (const d of D) {
        if (d.stunTil > now || vdist(b.pos, d.pos) > fx(T.blocking.engageRange)) continue;
        if (b.blockTarget >= 0 && b.blockTarget !== d.i) continue;
        if (isPass && d.task !== "rush" && !scramble) continue;
        const passing = isPass && !scramble;
        const blk = passing ? (R(b, "passBlock") * 2 + R(b, "passBlockPower") + R(b, "passBlockFinesse")) / 4
          : (R(b, "runBlock") * 2 + R(b, "runBlockPower") + R(b, "impactBlocking")) / 4;
        const rush = passing ? (Math.max(R(d, "powerMoves"), R(d, "finesseMoves")) * 2 + R(d, "blockShedding") + R(d, "strength")) / 4
          : (R(d, "blockShedding") * 2 + R(d, "strength") + R(d, "playRecognition")) / 4;
        const base = passing ? T.blocking.passHoldBase : T.blocking.runHoldBase;
        const per = passing ? T.blocking.passHoldPer : T.blocking.runHoldPer;
        const jit = passing ? T.blocking.passHoldJitter : T.blocking.runHoldJitter;
        let hold = base + per * (blk - rush) + (rng.int(1000) / 1000 - 0.5) * 2 * jit;
        if (d.engagedWith >= 0) {
          // double team: extend the existing block instead
          const first = actors[d.engagedWith]!;
          first.shedTick += Math.round((first.shedTick - now) * (T.blocking.doubleTeamMult - 1));
          d.shedTick = first.shedTick;
          b.engagedWith = d.i; b.shedTick = d.shedTick;
          break;
        }
        hold = Math.max(0.15, hold);
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

  function tackles(now: number) {
    const c = carrier();
    if (!c) return;
    for (const e of opponents(c)) { const dd = vdist(e.pos, c.pos) / ONE; if (dd < dbg.minDist) dbg.minDist = dd; }
    const defenders = opponents(c);
    const near = defenders.filter((d) => d.engagedWith < 0 && d.stunTil <= now && vdist(d.pos, c.pos) < fx(T.tackle.range));
    for (const d of near) {
      if (now - d.lastTackleTry < sec(0.5)) continue;
      d.lastTackleTry = now;
      if (c === qb && qbHasBall) {
        // sack attempt
        const p = clampPm(T.tackle.sackBase - T.tackle.sackPer * (R(c, "breakSack") - 60) + T.tackle.per * (R(d, "tackle") - 70) / 2);
        if (rng.int(1000) < p) {
          stats.push({ k: "sack", id: d.c.id, team: defSide }, { k: "tackle", id: d.c.id, team: defSide });
          log.push(`SACK by ${d.c.name}`);
          ended = { reason: "sack", y: c.pos.y, x: c.pos.x, sack: true };
          return;
        }
        d.stunTil = now + sec(T.tackle.missStun);
        continue;
      }
      const moves = [R(c, "breakTackle"), (R(c, "jukeMove") + R(c, "agility")) / 2, (R(c, "trucking") + R(c, "strength")) / 2,
        R(c, "stiffArm") * 0.92, (R(c, "spinMove") + R(c, "agility")) / 2];
      const best = Math.max(...moves), avg = moves.reduce((x, y) => x + y, 0) / moves.length;
      const elusive = best * T.tackle.elusiveMaxWeight + avg * (1 - T.tackle.elusiveMaxWeight);
      const gang = near.length - 1;
      // a well-timed juke or spin (human-controlled carrier) makes this tackle harder
      let moveBonus = 0;
      if (moveUntil.juke > now) moveBonus = T.user.moveBonusBase + T.user.moveBonusPer * (R(c, "jukeMove") - 60);
      else if (moveUntil.spin > now) moveBonus = T.user.moveBonusBase + T.user.moveBonusPer * (R(c, "spinMove") - 60);
      const p = clampPm(T.tackle.base + T.tackle.per * (R(d, "tackle") - elusive) + T.tackle.powerPer * (R(d, "hitPower") - R(c, "strength")) +
        gang * T.tackle.gangBonus - moveBonus);
      dbg.tries++;
      if (rng.int(1000) < p) {
        stats.push({ k: "tackle", id: d.c.id, team: c.side === "O" ? defSide : inp.offSide });
        // fumble?
        const fp = Math.max(T.tackle.fumbleMin, Math.min(T.tackle.fumbleMax, T.tackle.fumbleBase + T.tackle.fumblePer * (R(d, "hitPower") - R(c, "carrying"))));
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
        return;
      }
      d.stunTil = now + sec(T.tackle.missStun);
      c.vel = vscale(c.vel, fx(1 - T.tackle.carrierSlowOnMiss));
      dbg.missed++;
    }
  }
  const clampPm = (p: number) => Math.round(Math.max(T.tackle.min, Math.min(T.tackle.max, p)));

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
    const inReach = vdist(r.pos, L) <= reach;
    const att = { k: "pass" as const, id: qb.c.id, team: inp.offSide, att: 1 };
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
        const skill = (R(r, "catchInTraffic") + R(r, "spectacularCatch")) / 2;
        const cov = (Math.max(R(def, "manCoverage"), R(def, "zoneCoverage")) + R(def, "playRecognition")) / 2;
        const closeness = 1 - dd / contest;
        pCatch -= (T.catch.contestPenalty - T.catch.contestSkillPer * (skill - cov)) * closeness;
      }
    }
    const roll = rng.int(1000);
    if (roll < Math.max(0, Math.min(980, pCatch))) {
      ball.state = "held"; ball.holder = r.i;
      r.vel = vscale(r.vel, fx(T.catch.catchSpeedKeep)); // securing the catch costs speed
      completion = { rec: r, at: r.pos.y };
      log.push(`caught by ${r.c.name}`);
      return;
    }
    if (def && vdist(def.pos, L) <= contest) {
      // a defender in the contest window can jump the throw; the closer he is, the likelier
      const closeness = 1 - dd / contest;
      const deepMult = (L.y - los) / ONE > T.catch.deepCatchFrom ? T.catch.deepIntMult : 1;
      const pInt = (T.catch.intBase + T.catch.intPer * (R(def, "catching") - 50) + (inReach ? 0 : 60)) * (0.35 + 0.65 * closeness) * deepMult;
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
    const blockers = O.filter((b) => b.isBlocker);
    const isWr = (b: Actor) => ["X", "Z", "SLOT"].includes(b.role);
    const eligible = (b: Actor, d: Actor) => {
      if (isPass && d.task !== "rush") return false;
      const depth = d.pos.y - los;
      if (isWr(b)) return depth > fx(3) && F.abs(d.pos.x - b.pos.x) < fx(7);
      return F.abs(d.pos.x - b.pos.x) < fx(isPass ? 9 : 8) && depth < fx(9);
    };
    const pairs: { b: Actor; d: Actor; dist: Fx }[] = [];
    for (const b of blockers) for (const d of D) if (eligible(b, d)) {
      const level = d.pos.y - los > fx(3) ? fx(1.5) : 0;
      pairs.push({ b, d, dist: vdist(b.pos, d.pos) + level });
    }
    pairs.sort((p, q) => p.dist - q.dist || p.b.i - q.b.i || p.d.i - q.d.i);
    const usedB = new Set<number>();
    for (const pr of pairs) {
      if (usedB.has(pr.b.i) || claimed.has(pr.d.i)) continue;
      usedB.add(pr.b.i); claimed.set(pr.d.i, pr.b.i); pr.b.blockTarget = pr.d.i;
      if (inp.record) log.push(`block: ${pr.b.role} -> ${pr.d.role}`);
    }
    // leftover blockers help on the nearest claimed rusher (double team)
    for (const b of blockers) if (!usedB.has(b.i)) claimTarget(b);
  }

  // ------------------------------------------------------------------ human input
  let userMove: V2 | null = null;
  let userThrow = false;
  let curTick = 0;
  const moveUntil = { juke: -1, spin: -1, burst: -1 };
  const moveReady = { juke: 0, spin: 0, burst: 0 };
  function applyUser(u: UserInput | null | undefined, now: number) {
    if (!inp.userOffense || !u) { userMove = null; return; }
    userMove = u.move ?? null;
    if (u.throwAt && qbHasBall) userThrowAt(u.throwAt, now);
    const c = carrier();
    if (u.action === "scramble" && qbHasBall) { startScramble(now); return; }
    if (u.action && u.action !== "scramble" && c && c.side === "O" && !(c === qb && qbHasBall) && now >= moveReady[u.action]) {
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
    const accKey = yds <= T.throw.shortMax ? "throwAccuracyShort" : yds <= T.throw.midMax ? "throwAccuracyMid" : "throwAccuracyDeep";
    let acc = R(qb, accKey);
    if (raw) acc = Math.round((acc + R(qb, "throwUnderPressure")) / 2);
    let err = T.throw.errBase + T.throw.errPerMissingAcc * (99 - acc) * (1 + yds * T.throw.errPerYard);
    if (raw) err *= T.throw.pressureErrMult;
    if (scramble) err *= (2 - R(qb, "throwOnTheRun") / 99) * (T.throw.onRunErrMult / 1.35);
    aim = vadd(aim, F.vfromAngle(fx(((rng.int(360) - 180) * Math.PI) / 180), mul(fx(err), fx(rng.int(1000) / 1000))));
    const power = Math.max(0, Math.min(1, t.power));
    const speed = fx((T.throw.ballSpeedBase + T.throw.ballSpeedPer * R(qb, "throwPower")) * (T.user.lobSpeedMult + (1 - T.user.lobSpeedMult) * power));
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

  // ------------------------------------------------------------------ main loop (one tick per step)
  const maxTicks = sec(T.field.maxPlaySeconds);
  let tick = 0;
  let done = false;
  function step(input?: UserInput | null): boolean {
    if (done) return true;
    if (tick >= maxTicks || ended) { done = true; return true; }
    curTick = tick;
    applyUser(input, tick);
    for (const a of actors) {
      let goal: V2;
      let mult: Fx = ONE;
      if (a.side === "O") goal = offenseGoal(a, tick);
      else {
        const c = carrier();
        goal = c === a ? carrierGoal(a, tick) : defenderGoal(a, tick);
        if (d_backpedal(a)) mult = fx(T.movement.backpedalMult);
      }
      steer(a, goal, mult);
    }
    for (const a of actors) integrate(a);
    engage(tick);
    if (qbHasBall && !inp.userOffense) tryThrow(tick);
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
      userCarrier: Boolean(inp.userOffense && c && c.side === "O" && !(c === qb && qbHasBall)),
      cooldowns: { juke: Math.max(0, moveReady.juke - tick), spin: Math.max(0, moveReady.spin - tick), burst: Math.max(0, moveReady.burst - tick) },
      log,
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
  const res: PlayResult = { outcome, stats, endX: F.clamp(fin.x, fx(1), W - fx(1)), log, debug: dbg };
  if (inp.record) res.frames = frames;
  cached = res;
  return res;
  }
  return { step, snapshot, result };
}


const fromIntHz = (n: number) => n * ONE;
