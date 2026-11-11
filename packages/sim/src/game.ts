// Full game loop: coach decisions -> engine -> rules, until the final whistle. Deterministic:
// the same rosters + seed always produce the same game (and the same hash).
//
// GameSession runs a game one play at a time. stepAuto() lets the AI decide everything (that is
// what playGame and the harness use). snap()/finish() let a human call plays (offense) or
// coverages (defense) and drive the live play through PlaySim.step().
import type { DefenseCall, GameData, OffensePlay } from "@tdf/shared";
import * as F from "./fixed.js";
import { hashString, Rng } from "./rng.js";
import {
  applyOutcome, beforeSnap, newGame, other, prepareTry, secondsLeft, tryOptions,
  type Foul, type GameEvent, type GameState, type PlayOutcome, type Side,
} from "./rules.js";
import type { Roster } from "./roster.js";
import {
  chooseDefense, chooseOffensePlay, aiCheck, type ScrimmageDecision, type PlayCall, type DefCall, chooseScrimmage, chooseTry, emptyTendencies, recordDefense, recordOffense, runRate, tempoFor, timeoutFor,
  type Tendencies,
} from "./coach.js";
import { createPlay, type PlayResult, type PlaySim, type PreSnapDefense, type PreSnapOffense, type StatEvent, type Stats } from "./engine/play.js";
import { fgDistance } from "./engine/kicks.js";
import { createKick, kickChance, type KickMeta } from "./engine/special.js";
import type { KickKind } from "./engine/play.js";

const { ONE, fx } = F;

export interface PlayLog {
  n: number; q: number; clock: number; off: Side; down: number; toGo: number; ballOn: number;
  kind: string; name: string; defense?: string; result: string; yards: number; events: GameEvent[];
}

export interface TeamBox {
  score: number; byQuarter: number[];
  plays: number; firstDowns: number; totalYds: number;
  passAtt: number; passComp: number; passYds: number; passTd: number; ints: number; sacksTaken: number; sackYds: number;
  rushAtt: number; rushYds: number; rushTd: number;
  fumblesLost: number; turnovers: number;
  penalties: number; penaltyYds: number;
  thirdAtt: number; thirdConv: number; fourthAtt: number; fourthConv: number;
  fgAtt: number; fgMade: number; fgByDist: Record<string, [number, number]>; patAtt: number; patMade: number; twoAtt: number; twoMade: number;
  punts: number; puntYds: number; puntNet: number;
  kickoffs: number; touchbacks: number; krAtt: number; krYds: number; prAtt: number; prYds: number; retTd: number;
  onsideAtt: number; onsideRec: number; blockedKicks: number; fakes: number;
  topTicks: number; sacks: number; defInts: number;
}
export interface PlayerLine { id: number; name: string; team: Side; pos: string; [k: string]: number | string }
export interface GameResult {
  seed: number | string; state: GameState; teams: [TeamBox, TeamBox]; players: PlayerLine[];
  log: PlayLog[]; hash: string; names: [string, string];
}

const emptyBox = (): TeamBox => ({
  score: 0, byQuarter: [], plays: 0, firstDowns: 0, totalYds: 0,
  passAtt: 0, passComp: 0, passYds: 0, passTd: 0, ints: 0, sacksTaken: 0, sackYds: 0,
  rushAtt: 0, rushYds: 0, rushTd: 0, fumblesLost: 0, turnovers: 0, penalties: 0, penaltyYds: 0,
  thirdAtt: 0, thirdConv: 0, fourthAtt: 0, fourthConv: 0,
  fgAtt: 0, fgMade: 0, fgByDist: {}, patAtt: 0, patMade: 0, twoAtt: 0, twoMade: 0, punts: 0, puntYds: 0, puntNet: 0,
  kickoffs: 0, touchbacks: 0, krAtt: 0, krYds: 0, prAtt: 0, prYds: 0, retTd: 0, onsideAtt: 0, onsideRec: 0, blockedKicks: 0, fakes: 0,
  topTicks: 0, sacks: 0, defInts: 0,
});

export interface GameSetup {
  data: GameData;
  ratings: (id: number) => Stats;
  teams: [Roster, Roster];
  seed: number | string;
  maxPlays?: number;
  /** side controlled by a human (offense: plays + live control; defense: coverage calls) */
  userSide?: Side | null;
  /** override quarter length (game seconds), e.g. for short games */
  quarterSeconds?: number;
  /** two humans share the device (hot-seat): the side with the ball is the user; SnapOptions.defCall is the other's call */
  hotseat?: boolean;
  /** wind in mph (x across, y toward the north end zone); default: random */
  wind?: F.V2;
}

/** What has to happen next. */
export type Pending =
  | { kind: "final" }
  | { kind: "kickoff" }
  | { kind: "try"; options: ("pat" | "twoPoint")[] }
  | { kind: "scrimmage" };

/** A human offensive decision. */
export type UserCall =
  | { kind: "play"; play: OffensePlay; flip: boolean; formation?: string; personnel?: string }
  | { kind: "punt" } | { kind: "fieldGoal" } | { kind: "kneel" } | { kind: "spike" }
  /** a fake from the punt or field-goal unit */
  | { kind: "fake"; play: OffensePlay; as?: "punt" | "fieldGoal" };

export interface SnapOptions {
  userCall?: UserCall;               // human offense
  tryChoice?: "pat" | "twoPoint";    // human try decision
  defCall?: DefenseCall;             // human defense
  defFront?: string;                 // human defense: front (default: the AI's answer to the personnel)
  preOff?: PreSnapOffense;           // human offense pre-snap (usually set later with adjust())
  preDef?: PreSnapDefense;
  /** human defense: control one defender during the play */
  controlDefender?: boolean;
  timeout?: boolean;                 // human calls a timeout before this snap
  /** human kicking off: deep, squib or onside */
  kickoffKind?: "kickoff" | "squib" | "onside";
  /** human returning: wall side */
  returnSide?: "L" | "M" | "R";
  /** human defending a punt / FG: block, safe (fake watch), normal */
  stDefense?: "block" | "safe" | "normal";
}

/** A live scrimmage play in progress. */
export interface LivePlay {
  sim: PlaySim; offSide: Side; userOffense: boolean;
  play: OffensePlay; call: DefenseCall; twoPoint: boolean;
  formation: string; personnel: string; front: string; userDefense: boolean;
  flip: boolean; preOff?: PreSnapOffense; preDef?: PreSnapDefense;
  /** the play's own random stream: re-lining up (audible, hot route, motion...) replays the same luck */
  seed: number;
  /** special-teams play */
  kick?: { kind: KickKind; userKick: boolean; userReturn: boolean };
  hardCounted?: boolean;
  /** internal bookkeeping for finish() */
  ctx: { before: GameState; at: GameState };
}
export interface PlaySummary { entry: PlayLog; events: GameEvent[]; state: GameState }
export type SnapResult = { live: LivePlay } | { done: PlaySummary };

export class GameSession {
  readonly data: GameData;
  readonly teams: [Roster, Roster];
  private readonly fixedUser: Side | null;
  /** hot-seat: two humans on one device; whoever has the ball plays it, the other calls the defense */
  readonly hotseat: boolean;
  /** the side a human is controlling right now */
  get userSide(): Side | null { return this.hotseat ? this.state.possession : this.fixedUser; }
  state: GameState;
  readonly box: [TeamBox, TeamBox] = [emptyBox(), emptyBox()];
  readonly log: PlayLog[] = [];
  /** what each side has shown this game */
  readonly tend: [Tendencies, Tendencies] = [emptyTendencies(), emptyTendencies()];
  private readonly cfg: GameData["rules"];
  private readonly rng: Rng;
  private readonly ratings: (id: number) => Stats;
  private readonly players = new Map<number, PlayerLine>();
  private readonly outcomesForHash: string[] = [];
  private ballX: F.Fx;
  private readonly mid: F.Fx;
  private readonly hashGap: F.Fx;
  private readonly seed: number | string;

  constructor(setup: GameSetup) {
    this.data = setup.data;
    this.teams = setup.teams;
    this.ratings = setup.ratings;
    this.fixedUser = setup.userSide ?? null;
    this.hotseat = Boolean(setup.hotseat);
    this.seed = setup.seed;
    this.cfg = setup.quarterSeconds ? { ...setup.data.rules, quarterSeconds: setup.quarterSeconds } : setup.data.rules;
    this.rng = new Rng(setup.seed);
    this.state = newGame(this.cfg, this.rng.int(2) as Side);
    this.mid = fx(this.data.tuning.field.width / 2);
    this.hashGap = fx(this.data.tuning.field.hashHalfGap);
    this.ballX = this.mid;
    const W = this.data.tuning.special;
    const wr = this.rng.int(1000);
    if (setup.wind) this.wind = setup.wind;
    else if (wr < W.windCalmPerMille) this.wind = { x: 0, y: 0 };
    else {
      const mph = 3 + this.rng.int(Math.max(1, W.windMaxMph - 2));
      const dir = this.rng.int(8);
      const v = F.vfromAngle(F.mul(fx(Math.PI / 4), fx(dir)), fx(mph));
      this.wind = { x: v.x, y: v.y };
    }
  }

  get rules() { return this.cfg; }

  /** Wind in mph (x across the field, y toward the north end zone). */
  readonly wind: F.V2;
  /** Wind as the given side feels it when it has the ball this quarter (its attacking frame). */
  windFor(side: Side): F.V2 {
    const q = this.state.quarter;
    const north = (side === 0 ? 1 : -1) * (q % 2 === 1 ? 1 : -1);
    return { x: this.wind.x * north, y: this.wind.y * north };
  }
  private pressure(s: GameState): boolean {
    return s.ot !== null || (s.quarter >= 4 && secondsLeft(s, this.cfg) <= 120);
  }
  /** Field-goal / PAT make chance (per-mille) for the team with the ball, in this wind. */
  kickChanceFor(kind: "fieldGoal" | "pat", ballOn: F.Fx): number {
    const s = this.state, k = this.teams[s.possession].starters.K!;
    const r = this.ratings(k.id);
    const key = `${k.id}:${kind}:${ballOn >> 16}:${this.windFor(s.possession).x}:${this.windFor(s.possession).y}:${this.pressure(s)}`;
    let v = this.chanceCache.get(key);
    if (v == null) { v = kickChance(this.data, r.kickPower ?? 70, r.kickAccuracy ?? 70, kind, ballOn, this.windFor(s.possession), this.pressure(s)); this.chanceCache.set(key, v); }
    return v;
  }
  private chanceCache = new Map<string, number>();

  private startKick(s: GameState, before: GameState, kind: KickKind, opts: SnapOptions): LivePlay {
    const off = s.possession, def = other(off);
    const userKick = this.userSide === off, userReturn = this.userSide === def;
    const seed = this.rng.int(1_000_000_000);
    const prng = new Rng(seed);
    const C = this.data.coach;
    const stDefense = userReturn ? opts.stDefense ?? "normal"
      : kind === "punt" || kind === "fieldGoal" ? (prng.int(1000) < 100 ? "block" : prng.int(1000) < 150 && s.toGo <= fx(3) ? "safe" : "normal") : "normal";
    const returnSide = userReturn ? opts.returnSide ?? "M" : (["L", "M", "R"] as const)[prng.int(3)]!;
    void C;
    const spot = kind === "kickoff" || kind === "squib" || kind === "onside" ? s.freeKickFrom : s.ballOn;
    const ballX = kind === "kickoff" || kind === "squib" || kind === "onside" ? this.mid : this.ballX;
    const sim = createKick({
      data: this.data, ratings: this.ratings, kicking: this.teams[off], receiving: this.teams[def], kickSide: off, kind, spot, ballX,
      rng: prng, wind: this.windFor(off), pressure: this.pressure(s), userKick, userReturn, userKickTeam: userKick && kind === "onside",
      returnSide, stDefense,
    });
    const play = this.data.offense.plays[0]!, call = this.data.defense.calls[0]!;
    return { sim, offSide: off, userOffense: userKick, userDefense: false, play, call, formation: "", personnel: "", front: "", flip: false,
      seed, twoPoint: false, kick: { kind, userKick, userReturn }, ctx: { before, at: s } };
  }
  /** AI kickoff choice: onside when trailing late, squib to end the half, else deep. */
  private chooseKickoffKind(s: GameState): KickKind {
    const C = this.data.coach.special, t = secondsLeft(s, this.cfg);
    const kicker = s.possession, lead = s.score[kicker] - s.score[other(kicker)];
    if (!s.ot && s.quarter >= 4 && lead < 0 && -lead <= C.onsideMaxDeficit && t <= C.onsideSeconds) return "onside";
    if (s.quarter === 2 && t <= C.squibSeconds) return "squib";
    return this.rng.int(1000) < C.squibPerMille ? "squib" : "kickoff";
  }
  /** Ball's position across the field for the next snap. */
  get ballX_(): F.Fx { return this.ballX; }

  pending(): Pending {
    const s = this.state;
    if (s.phase === "final") return { kind: "final" };
    if (s.phase === "kickoff") return { kind: "kickoff" };
    if (s.phase === "try") return { kind: "try", options: tryOptions(s, this.cfg) };
    return { kind: "scrimmage" };
  }
  isUserOffense(): boolean { return this.userSide !== null && this.state.possession === this.userSide; }

  /** Everything decided by the AI (both sides). */
  stepAuto(): PlaySummary {
    const r = this.snap({});
    if ("done" in r) return r.done;
    while (!r.live.sim.step()) { /* run it out */ }
    return this.finish(r.live);
  }

  /** Start the next play. Kicks, kneels, pre-snap fouls and quarter ends resolve at once. */
  snap(opts: SnapOptions): SnapResult {
    const { data, rng, ratings, teams, cfg } = this;
    let s = this.state;
    const off = s.possession, def = other(off);
    const offense = teams[off], defense = teams[def];
    const kin = { data, rng, ratings, kicking: offense, receiving: defense, kickSide: off };
    const before = s;
    const userOff = this.userSide === off;

    if (s.phase === "final") throw new Error("game is over");
    if (s.phase === "kickoff") {
      const kind = userOff ? opts.kickoffKind ?? "kickoff" : this.chooseKickoffKind(s);
      return { live: this.startKick(s, before, kind, opts) };
    }
    if (s.phase === "try") {
      const choice = userOff && opts.tryChoice ? opts.tryChoice : chooseTry(s, tryOptions(s, cfg));
      s = prepareTry(s, choice, cfg);
      this.state = s;
      if (choice === "pat") {
        this.ballX = this.mid;
        return { live: this.startKick(s, before, "pat", opts) };
      }
      const goal = data.offense.plays.filter((p) => p.weight > 0 && !p.tags.includes("deep") && !p.tags.includes("screen"));
      const p0 = goal[rng.int(goal.length)]!;
      let pc = { play: p0, formation: p0.formations[0]!, personnel: data.formations.offense.find((f) => f.id === p0.formations[0])!.personnel[0]!, flip: rng.int(2) === 1 };
      if (userOff && opts.userCall?.kind === "play") pc = this.userPlayCall(opts.userCall);
      let dc = chooseDefense(s, data, rng, pc.personnel, defense, this.tend[off]);
      if ((!userOff || this.hotseat) && this.userSide !== null && opts.defCall) dc = { call: opts.defCall, front: opts.defFront ?? dc.front };
      return { live: this.start(s, before, pc, dc, opts, true) };
    }

    // scrimmage: timeouts and runoff
    const timeoutBy = opts.timeout && this.userSide !== null ? this.userSide : timeoutFor(s, data);
    const tempo = userOff ? "normal" : tempoFor(s, data);
    const pre = beforeSnap(s, { tempo, timeoutBy }, cfg);
    this.box[off].topTicks += before.clock - pre.state.clock > 0 && !pre.quarterEnded ? before.clock - pre.state.clock : 0;
    s = pre.state;
    this.state = s;
    if (pre.quarterEnded) {
      this.preview = null;
      const entry = this.entry(before, "—", "", pre.events.map((e) => e.text ?? e.t).join(", "), 0, pre.events);
      this.log.push(entry);
      return { done: { entry, events: pre.events, state: s } };
    }
    let dec = userOff && opts.userCall
      ? (opts.userCall.kind === "play"
        ? (() => { const pc = this.userPlayCall(opts.userCall); return { kind: "play" as const, ...pc, ...chooseDefense(s, data, rng, pc.personnel, defense, this.tend[off]) }; })()
        : opts.userCall)
      : this.preview ?? chooseScrimmage(s, offense, defense, data, ratings, rng, this.tend[off], this.tend[def], (b) => this.kickChanceFor("fieldGoal", b));
    this.preview = null;
    if (dec.kind === "play" && (!userOff || this.hotseat) && this.userSide !== null && opts.defCall) dec = { ...dec, call: opts.defCall, front: opts.defFront ?? dec.front };
    if (dec.kind === "punt" || dec.kind === "fieldGoal") return { live: this.startKick(s, before, dec.kind, opts) };
    if (dec.kind === "fake") {
      // the fake comes out of the kicking unit; the defense lined up for the kick it expected
      this.box[off].fakes++;
      const fo = data.formations.offense.find((f) => dec.play.formations.includes(f.id))!;
      const mode = this.userSide === def ? opts.stDefense ?? "normal" : "normal";
      const look = mode === "block" ? { front: "goal_line", call: "cover0" } : mode === "safe" ? { front: "base43", call: "cover3" } : { front: "nickel", call: "cover1" };
      const pc = { play: dec.play, formation: fo.id, personnel: fo.personnel[0]!, flip: rng.int(2) === 1 };
      const dc = { call: data.defense.calls.find((c) => c.id === look.call)!, front: look.front };
      return { live: this.start(s, before, pc, dc, opts, false) };
    }
    if (dec.kind === "kneel") {
      this.recordStats([{ k: "rush", id: offense.starters.QB!.id, team: off, att: 1, yds: -1 }]);
      return { done: this.apply(before, s, { play: "kneel", endY: s.ballOn - ONE, elapsedTicks: 2 * cfg.tickHz }, [], "Kneel", "", "QB kneels") };
    }
    if (dec.kind === "spike") {
      return { done: this.apply(before, s, { play: "spike", endY: s.ballOn, incomplete: true, elapsedTicks: cfg.tickHz }, [], "Spike", "", "spiked") };
    }
    const preFoul = preSnapFoul(s, offense, defense, data, ratings, rng);
    if (preFoul) {
      return { done: this.apply(before, s, { play: "scrimmage", endY: s.ballOn, elapsedTicks: 0, foul: preFoul }, [], dec.play.name, "", preFoul.name) };
    }
    recordOffense(this.tend[off], s, dec);
    recordDefense(this.tend[def], dec.call);
    const live = this.start(s, before, dec, dec, opts, false);
    // the AI offense sometimes hard-counts on third or fourth and short
    if (!userOff && s.down >= 3 && s.toGo <= fx(2) && rng.int(1000) < data.coach.presnap.hardCountPerMille) {
      const hc = this.hardCount(live);
      if (hc) return { done: hc };
    }
    return { live };
  }

  /** The AI offense's next call, decided now so a human defense can see the personnel group come on
   *  the field (as in real football) before choosing its own call. snap() then uses this decision. */
  previewAiOffense(): ScrimmageDecision | null {
    const s = this.state;
    if (s.phase !== "play" || this.isUserOffense()) return null;
    const off = s.possession, def = other(off);
    this.preview ??= chooseScrimmage(s, this.teams[off], this.teams[def], this.data, this.ratings, this.rng, this.tend[off], this.tend[def], (b) => this.kickChanceFor("fieldGoal", b));
    return this.preview;
  }
  private preview: ScrimmageDecision | null = null;

  /** The offense's call when only the play is given: the first formation, its first personnel. */
  private userPlayCall(c: Extract<UserCall, { kind: "play" }>) {
    const formation = c.formation && c.play.formations.includes(c.formation) ? c.formation : c.play.formations[0]!;
    const f = this.data.formations.offense.find((x) => x.id === formation)!;
    const personnel = c.personnel && f.personnel.includes(c.personnel) ? c.personnel : f.personnel[0]!;
    return { play: c.play, formation, personnel, flip: c.flip };
  }

  /** Line up and create the live play. */
  private start(s: GameState, before: GameState, pc: PlayCall, dc: DefCall, opts: SnapOptions, twoPoint: boolean): LivePlay {
    const off = s.possession, def = other(off);
    const userOff = this.userSide === off;
    const userDefense = !userOff && this.userSide === def && Boolean(opts.controlDefender);
    if (twoPoint) this.ballX = this.mid;
    const seed = this.rng.int(1_000_000_000);
    const preOff = userOff ? opts.preOff : pc.preOff;
    const preDef = !userOff && this.userSide === def ? opts.preDef : dc.preDef;
    return this.build({ offSide: off, userOffense: userOff, userDefense, play: pc.play, call: dc.call, formation: pc.formation, personnel: pc.personnel,
      front: dc.front, flip: pc.flip, preOff, preDef, seed, twoPoint, ctx: { before, at: s } });
  }
  /** Create (or re-create) the play's simulation from its description. */
  private build(l: Omit<LivePlay, "sim">): LivePlay {
    const { data, ratings, teams } = this;
    const s = l.ctx.at;
    const off = l.offSide, def = other(off);
    // the AI offense may check out of a long pass when the defense shows blitz
    if (!l.userOffense && l.preDef?.show) {
      const chk = aiCheck({ play: l.play, formation: l.formation, personnel: l.personnel, flip: l.flip }, l.preDef,
        ratings(teams[off].starters.QB!.id).awareness ?? 60, data, new Rng(l.seed ^ 0x5bd1e995));
      if (chk) l = { ...l, play: chk.play };
    }
    const C = data.coach.tendency;
    const paBiteMult = C.paBiteBase + C.paBitePerRunRate * runRate(this.tend[off], data);
    const sim = createPlay({
      data, ratings, offense: teams[off], defense: teams[def], offSide: off, ballOn: s.ballOn, ballX: this.ballX, toGo: s.toGo,
      play: l.play, formation: l.formation, personnel: l.personnel, call: l.call, front: l.front, flip: l.flip, rng: new Rng(l.seed),
      twoPoint: l.twoPoint, userOffense: l.userOffense, userDefense: l.userDefense, paBiteMult, preOff: l.preOff, preDef: l.preDef,
    });
    return { ...l, sim };
  }

  /** Pre-snap changes before the ball is snapped: audible (play/formation/flip), defensive audible,
   *  motion, shifts, hot routes, protection, defensive looks. The play keeps its own random stream. */
  adjust(live: LivePlay, ch: { play?: OffensePlay; formation?: string; flip?: boolean; call?: DefenseCall; front?: string; preOff?: PreSnapOffense; preDef?: PreSnapDefense }): LivePlay {
    let formation = ch.formation ?? live.formation;
    let personnel = live.personnel;
    const play = ch.play ?? live.play;
    if (!play.formations.includes(formation)) {
      // an audible keeps the personnel group on the field: find a formation for it
      const fits = play.formations.filter((f) => this.data.formations.offense.find((x) => x.id === f)?.personnel.includes(personnel));
      formation = fits[0] ?? play.formations[0]!;
      const fo = this.data.formations.offense.find((x) => x.id === formation)!;
      if (!fo.personnel.includes(personnel)) personnel = fo.personnel[0]!;
    }
    return this.build({ ...live, play, formation, personnel, flip: ch.flip ?? live.flip, call: ch.call ?? live.call, front: ch.front ?? live.front,
      preOff: ch.preOff ?? live.preOff, preDef: ch.preDef ?? live.preDef });
  }

  /** Hard count: the defense may jump offside (free 5 yards); your own line may false-start. Once per play.
   *  Returns the dead-ball result, or null if nobody moved (snap as normal). */
  hardCount(live: LivePlay): PlaySummary | null {
    if (live.hardCounted || live.twoPoint) return null;
    live.hardCounted = true;
    const P = this.data.tuning.presnap;
    const def = this.teams[other(live.offSide)];
    const dl = ["DE1", "DT1", "DT2", "DE2"].reduce((a, sl) => a + (this.ratings(def.starters[sl]!.id).playRecognition ?? 60), 0) / 4;
    const rng = new Rng(live.seed ^ 0x2545f491);
    let foul: Foul | null = null;
    if (rng.int(1000) < P.hardCountOffsideBase + P.hardCountOffsidePer * (70 - dl)) foul = { name: "Offside (hard count)", on: "D", yards: 5, kind: "preSnap" };
    else if (rng.int(1000) < P.hardCountFalseStart) foul = { name: "False start", on: "O", yards: 5, kind: "preSnap" };
    if (!foul) return null;
    return this.apply(live.ctx.before, live.ctx.at, { play: "scrimmage", endY: live.ctx.at.ballOn, elapsedTicks: 0, foul }, [], live.play.name, "", foul.name);
  }
  /** The play clock ran out before the snap. */
  delayOfGame(live: LivePlay): PlaySummary {
    const foul: Foul = { name: "Delay of game", on: "O", yards: 5, kind: "preSnap" };
    return this.apply(live.ctx.before, live.ctx.at, { play: "scrimmage", endY: live.ctx.at.ballOn, elapsedTicks: 0, foul }, [], live.play.name, "", foul.name);
  }

  /** Apply a finished live play. */
  finish(live: LivePlay): PlaySummary {
    if (live.kick) return this.finishKick(live);
    const r: PlayResult = live.sim.result();
    const s = live.ctx.at;
    const off = live.offSide;
    if (live.twoPoint) {
      this.box[off].twoAtt++; if (r.outcome.good) this.box[off].twoMade++;
      return this.apply(live.ctx.before, s, r.outcome, [], `2-pt: ${live.play.name}`, live.call.name, r.outcome.good ? "converted" : "failed", "try");
    }
    this.ballX = F.clamp(r.endX, this.mid - this.hashGap, this.mid + this.hashGap);
    this.box[off].plays++;
    if (s.down === 3) this.box[off].thirdAtt++;
    if (s.down === 4) this.box[off].fourthAtt++;
    return this.apply(live.ctx.before, s, r.outcome, r.stats, live.play.name, live.call.name, r.log.slice(-2).join("; "));
  }

  private finishKick(live: LivePlay): PlaySummary {
    const r = live.sim.result() as PlayResult & { meta: KickMeta };
    const s = live.ctx.at, off = live.offSide, def = other(off), b = this.box[off], m = r.meta;
    const kind = live.kick!.kind;
    if (m.blocked) b.blockedKicks++;
    if (m.returner != null && !m.blocked && !m.fairCatch && !m.touchback && r.stats.some((x) => x.k === "kr" || x.k === "pr")) { const rb = this.box[def]; if (kind === "punt") { rb.prAtt++; rb.prYds += m.returnYds; } else { rb.krAtt++; rb.krYds += m.returnYds; } }
    if (m.returnTd) this.box[def].retTd++;
    this.ballX = F.clamp(r.endX, this.mid - this.hashGap, this.mid + this.hashGap);
    let name = "Kickoff";
    if (kind === "kickoff" || kind === "squib" || kind === "onside") {
      b.kickoffs++;
      if (m.touchback) b.touchbacks++;
      if (kind === "onside") { b.onsideAtt++; if (m.kickingRecovered) b.onsideRec++; name = "Onside kick"; }
      if (kind === "squib") name = "Squib kick";
      if (m.touchback || m.outOfBounds) this.ballX = this.mid;
    } else if (kind === "punt") {
      name = "Punt";
      b.punts++;
      if (!m.blocked) {
        b.puntYds += Math.max(0, m.gross);
        // net: where the receiving team starts (a touchback comes out to the 20)
        const at = m.touchback ? fx(80) : r.outcome.kickingTeamRecovered ? s.ballOn : F.min(r.outcome.endY, fx(100));
        b.puntNet += Math.round((at - s.ballOn) / ONE);
      }
      if (m.touchback) this.ballX = this.mid;
    } else if (kind === "fieldGoal") {
      const dist = fgDistance(s.ballOn, this.data);
      name = `${dist}-yd field goal`;
      b.fgAtt++; if (r.outcome.good) b.fgMade++;
      const bucket = dist < 30 ? "<30" : dist < 40 ? "30-39" : dist < 50 ? "40-49" : "50+";
      const fb = (b.fgByDist[bucket] ??= [0, 0]); fb[1]++; if (r.outcome.good) fb[0]++;
      this.ballX = this.mid;
    } else if (kind === "pat") {
      name = "Extra point";
      b.patAtt++; if (r.outcome.good) b.patMade++;
      this.ballX = this.mid;
    }
    return this.apply(live.ctx.before, s, r.outcome, r.stats, name, "", r.log.slice(-2).join("; "), kind === "pat" ? "try" : kind === "punt" || kind === "fieldGoal" ? "play" : "kickoff");
  }

  result(): GameResult {
    const s = this.state;
    for (const side of [0, 1] as Side[]) {
      const b = this.box[side];
      b.score = s.score[side];
      b.totalYds = b.passYds - b.sackYds + b.rushYds;
      b.turnovers = b.ints + b.fumblesLost;
    }
    const hash = hashString(JSON.stringify([s, this.outcomesForHash])).toString(16).padStart(8, "0");
    return { seed: this.seed, state: s, teams: this.box, players: [...this.players.values()], log: this.log, hash,
      names: [this.teams[0].info.abbr, this.teams[1].info.abbr] };
  }

  // ---------------------------------------------------------------- bookkeeping
  private apply(before: GameState, s: GameState, outcome: PlayOutcome, stats: StatEvent[], name: string, defense_: string, resultText: string, kind = before.phase as string): PlaySummary {
    const { cfg, box } = this;
    const off = s.possession;
    const wasDown = s.down, wasPhase = s.phase, wasBallOn = s.ballOn;
    const step = applyOutcome(s, outcome, cfg);
    if (wasPhase === "play" && outcome.play !== "kickoff") box[off].topTicks += Math.min(outcome.elapsedTicks, s.clock);
    for (const e of step.events) if (e.t === "penalty" && outcome.foul && e.side != null) {
      const guilty = other(e.side);
      box[guilty].penalties++;
      box[guilty].penaltyYds += outcome.foul.spotY != null ? Math.max(0, Math.round((outcome.foul.spotY - wasBallOn) / ONE)) : outcome.foul.yards;
    }
    const accepted = step.events.some((e) => e.t === "penalty");
    if (!accepted || outcome.foul?.kind !== "live") this.recordStats(stats);
    else if (outcome.foul?.on === "D") this.recordStats(stats.filter((x) => x.k === "tackle")); // play stats wiped by the foul
    for (const e of step.events) {
      if (e.t === "firstDown" && e.side === off) {
        box[off].firstDowns++;
        if (wasDown === 3) box[off].thirdConv++;
        if (wasDown === 4) box[off].fourthConv++;
      }
      if (e.t === "touchdown" && e.side === off && wasPhase === "play") {
        if (wasDown === 3) box[off].thirdConv++;
        if (wasDown === 4) box[off].fourthConv++;
      }
    }
    const sack = stats.some((x) => x.k === "sack");
    if (sack && !accepted) { box[off].sacksTaken++; box[off].sackYds += Math.round((wasBallOn - outcome.endY) / ONE); }
    for (const e of step.events) if (e.points && e.side != null) {
      const q = Math.min(s.quarter, 5) - 1;
      const bq = box[e.side].byQuarter;
      while (bq.length <= q) bq.push(0);
      bq[q]! += e.points;
    }
    this.outcomesForHash.push(`${outcome.play}:${outcome.endY}:${outcome.elapsedTicks}:${outcome.good ? 1 : 0}:${outcome.turnover ?? ""}`);
    const gained = outcome.incomplete || outcome.play === "kickoff" || outcome.play === "punt" ? 0 : Math.round((outcome.endY - wasBallOn) / ONE);
    const entry = this.entry(before, name, defense_, resultText + (step.events.length ? " [" + step.events.map((e) => e.text ?? e.t).join(", ") + "]" : ""), gained, step.events, kind);
    this.log.push(entry);
    this.state = step.state;
    return { entry, events: step.events, state: step.state };
  }

  private line(id: number, team: Side): PlayerLine {
    let p = this.players.get(id);
    if (!p) {
      const ro = this.teams[team];
      const c = [...Object.values(ro.starters), ...ro.bench].find((x) => x.id === id);
      p = { id, name: c?.name ?? String(id), team, pos: c?.pos ?? "?" };
      this.players.set(id, p);
    }
    return p;
  }

  private recordStats(ev: StatEvent[]) {
    const add = (p: PlayerLine, k: string, v: number) => { p[k] = ((p[k] as number) ?? 0) + v; };
    for (const e of ev) {
      const p = this.line(e.id, e.team), b = this.box[e.team];
      switch (e.k) {
        case "pass":
          add(p, "passAtt", e.att ?? 0); add(p, "passComp", e.comp ?? 0); add(p, "passYds", e.yds ?? 0); add(p, "passTd", e.td ?? 0);
          b.passAtt += e.att ?? 0; b.passComp += e.comp ?? 0; b.passYds += e.yds ?? 0; b.passTd += e.td ?? 0; break;
        case "rush":
          add(p, "rushAtt", e.att ?? 0); add(p, "rushYds", e.yds ?? 0); add(p, "rushTd", e.td ?? 0);
          b.rushAtt += e.att ?? 0; b.rushYds += e.yds ?? 0; b.rushTd += e.td ?? 0; break;
        case "rec": add(p, "targets", e.target ?? 0); if (e.yds != null) { add(p, "rec", 1); add(p, "recYds", e.yds); add(p, "recTd", e.td ?? 0); } break;
        case "tackle": add(p, "tackles", 1); break;
        case "sack": add(p, "sacks", 1); b.sacks += 1; break;
        case "int": add(p, "defInts", 1); b.defInts += 1; this.box[other(e.team)].ints += 1; break;
        case "fumbleLost": this.box[e.team].fumblesLost += 1; break;
        case "kr": add(p, "krAtt", 1); add(p, "krYds", e.yds ?? 0); add(p, "krTd", e.td ?? 0); break;
        case "pr": add(p, "prAtt", 1); add(p, "prYds", e.yds ?? 0); add(p, "prTd", e.td ?? 0); break;
        case "defended": add(p, "passesDefended", 1); break;
        default: break;
      }
    }
  }

  private entry(st: GameState, nm: string, dname: string, result: string, yards: number, events: GameEvent[], kind2 = "play"): PlayLog {
    return { n: this.log.length + 1, q: st.quarter, clock: st.clock, off: st.possession, down: st.down, toGo: Math.round(st.toGo / ONE),
      ballOn: Math.round(st.ballOn / ONE), kind: kind2, name: nm, defense: dname, result, yards, events };
  }
}

/** A whole AI-vs-AI game. */
export function playGame(setup: GameSetup): GameResult {
  const g = new GameSession({ ...setup, userSide: null });
  const maxPlays = setup.maxPlays ?? 400;
  let guard = 0;
  while (g.state.phase !== "final" && guard++ < maxPlays) g.stepAuto();
  return g.result();
}

/** False starts / offsides, rolled before the snap from line awareness. */
function preSnapFoul(s: GameState, offense: Roster, defense: Roster, data: GameData, ratings: (id: number) => Stats, rng: Rng): Foul | null {
  const P = data.tuning.penalties;
  const avg = (ro: Roster, slots: string[]) => slots.reduce((a, sl) => a + (ratings(ro.starters[sl]!.id).awareness ?? 60), 0) / slots.length;
  const olAw = avg(offense, ["LT", "LG", "C", "RG", "RT"]);
  const dlAw = avg(defense, ["DE1", "DT1", "DT2", "DE2"]);
  const loud = s.quarter >= 4 ? 1.2 : 1;
  if (rng.int(1000) < (P.falseStart.perMille + (P.falseStart.awarenessPer ?? 0) * (70 - olAw)) * loud) return { name: "False start", on: "O", yards: P.falseStart.yards ?? 5, kind: "preSnap" };
  if (rng.int(1000) < P.offside.perMille + (P.offside.awarenessPer ?? 0) * (70 - dlAw)) return { name: "Offside", on: "D", yards: P.offside.yards ?? 5, kind: "preSnap" };
  return null;
}
