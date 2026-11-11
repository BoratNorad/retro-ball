// Rules engine: pure functions that advance the game state from play outcomes.
// Downs/distance, clock (runoff, stoppages, two-minute warning, quarters, halftime), scoring,
// tries, touchbacks, safeties, turnovers, penalty enforcement with accept/decline, college OT.
//
// Spots are Q16.16 yards from the possessing team's own goal line (0..100). A PlayOutcome is
// reported in the frame of the team that snapped/kicked the ball. All state is plain data
// (snapshot-able for replays and rollback); nothing here uses floats or randomness.
import type { RulesConfig } from "@tdf/shared";
import { fromInt, ONE, idiv, max, min, type Fx } from "./fixed.js";

export type Side = 0 | 1;
export const other = (s: Side): Side => (s === 0 ? 1 : 0);
const Y = fromInt;

export type Phase = "kickoff" | "play" | "try" | "final";
export type Tempo = "normal" | "hurry" | "milk";

export interface OtState { period: number; first: Side; possIdx: 0 | 1 }

export interface GameState {
  quarter: number;            // 1..4 regulation, 5+ overtime periods
  clock: number;              // ticks left in the quarter (regulation only)
  possession: Side;           // offense, or the kicking team during a kickoff
  ballOn: Fx;
  down: number;
  toGo: Fx;
  score: [number, number];
  timeouts: [number, number];
  phase: Phase;
  freeKickFrom: Fx;           // kickoff spot (kicking team frame)
  clockRunning: boolean;      // does the clock run until the next snap?
  twoMinWarned: [boolean, boolean]; // per half
  openingReceiver: Side;
  ot: OtState | null;
  tryKind: "pat" | "twoPoint" | null;
  plays: number;
}

export interface Foul {
  name: string;
  on: "O" | "D";
  yards: number;
  kind: "preSnap" | "live";
  spotY?: Fx;            // spot fouls (pass interference): spot in offense frame
  autoFirst?: boolean;
  addedToEnd?: boolean;  // personal fouls enforced from the end of the play
}

export type PlayKind = "scrimmage" | "kneel" | "spike" | "kickoff" | "punt" | "fieldGoal" | "pat" | "twoPoint";

export interface PlayOutcome {
  play: PlayKind;
  /** dead-ball spot in the snapping/kicking team's frame (ignored when incomplete) */
  endY: Fx;
  incomplete?: boolean;
  outOfBounds?: boolean;
  /** possession changed during a scrimmage play */
  turnover?: "interception" | "fumble" | null;
  /** kicks: kicking team recovered (onside kick, muffed punt) */
  kickingTeamRecovered?: boolean;
  kickOutOfBounds?: boolean;
  good?: boolean;        // field goal / try converted
  elapsedTicks: number;
  foul?: Foul | null;
}

export interface GameEvent {
  t: "firstDown" | "touchdown" | "fieldGoal" | "fgMissed" | "safety" | "try" | "tryFailed" | "turnover" | "downs" |
     "touchback" | "punt" | "kickoff" | "penalty" | "declined" | "timeout" | "twoMinuteWarning" | "quarterEnd" |
     "halftime" | "overtime" | "final";
  side?: Side;
  text?: string;
  points?: number;
}

export interface Step { state: GameState; events: GameEvent[] }

// ---------------------------------------------------------------- setup
export function newGame(cfg: RulesConfig, openingReceiver: Side): GameState {
  return {
    quarter: 1,
    clock: cfg.quarterSeconds * cfg.tickHz,
    possession: other(openingReceiver),
    ballOn: Y(cfg.spots.kickoffFrom), down: 1, toGo: Y(cfg.firstDownYards),
    score: [0, 0],
    timeouts: [cfg.timeoutsPerHalf, cfg.timeoutsPerHalf],
    phase: "kickoff",
    freeKickFrom: Y(cfg.spots.kickoffFrom),
    clockRunning: false,
    twoMinWarned: [false, false],
    openingReceiver,
    ot: null,
    tryKind: null,
    plays: 0,
  };
}

const clone = (s: GameState): GameState => ({
  ...s, score: [...s.score] as [number, number], timeouts: [...s.timeouts] as [number, number],
  twoMinWarned: [...s.twoMinWarned] as [boolean, boolean], ot: s.ot ? { ...s.ot } : null,
});

export const inOvertime = (s: GameState) => s.ot !== null;
export const secondsLeft = (s: GameState, cfg: RulesConfig) => idiv(s.clock, cfg.tickHz);
const half = (q: number) => (q <= 2 ? 0 : 1);

/** first down at `spot`: 10 to go, or goal to go inside the 10 */
function firstDownAt(s: GameState, spot: Fx, cfg: RulesConfig) {
  s.ballOn = spot;
  s.down = 1;
  s.toGo = min(Y(cfg.firstDownYards), Y(100) - spot);
}

/** possession flips; `spotNew` is in the NEW offense's frame */
function changePossession(s: GameState, spotNew: Fx, cfg: RulesConfig) {
  s.possession = other(s.possession);
  firstDownAt(s, spotNew, cfg);
  s.clockRunning = false;
}

function addPoints(s: GameState, side: Side, pts: number) {
  s.score[side] += pts;
}

// ---------------------------------------------------------------- clock
function runClock(s: GameState, ticks: number, cfg: RulesConfig, ev: GameEvent[]) {
  if (s.ot) return;
  const before = s.clock;
  s.clock = Math.max(0, s.clock - ticks);
  twoMinuteCheck(s, before, cfg, ev);
}

function twoMinuteCheck(s: GameState, before: number, cfg: RulesConfig, ev: GameEvent[]) {
  const line = cfg.twoMinuteWarningSeconds * cfg.tickHz;
  const h = half(s.quarter);
  if ((s.quarter === 2 || s.quarter === 4) && !s.twoMinWarned[h] && before > line && s.clock <= line && s.clock > 0) {
    s.twoMinWarned[h] = true;
    s.clockRunning = false;
    ev.push({ t: "twoMinuteWarning" });
  }
}

/**
 * Between plays: optional timeout, then the play-clock runoff if the clock is running.
 * Returns quarterEnded=true when the runoff expires the quarter (no snap happens).
 */
export function beforeSnap(state: GameState, opts: { tempo: Tempo; timeoutBy?: Side | null }, cfg: RulesConfig): Step & { quarterEnded: boolean } {
  const s = clone(state);
  const ev: GameEvent[] = [];
  if (opts.timeoutBy != null && s.timeouts[opts.timeoutBy] > 0 && s.phase === "play") {
    s.timeouts[opts.timeoutBy] -= 1;
    s.clockRunning = false;
    ev.push({ t: "timeout", side: opts.timeoutBy });
  }
  if (s.phase === "play" && s.clockRunning && !s.ot) {
    const before = s.clock;
    let runoff = cfg.runoffSeconds[opts.tempo] * cfg.tickHz;
    const line = cfg.twoMinuteWarningSeconds * cfg.tickHz;
    const h = half(s.quarter);
    if ((s.quarter === 2 || s.quarter === 4) && !s.twoMinWarned[h] && before > line) runoff = Math.min(runoff, before - line);
    s.clock = Math.max(0, s.clock - runoff);
    if (s.clock === line && before > line && (s.quarter === 2 || s.quarter === 4) && !s.twoMinWarned[h]) {
      s.twoMinWarned[h] = true;
      s.clockRunning = false;
      ev.push({ t: "twoMinuteWarning" });
    }
    if (s.clock === 0) {
      const end = endQuarter(s, cfg, ev);
      return { state: end, events: ev, quarterEnded: true };
    }
  }
  return { state: s, events: ev, quarterEnded: false };
}

function oobStopsClock(s: GameState, cfg: RulesConfig) {
  const sec = idiv(s.clock, cfg.tickHz);
  return (s.quarter === 2 && sec <= cfg.outOfBoundsStopsClock.q2LastSeconds) ||
    (s.quarter >= 4 && sec <= cfg.outOfBoundsStopsClock.q4LastSeconds);
}

// ---------------------------------------------------------------- quarters, halves, overtime
function endQuarter(s: GameState, cfg: RulesConfig, ev: GameEvent[]): GameState {
  ev.push({ t: "quarterEnd", text: `End of Q${s.quarter}` });
  if (s.quarter === 1 || s.quarter === 3) {
    s.quarter += 1;
    s.clock = cfg.quarterSeconds * cfg.tickHz;
    return s;
  }
  if (s.quarter === 2) {
    ev.push({ t: "halftime" });
    s.quarter = 3;
    s.clock = cfg.quarterSeconds * cfg.tickHz;
    s.timeouts = [cfg.timeoutsPerHalf, cfg.timeoutsPerHalf];
    s.phase = "kickoff";
    s.possession = s.openingReceiver;        // the team that received first kicks the second half
    s.freeKickFrom = Y(cfg.spots.kickoffFrom);
    s.ballOn = s.freeKickFrom;
    s.clockRunning = false;
    s.tryKind = null;
    return s;
  }
  // end of regulation
  if (s.score[0] !== s.score[1]) return finish(s, ev);
  ev.push({ t: "overtime", text: "Overtime" });
  return startOtPeriod(s, 1, s.openingReceiver, cfg); // the opening kickoff's receiver gets the ball first in OT
}

function finish(s: GameState, ev: GameEvent[]): GameState {
  s.phase = "final";
  s.clockRunning = false;
  ev.push({ t: "final", text: `Final ${s.score[0]}-${s.score[1]}` });
  return s;
}

function startOtPeriod(s: GameState, period: number, first: Side, cfg: RulesConfig): GameState {
  s.quarter = 4 + period;
  s.clock = 0;
  s.ot = { period, first, possIdx: 0 };
  s.timeouts = [cfg.overtime.timeoutsPerPeriod, cfg.overtime.timeoutsPerPeriod];
  startOtPossession(s, first, cfg);
  return s;
}

function startOtPossession(s: GameState, side: Side, cfg: RulesConfig) {
  s.possession = side;
  s.clockRunning = false;
  if (s.ot && s.ot.period >= cfg.overtime.twoPointShootoutFromPeriod) {
    s.phase = "try";
    s.tryKind = "twoPoint";
    s.ballOn = Y(cfg.spots.twoPointLine);
    s.down = 1; s.toGo = Y(100) - s.ballOn;
  } else {
    s.phase = "play";
    s.tryKind = null;
    firstDownAt(s, Y(cfg.overtime.startSpot), cfg);
  }
}

/** The current OT possession is over (score, turnover, downs, FG attempt). */
function endOtPossession(s: GameState, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const ot = s.ot!;
  if (ot.possIdx === 0) {
    ot.possIdx = 1;
    startOtPossession(s, other(ot.first), cfg);
    return s;
  }
  if (s.score[0] !== s.score[1] || ot.period >= cfg.overtime.maxPeriods) return finish(s, ev);
  ev.push({ t: "overtime", text: `Overtime period ${ot.period + 1}` });
  return startOtPeriod(s, ot.period + 1, other(ot.first), cfg);
}

/** After a score in regulation: try or kickoff; in OT: try or end of possession. */
function afterTouchdown(s: GameState, scorer: Side, cfg: RulesConfig, ev: GameEvent[], defensive = false) {
  addPoints(s, scorer, cfg.scoring.touchdown);
  ev.push({ t: "touchdown", side: scorer, points: cfg.scoring.touchdown });
  if (s.ot && defensive && cfg.overtime.defensiveScoreEndsGame) return finish(s, ev);
  s.possession = scorer;
  s.phase = "try";
  s.tryKind = null;
  s.clockRunning = false;
  return s;
}

function kickoffBy(s: GameState, kicker: Side, from: number, cfg: RulesConfig) {
  s.possession = kicker;
  s.phase = "kickoff";
  s.freeKickFrom = Y(from);
  s.ballOn = s.freeKickFrom;
  s.clockRunning = false;
  s.tryKind = null;
}

/** Which tries the team may attempt. */
export function tryOptions(s: GameState, cfg: RulesConfig): ("pat" | "twoPoint")[] {
  if (s.ot && s.ot.period >= cfg.overtime.mustGoForTwoFromPeriod) return ["twoPoint"];
  return ["pat", "twoPoint"];
}

/** Line the ball up for the chosen try. */
export function prepareTry(state: GameState, kind: "pat" | "twoPoint", cfg: RulesConfig): GameState {
  const s = clone(state);
  if (!tryOptions(s, cfg).includes(kind)) throw new Error(`try ${kind} not allowed now`);
  s.tryKind = kind;
  s.ballOn = Y(kind === "pat" ? cfg.spots.patLine : cfg.spots.twoPointLine);
  s.down = 1;
  s.toGo = Y(100) - s.ballOn;
  return s;
}

// ---------------------------------------------------------------- applying outcomes
export function applyOutcome(state: GameState, o: PlayOutcome, cfg: RulesConfig): Step {
  if (state.phase === "final") throw new Error("game is over");
  let s = clone(state);
  const ev: GameEvent[] = [];
  s.plays += 1;
  runClock(s, o.elapsedTicks, cfg, ev);

  switch (o.play) {
    case "kickoff": s = resolveKickoff(s, o, cfg, ev); break;
    case "punt": s = resolvePunt(s, o, cfg, ev); break;
    case "fieldGoal": s = resolveFieldGoal(s, o, cfg, ev); break;
    case "pat": case "twoPoint": s = resolveTry(s, o, cfg, ev); break;
    default: s = resolveScrimmageWithFoul(s, o, cfg, ev);
  }

  // quarter expiry (never between a touchdown and its try)
  if (!s.ot && s.phase !== "final" && s.phase !== "try" && s.clock === 0) s = endQuarter(s, cfg, ev);
  return { state: s, events: ev };
}

function resolveKickoff(s: GameState, o: PlayOutcome, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const kicker = s.possession, recv = other(kicker);
  ev.push({ t: "kickoff", side: kicker });
  if (o.kickingTeamRecovered) { firstDownAt(s, clampField(o.endY), cfg); s.phase = "play"; s.clockRunning = false; return s; }
  s.phase = "play";
  if (o.kickOutOfBounds) { changePossession(s, Y(cfg.spots.kickoffOutOfBounds), cfg); return s; }
  if (o.endY >= Y(100)) { ev.push({ t: "touchback", side: recv }); changePossession(s, Y(cfg.spots.kickoffTouchback), cfg); return s; }
  if (o.endY <= 0) { s.possession = recv; return afterTouchdown(s, recv, cfg, ev); }
  changePossession(s, Y(100) - o.endY, cfg);
  return s;
}

function resolvePunt(s: GameState, o: PlayOutcome, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const kicker = s.possession, recv = other(kicker);
  ev.push({ t: "punt", side: kicker });
  if (o.kickingTeamRecovered) { firstDownAt(s, clampField(o.endY), cfg); s.clockRunning = false; return s; }
  if (s.ot) return endOtPossession(s, cfg, ev);
  if (o.endY >= Y(100)) { ev.push({ t: "touchback", side: recv }); changePossession(s, Y(cfg.spots.turnoverTouchback), cfg); return s; }
  if (o.endY <= 0) { s.possession = recv; return afterTouchdown(s, recv, cfg, ev); }
  changePossession(s, Y(100) - o.endY, cfg);
  return s;
}

function resolveFieldGoal(s: GameState, o: PlayOutcome, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const kicker = s.possession;
  if (o.good) {
    addPoints(s, kicker, cfg.scoring.fieldGoal);
    ev.push({ t: "fieldGoal", side: kicker, points: cfg.scoring.fieldGoal });
    if (s.ot) return endOtPossession(s, cfg, ev);
    kickoffBy(s, kicker, cfg.spots.kickoffFrom, cfg);
    return s;
  }
  ev.push({ t: "fgMissed", side: kicker });
  if (s.ot) return endOtPossession(s, cfg, ev);
  // defense takes over at the spot of the kick, but never inside its own 20
  const kickSpot = s.ballOn - Y(cfg.spots.fgSnapDepth);
  changePossession(s, max(Y(cfg.spots.missedFgMinSpot), Y(100) - kickSpot), cfg);
  return s;
}

function resolveTry(s: GameState, o: PlayOutcome, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const team = s.possession;
  const kind = o.play as "pat" | "twoPoint";
  if (o.good) {
    const pts = kind === "pat" ? cfg.scoring.pat : cfg.scoring.twoPoint;
    addPoints(s, team, pts);
    ev.push({ t: "try", side: team, points: pts, text: kind });
  } else {
    ev.push({ t: "tryFailed", side: team, text: kind });
  }
  s.tryKind = null;
  if (s.ot) return endOtPossession(s, cfg, ev);
  kickoffBy(s, team, cfg.spots.kickoffFrom, cfg);
  return s;
}

const clampField = (y: Fx) => (y < ONE ? ONE : y > Y(99) ? Y(99) : y);

/** Scrimmage play with no foul (or a declined one). */
function resolveScrimmage(s: GameState, o: PlayOutcome, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const off = s.possession, def = other(off);
  if (o.turnover) {
    ev.push({ t: "turnover", side: off, text: o.turnover });
    if (o.endY <= 0) { s.possession = def; return afterTouchdown(s, def, cfg, ev, true); }
    if (s.ot) {
      // college OT: a turnover ends the possession (a return TD was handled above)
      return endOtPossession(s, cfg, ev);
    }
    if (o.endY >= Y(100)) { ev.push({ t: "touchback", side: def }); changePossession(s, Y(cfg.spots.turnoverTouchback), cfg); return s; }
    changePossession(s, Y(100) - o.endY, cfg);
    return s;
  }
  const spot = o.incomplete || o.play === "spike" ? s.ballOn : o.endY;
  if (!o.incomplete && spot >= Y(100)) return afterTouchdown(s, off, cfg, ev);
  if (!o.incomplete && spot <= 0) {
    addPoints(s, def, cfg.scoring.safety);
    ev.push({ t: "safety", side: def, points: cfg.scoring.safety });
    if (s.ot) return endOtPossession(s, cfg, ev);
    kickoffBy(s, off, cfg.spots.safetyKickFrom, cfg);
    return s;
  }
  const line = s.ballOn + s.toGo;
  if (spot >= line) {
    firstDownAt(s, spot, cfg);
    ev.push({ t: "firstDown", side: off });
  } else {
    s.down += 1;
    s.toGo = line - spot;
    s.ballOn = spot;
    if (s.down > cfg.downs) {
      ev.push({ t: "downs", side: off });
      if (s.ot) return endOtPossession(s, cfg, ev);
      changePossession(s, Y(100) - spot, cfg);
      return s;
    }
  }
  s.clockRunning = !(o.incomplete || o.play === "spike" || (o.outOfBounds && oobStopsClock(s, cfg)));
  return s;
}

// ---------------------------------------------------------------- penalties
/** How good a state is for `side` (rough expected-points proxy), used for accept/decline. */
function valueFor(s: GameState, side: Side): number {
  const pts = s.score[side] - s.score[other(side)];
  if (s.phase !== "play") return pts * 10;
  const y = s.ballOn / ONE;
  const pos = s.possession === side ? 1 : -1;
  const field = y + (s.down === 1 ? 8 : 0) - (s.toGo / ONE) * 0.6 - s.down * 3;
  return pts * 10 + pos * (field + 40);
}

function enforceYards(s: GameState, on: "O" | "D", yards: number, from: Fx) {
  // full yardage, or half the distance to the goal if that is shorter
  const Yd = Y(yards);
  if (on === "O") s.ballOn = from - min(Yd, idiv(from, 2));
  else s.ballOn = from + min(Yd, idiv(Y(100) - from, 2));
}

function resolveScrimmageWithFoul(state: GameState, o: PlayOutcome, cfg: RulesConfig, ev: GameEvent[]): GameState {
  const f = o.foul;
  if (!f) return resolveScrimmage(state, o, cfg, ev);
  const off = state.possession;
  const offended: Side = f.on === "O" ? other(off) : off;

  if (f.kind === "preSnap") {
    const s = clone(state);                    // dead ball: the engine reports 0 elapsed ticks
    const line = s.ballOn + s.toGo;
    enforceYards(s, f.on, f.yards, s.ballOn);
    s.toGo = line - s.ballOn;
    if (s.toGo <= 0) firstDownAt(s, s.ballOn, cfg);
    s.clockRunning = state.clockRunning;
    ev.push({ t: "penalty", side: offended, text: `${f.name}, ${f.on === "O" ? "offense" : "defense"}, ${f.yards} yds` });
    return s;
  }

  // live-ball foul: compare "accept" with "decline" and let the offended team choose
  const declinedEv: GameEvent[] = [];
  const declined = resolveScrimmage(clone(state), o, cfg, declinedEv);
  const accepted = clone(state);
  const acceptedEv: GameEvent[] = [];
  const line = accepted.ballOn + accepted.toGo;
  if (f.on === "O") {
    enforceYards(accepted, "O", f.yards, accepted.ballOn); // from the previous spot, replay the down
    accepted.toGo = line - accepted.ballOn;
    accepted.clockRunning = false;
  } else {
    let from = accepted.ballOn;
    if (f.spotY != null) {
      accepted.ballOn = clampField(f.spotY);  // spot foul (pass interference)
    } else {
      if (f.addedToEnd && !o.incomplete && !o.turnover && o.endY > from) from = o.endY;
      enforceYards(accepted, "D", f.yards, from);
    }
    if (f.autoFirst || accepted.ballOn >= line) firstDownAt(accepted, accepted.ballOn, cfg);
    else accepted.toGo = line - accepted.ballOn;
    accepted.clockRunning = false;
    if (accepted.ballOn >= Y(100)) firstDownAt(accepted, Y(99), cfg);
  }
  const takeIt = valueFor(accepted, offended) >= valueFor(declined, offended);
  if (takeIt) {
    ev.push(...acceptedEv, { t: "penalty", side: offended, text: `${f.name}, ${f.on === "O" ? "offense" : "defense"}, ${f.yards} yds` });
    return accepted;
  }
  ev.push(...declinedEv, { t: "declined", side: offended, text: f.name });
  return declined;
}
