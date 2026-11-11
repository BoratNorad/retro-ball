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
  applyOutcome, beforeSnap, newGame, other, prepareTry, tryOptions,
  type Foul, type GameEvent, type GameState, type PlayOutcome, type Side,
} from "./rules.js";
import type { Roster } from "./roster.js";
import {
  chooseDefense, chooseOffensePlay, type ScrimmageDecision, chooseScrimmage, chooseTry, emptyTendencies, recordDefense, recordOffense, runRate, tempoFor, timeoutFor,
  type Tendencies,
} from "./coach.js";
import { createPlay, type PlayResult, type PlaySim, type StatEvent, type Stats } from "./engine/play.js";
import { fieldGoal, kickoff, pat, punt } from "./engine/kicks.js";

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
  punts: number; puntYds: number;
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
  fgAtt: 0, fgMade: 0, fgByDist: {}, patAtt: 0, patMade: 0, twoAtt: 0, twoMade: 0, punts: 0, puntYds: 0,
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
  | { kind: "punt" } | { kind: "fieldGoal" } | { kind: "kneel" } | { kind: "spike" };

export interface SnapOptions {
  userCall?: UserCall;               // human offense
  tryChoice?: "pat" | "twoPoint";    // human try decision
  defCall?: DefenseCall;             // human defense
  defFront?: string;                 // human defense: front (default: the AI's answer to the personnel)
  /** human defense: control one defender during the play */
  controlDefender?: boolean;
  timeout?: boolean;                 // human calls a timeout before this snap
}

/** A live scrimmage play in progress. */
export interface LivePlay {
  sim: PlaySim; offSide: Side; userOffense: boolean;
  play: OffensePlay; call: DefenseCall; twoPoint: boolean;
  formation: string; personnel: string; front: string; userDefense: boolean;
  /** internal bookkeeping for finish() */
  ctx: { before: GameState; at: GameState };
}
export interface PlaySummary { entry: PlayLog; events: GameEvent[]; state: GameState }
export type SnapResult = { live: LivePlay } | { done: PlaySummary };

export class GameSession {
  readonly data: GameData;
  readonly teams: [Roster, Roster];
  readonly userSide: Side | null;
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
    this.userSide = setup.userSide ?? null;
    this.seed = setup.seed;
    this.cfg = setup.quarterSeconds ? { ...setup.data.rules, quarterSeconds: setup.quarterSeconds } : setup.data.rules;
    this.rng = new Rng(setup.seed);
    this.state = newGame(this.cfg, this.rng.int(2) as Side);
    this.mid = fx(this.data.tuning.field.width / 2);
    this.hashGap = fx(this.data.tuning.field.hashHalfGap);
    this.ballX = this.mid;
  }

  get rules() { return this.cfg; }
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
      const k = kickoff(kin, s.freeKickFrom);
      this.ballX = this.mid;
      return { done: this.apply(before, s, k.outcome, k.stats, "Kickoff", "", k.log.join(", "), "kickoff") };
    }
    if (s.phase === "try") {
      const choice = userOff && opts.tryChoice ? opts.tryChoice : chooseTry(s, tryOptions(s, cfg));
      s = prepareTry(s, choice, cfg);
      this.state = s;
      if (choice === "pat") {
        const k = pat(kin, s.ballOn);
        this.box[off].patAtt++; if (k.outcome.good) this.box[off].patMade++;
        this.ballX = this.mid;
        return { done: this.apply(before, s, k.outcome, [], "Extra point", "", k.log.join(", "), "try") };
      }
      const goal = data.offense.plays.filter((p) => p.weight > 0 && !p.tags.includes("deep") && !p.tags.includes("screen"));
      const p0 = goal[rng.int(goal.length)]!;
      let pc = { play: p0, formation: p0.formations[0]!, personnel: data.formations.offense.find((f) => f.id === p0.formations[0])!.personnel[0]!, flip: rng.int(2) === 1 };
      if (userOff && opts.userCall?.kind === "play") pc = this.userPlayCall(opts.userCall);
      let dc = chooseDefense(s, data, rng, pc.personnel, defense, this.tend[off]);
      if (!userOff && this.userSide !== null && opts.defCall) dc = { call: opts.defCall, front: opts.defFront ?? dc.front };
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
      : this.preview ?? chooseScrimmage(s, offense, defense, data, ratings, rng, this.tend[off], this.tend[def]);
    this.preview = null;
    if (dec.kind === "play" && !userOff && this.userSide !== null && opts.defCall) dec = { ...dec, call: opts.defCall, front: opts.defFront ?? dec.front };
    if (dec.kind === "punt") {
      const k = punt(kin, s.ballOn);
      this.box[off].punts++; this.box[off].puntYds += Math.round(F.min(k.outcome.endY, fx(100)) / ONE - s.ballOn / ONE);
      this.ballX = this.mid;
      return { done: this.apply(before, s, k.outcome, k.stats, "Punt", "", k.log.join(", ")) };
    }
    if (dec.kind === "fieldGoal") {
      const k = fieldGoal(kin, s.ballOn);
      this.box[off].fgAtt++; if (k.outcome.good) this.box[off].fgMade++;
      const bucket = k.dist < 30 ? "<30" : k.dist < 40 ? "30-39" : k.dist < 50 ? "40-49" : "50+";
      const fb = (this.box[off].fgByDist[bucket] ??= [0, 0]); fb[1]++; if (k.outcome.good) fb[0]++;
      this.ballX = this.mid;
      return { done: this.apply(before, s, k.outcome, k.stats, `${k.dist}-yd field goal`, "", k.log.join(", ")) };
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
    return { live: this.start(s, before, dec, dec, opts, false) };
  }

  /** The AI offense's next call, decided now so a human defense can see the personnel group come on
   *  the field (as in real football) before choosing its own call. snap() then uses this decision. */
  previewAiOffense(): ScrimmageDecision | null {
    const s = this.state;
    if (s.phase !== "play" || this.isUserOffense()) return null;
    const off = s.possession, def = other(off);
    this.preview ??= chooseScrimmage(s, this.teams[off], this.teams[def], this.data, this.ratings, this.rng, this.tend[off], this.tend[def]);
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
  private start(s: GameState, before: GameState, pc: { play: OffensePlay; formation: string; personnel: string; flip: boolean },
    dc: { call: DefenseCall; front: string }, opts: SnapOptions, twoPoint: boolean): LivePlay {
    const { data, rng, ratings, teams } = this;
    const off = s.possession, def = other(off);
    const userOff = this.userSide === off;
    const userDefense = !userOff && this.userSide === def && Boolean(opts.controlDefender);
    if (twoPoint) this.ballX = this.mid;
    const C = data.coach.tendency;
    const paBiteMult = C.paBiteBase + C.paBitePerRunRate * runRate(this.tend[off], data);
    const sim = createPlay({
      data, ratings, offense: teams[off], defense: teams[def], offSide: off, ballOn: s.ballOn, ballX: this.ballX, toGo: s.toGo,
      play: pc.play, formation: pc.formation, personnel: pc.personnel, call: dc.call, front: dc.front, flip: pc.flip, rng,
      twoPoint, userOffense: userOff, userDefense, paBiteMult,
    });
    return { sim, offSide: off, userOffense: userOff, userDefense, play: pc.play, call: dc.call, formation: pc.formation, personnel: pc.personnel,
      front: dc.front, twoPoint, ctx: { before, at: s } };
  }

  /** Apply a finished live play. */
  finish(live: LivePlay): PlaySummary {
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
