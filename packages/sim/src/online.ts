// Online play (M8): everything both players and the server must agree on, as plain serializable
// actions. A match (or a draft) is a pure function of its init + the server-ordered action log, so
// the server (referee) and both clients run the same code on the same log and stay in lockstep;
// a reconnecting client just replays the log. Live plays are per-tick inputs for both sides; the
// client predicts the other side's input and re-simulates the play from tick 0 when a confirmed
// input differs (a play is a few hundred cheap ticks, so a full re-simulation is the rollback).
import type { GameData, PlayerCard } from "@tdf/shared";
import { Draft, type DraftSettings, type DraftTeamSetup, type RoundReveal } from "./draft.js";
import { GameSession, type LivePlay, type PlaySummary, type SnapOptions, type UserCall } from "./game.js";
import { chooseScrimmage } from "./coach.js";
import { hashString, Rng } from "./rng.js";
import { other, type Side } from "./rules.js";
import type { OffenseStyle, Roster, TeamInfo } from "./roster.js";
import type { PlaySim, PreSnapDefense, PreSnapOffense, Stats, UserInput } from "./engine/play.js";
import type { ArmedActive } from "./engine/abilities.js";

// ---------------------------------------------------------------- rosters on the wire
export interface WireRoster {
  info: TeamInfo; starters: Record<string, number>; depth: Record<string, number>; bench: number[];
  baseFront?: string; style?: OffenseStyle; defStyle?: string; kr?: number; pr?: number;
}
export function rosterToWire(r: Roster): WireRoster {
  const ids = (o: Record<string, PlayerCard>) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, c.id]));
  const w: WireRoster = { info: r.info, starters: ids(r.starters), depth: ids(r.depth), bench: r.bench.map((c) => c.id), baseFront: r.baseFront, style: r.style, kr: r.kr, pr: r.pr };
  if (r.defStyle) w.defStyle = r.defStyle;
  return w;
}
export function rosterFromWire(w: WireRoster, byId: (id: number) => PlayerCard | undefined): Roster {
  const card = (id: number) => { const c = byId(id); if (!c) throw new Error(`unknown player ${id}`); return c; };
  const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, id]) => [k, card(id)]));
  const r: Roster = { info: w.info, starters: map(w.starters), depth: map(w.depth), bench: w.bench.map(card) };
  if (w.baseFront) r.baseFront = w.baseFront;
  if (w.style) r.style = w.style;
  if (w.defStyle) r.defStyle = w.defStyle;
  if (w.kr != null) r.kr = w.kr;
  if (w.pr != null) r.pr = w.pr;
  return r;
}
/** Every player id on a roster (starters, sub packages, bench). */
export function rosterIds(r: WireRoster): Set<number> {
  return new Set([...Object.values(r.starters), ...Object.values(r.depth), ...r.bench]);
}
/** A lineup edit is legal when it uses exactly the drafted players (no one added or dropped). */
export function sameSquad(a: WireRoster, b: WireRoster): boolean {
  const squad = (r: WireRoster) => new Set([...Object.values(r.starters), ...r.bench]);
  const x = squad(a), y = squad(b);
  return x.size === y.size && [...x].every((id) => y.has(id)) && [...rosterIds(a)].every((id) => y.has(id))
    && Object.values(a.starters).length === new Set(Object.values(a.starters)).size;
}
// ---------------------------------------------------------------- match actions
export type WireCall =
  | { kind: "play"; play: string; flip: boolean; formation?: string; personnel?: string }
  | { kind: "punt" } | { kind: "fieldGoal" } | { kind: "kneel" } | { kind: "spike" }
  | { kind: "fake"; play: string; as?: "punt" | "fieldGoal" };
/** What the offense (or kicking team) decided before the snap. */
export interface OffensePart {
  call?: WireCall; tryChoice?: "pat" | "twoPoint"; kickoffKind?: "kickoff" | "squib" | "onside";
  active?: ArmedActive | null; timeout?: boolean;
}
/** What the defense (or receiving team) decided before the snap. */
export interface DefensePart {
  call?: string; front?: string; stDefense?: "block" | "safe" | "normal"; returnSide?: "L" | "M" | "R";
  active?: ArmedActive | null; timeout?: boolean;
}
/** A pre-snap change by one side. */
export interface WireAdjust {
  play?: string; formation?: string; flip?: boolean; call?: string; front?: string;
  preOff?: PreSnapOffense; preDef?: PreSnapDefense; active?: ArmedActive | null;
}
/** A run of identical per-tick inputs: [first tick, count, offense input, defense input]. */
export type InputRun = [number, number, UserInput | null, UserInput | null];
export type MatchAction =
  | { t: "snap"; off: OffensePart; def: DefensePart }
  | { t: "adjust"; side: Side; ch: WireAdjust }
  | { t: "hardCount" }
  | { t: "delay" }
  /** the live play is over: every tick's inputs (both sides), and how many ticks it ran */
  | { t: "play"; runs: InputRun[]; ticks: number }
  /** a side's player left (AI takes over) or came back */
  | { t: "human"; side: Side; on: boolean };

export interface MatchInit {
  seed: string; rosters: [WireRoster, WireRoster]; quarterSeconds: number; abilities: boolean; controlDefender: boolean;
}

const sameInput = (a: UserInput | null | undefined, b: UserInput | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Pack per-tick inputs into runs. */
export function packInputs(ticks: [UserInput | null, UserInput | null][]): InputRun[] {
  const out: InputRun[] = [];
  ticks.forEach(([o, d], t) => {
    const last = out[out.length - 1];
    if (last && sameInput(last[2], o) && sameInput(last[3], d) && last[0] + last[1] === t) last[1]++;
    else out.push([t, 1, o, d]);
  });
  return out;
}
export function unpackInputs(runs: InputRun[], ticks: number): [UserInput | null, UserInput | null][] {
  const out: [UserInput | null, UserInput | null][] = Array.from({ length: ticks }, () => [null, null]);
  for (const [t0, n, o, d] of runs) for (let k = 0; k < n && t0 + k < ticks; k++) out[t0 + k] = [o, d];
  return out;
}

/** Normalise a side's input before it goes on the wire: run directions snapped to 32 headings (so
 *  runs of ticks compress and both sides see identical integers), empty inputs = null. */
export function wireInput(u: UserInput | null | undefined): UserInput | null {
  if (!u) return null;
  const out: UserInput = {};
  if (u.move && (u.move.x !== 0 || u.move.y !== 0)) {
    const a = Math.round((Math.atan2(u.move.y, u.move.x) / (2 * Math.PI)) * 32);
    out.move = { x: DIRS[((a % 32) + 32) % 32]![0], y: DIRS[((a % 32) + 32) % 32]![1] };
  }
  if (u.throwAt) out.throwAt = { x: Math.round(u.throwAt.x), y: Math.round(u.throwAt.y), power: Math.round(u.throwAt.power * 1000) / 1000 };
  if (u.action) out.action = u.action;
  if (u.kick) out.kick = { aim: Math.round(u.kick.aim), power: Math.round(u.kick.power), curve: Math.round(u.kick.curve) };
  if (u.snap) out.snap = true;
  return Object.keys(out).length ? out : null;
}
// unit vectors for 32 headings, as fixed-point integers (computed once, identical everywhere: float
// trig is fine here because it only runs on the client before the input is sent)
const DIRS: [number, number][] = Array.from({ length: 32 }, (_, k) => [Math.round(Math.cos((k / 32) * 2 * Math.PI) * 65536), Math.round(Math.sin((k / 32) * 2 * Math.PI) * 65536)]);

function toUserCall(data: GameData, c: WireCall): UserCall {
  const play = (id: string) => { const p = data.offense.plays.find((x) => x.id === id); if (!p) throw new Error(`unknown play ${id}`); return p; };
  if (c.kind === "play") return { kind: "play", play: play(c.play), flip: c.flip, formation: c.formation, personnel: c.personnel };
  if (c.kind === "fake") return { kind: "fake", play: play(c.play), as: c.as };
  return c;
}
/** The personnel group the defense sees come on the field for this call (kick units show as the kick). */
export function personnelOf(data: GameData, c: WireCall): string {
  if (c.kind !== "play") return c.kind === "fake" ? c.as ?? "punt" : c.kind;
  const p = data.offense.plays.find((x) => x.id === c.play);
  const formation = c.formation && p?.formations.includes(c.formation) ? c.formation : p?.formations[0];
  const f = data.formations.offense.find((x) => x.id === formation);
  return c.personnel && f?.personnel.includes(c.personnel) ? c.personnel : f?.personnel[0] ?? "11";
}

function snapOptions(data: GameData, s: GameSession, off: OffensePart, def: DefensePart): SnapOptions {
  const o: SnapOptions = {};
  const offSide = s.state.possession, defSide = other(offSide);
  if (off.call) o.userCall = toUserCall(data, off.call);
  if (off.tryChoice) o.tryChoice = off.tryChoice;
  if (off.kickoffKind) o.kickoffKind = off.kickoffKind;
  if (off.active !== undefined) o.offActive = off.active;
  if (def.call) { const c = data.defense.calls.find((x) => x.id === def.call); if (c) o.defCall = c; }
  if (def.front) o.defFront = def.front;
  if (def.stDefense) o.stDefense = def.stDefense;
  if (def.returnSide) o.returnSide = def.returnSide;
  if (def.active !== undefined) o.defActive = def.active;
  if (off.timeout) o.timeoutBy = offSide; else if (def.timeout) o.timeoutBy = defSide;
  return o;
}

/** One online match: a GameSession driven only by MatchActions. Used by the server (referee) and
 *  by both clients. */
export class OnlineMatch {
  readonly session: GameSession;
  readonly data: GameData;
  live: LivePlay | null = null;
  /** actions applied so far */
  applied = 0;
  constructor(init: MatchInit, data: GameData, ratings: (id: number) => Stats, byId: (id: number) => PlayerCard | undefined) {
    this.data = data;
    this.session = new GameSession({
      data, ratings, teams: [rosterFromWire(init.rosters[0], byId), rosterFromWire(init.rosters[1], byId)], seed: init.seed,
      quarterSeconds: init.quarterSeconds, abilities: init.abilities, humans: [true, true], controlDefender: init.controlDefender,
    });
  }
  /** Apply the next action. Returns the finished play's summary (if this action ended one). */
  apply(a: MatchAction): PlaySummary | null {
    this.applied++;
    const s = this.session;
    switch (a.t) {
      case "snap": {
        if (this.live) throw new Error("snap during a live play");
        const r = s.snap(snapOptions(this.data, s, a.off, a.def));
        if ("done" in r) return r.done;
        this.live = r.live;
        return null;
      }
      case "adjust": {
        if (!this.live) return null;
        const offSide = this.live.offSide, mine = a.side === offSide ? "O" : "D";
        const ch = a.ch, d = this.data;
        const out: Parameters<GameSession["adjust"]>[1] = {};
        if (mine === "O") {
          if (ch.play) { const p = d.offense.plays.find((x) => x.id === ch.play); if (p) out.play = p; }
          if (ch.formation) out.formation = ch.formation;
          if (ch.flip !== undefined) out.flip = ch.flip;
          if (ch.preOff) out.preOff = ch.preOff;
        } else {
          if (ch.call) { const c = d.defense.calls.find((x) => x.id === ch.call); if (c) out.call = c; }
          if (ch.front) out.front = ch.front;
          if (ch.preDef) out.preDef = ch.preDef;
        }
        if (ch.active !== undefined) { out.active = ch.active; out.activeFor = mine; }
        this.live = s.adjust(this.live, out);
        return null;
      }
      case "hardCount": {
        if (!this.live) return null;
        const r = s.hardCount(this.live);
        if (r) this.live = null;
        return r;
      }
      case "delay": {
        if (!this.live) return null;
        const r = s.delayOfGame(this.live);
        this.live = null;
        return r;
      }
      case "play": {
        if (!this.live) throw new Error("no live play");
        const sim = runPlay(this.live, unpackInputs(a.runs, a.ticks));
        const r = s.finish({ ...this.live, sim });
        this.live = null;
        return r;
      }
      case "human": s.setHuman(a.side, a.on); return null;
    }
  }
  /** A short checksum of the game state (both sims must agree after every play). */
  checksum(): string {
    const s = this.session;
    return hashString(JSON.stringify([s.state, s.momentum, s.log.length, s.log[s.log.length - 1]?.result ?? ""])).toString(16).padStart(8, "0");
  }
}

/** Run a live play from tick 0 with these inputs (one [offense, defense] pair per tick). */
export function runPlay(live: LivePlay, inputs: [UserInput | null, UserInput | null][]): PlaySim {
  const sim = live.remake();
  for (const [o, d] of inputs) if (sim.step(o, d)) break;
  return sim;
}

/** Server-side default when a player's call timer runs out: the coach's call, decided with its own
 *  random stream (so it never touches the shared game state) and sent as an explicit call. */
export function autoOffense(m: OnlineMatch, salt: string): OffensePart {
  const p = m.session.pending();
  if (p.kind === "kickoff") return { kickoffKind: "kickoff" };
  if (p.kind === "try") return { tryChoice: p.options.includes("pat") ? "pat" : "twoPoint", ...(p.options.includes("pat") ? {} : autoPlay(m, salt)) };
  return autoPlay(m, salt);
}
function autoPlay(m: OnlineMatch, salt: string): OffensePart {
  const s = m.session, st = s.state, off = st.possession;
  const dec = chooseScrimmage(st, s.teams[off], s.teams[other(off)], m.data, s.ratings, new Rng(`auto:${salt}`), s.tend[off], s.tend[other(off)], (b) => s.kickChanceFor("fieldGoal", b));
  if (dec.kind === "play") return { call: { kind: "play", play: dec.play.id, flip: dec.flip, formation: dec.formation, personnel: dec.personnel } };
  if (dec.kind === "fake") return { call: { kind: "fake", play: dec.play.id, as: dec.as } };
  return { call: { kind: dec.kind } };
}

// ---------------------------------------------------------------- draft actions
export interface DraftInit { seed: string; settings: Partial<DraftSettings>; setups: [DraftTeamSetup, DraftTeamSetup] }
export interface WirePick { cardId: number; slot: string | null; auto: boolean }
export type DraftAction =
  | { t: "reroll"; side: Side }
  /** both teams' picks for the round, revealed together */
  | { t: "reveal"; picks: [WirePick, WirePick] };
export function newDraft(init: DraftInit, data: GameData, pool: readonly PlayerCard[]): Draft {
  return new Draft(data, pool, init.setups, init.seed, init.settings);
}
export function applyDraftAction(d: Draft, a: DraftAction): RoundReveal | null {
  if (a.t === "reroll") { d.reroll(a.side); return null; }
  d.pick(0, a.picks[0].cardId, a.picks[0].slot, a.picks[0].auto);
  return d.pick(1, a.picks[1].cardId, a.picks[1].slot, a.picks[1].auto);
}
