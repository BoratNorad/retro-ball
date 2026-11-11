// One online room: two seats, lobby -> draft -> lineup -> match -> results. The server owns every
// timer and orders every action; the draft and the match are the shared deterministic engines from
// @tdf/sim (Draft / OnlineMatch) fed with the same action logs the clients replay. During a live
// play the server collects both sides' per-tick inputs, confirms them in order (a side that is
// late or gone gets "no input" after fillMs) and runs the referee copy of the play.
import type { GameData, PlayerCard } from "@tdf/shared";
import {
  OnlineMatch, autoOffense, newDraft, packInputs, personnelOf, rosterToWire, sameSquad, wireInput,
  type ClientMsg, type DefensePart, type Draft, type DraftAction, type DraftInit, type MatchAction, type MatchInit, type MatchWait,
  type OffensePart, type RoomPhase, type PlaySim, type RoomSettings, type SeatInfo, type ServerMsg, type Side, type Stats,
  type TeamSetupWire, type UserInput, type WirePick, type WireRoster,
} from "@tdf/sim";

export interface ServerEnv {
  data: GameData; pool: PlayerCard[]; byId: (id: number) => PlayerCard | undefined; ratings: (id: number) => Stats; poolHash: string;
  /** random seed source (crypto on the real server) */
  seed: () => string;
  /** wall clock in ms (injectable for tests) */
  now: () => number;
}
export interface Conn { send(m: ServerMsg): void }

export class Seat {
  conn: Conn | null = null;
  disconnectedAt = 0;
  rematch = false;
  /** the AI is playing this side (disconnected too long) */
  aiPlaying = false;
  constructor(readonly token: string, readonly side: Side, public team: TeamSetupWire) {}
  get connected() { return this.conn !== null; }
}

const other = (s: Side) => (1 - s) as Side;

export class Room {
  phase: RoomPhase = "lobby";
  readonly seats: [Seat | null, Seat | null] = [null, null];
  // draft
  private draftInit: DraftInit | null = null;
  private draft: Draft | null = null;
  private draftLog: DraftAction[] = [];
  private picks: [WirePick | null, WirePick | null] = [null, null];
  private pickDeadline = 0;
  // lineup
  private rosters: [WireRoster, WireRoster] | null = null;
  private drafted: [WireRoster, WireRoster] | null = null;
  private ready: [boolean, boolean] = [false, false];
  private lineupDeadline = 0;
  // match
  private matchInit: MatchInit | null = null;
  match: OnlineMatch | null = null;
  readonly matchLog: MatchAction[] = [];
  private wait: MatchWait = { step: "result" };
  private waitDeadline = 0;
  private offPart: OffensePart | null = null;
  private forfeit: Side | null = null;
  // live play
  private liveIdx = -1;
  private sim: PlaySim | null = null;
  private got: [(UserInput | null)[], (UserInput | null)[]] = [[], []];
  private have: [boolean[], boolean[]] = [[], []];
  private firstSeen: number[] = [];
  private confirmed: [UserInput | null, UserInput | null][] = [];
  private liveStart = 0;
  private adjusts = 0;
  // timers
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pump: ReturnType<typeof setInterval> | null = null;
  closed = false;

  constructor(readonly code: string, readonly settings: RoomSettings, readonly env: ServerEnv, readonly quick: boolean) {}

  private get O() { return this.env.data.online; }

  // ---------------------------------------------------------------- seats
  addSeat(token: string, team: TeamSetupWire): Seat | null {
    const side = this.seats[0] ? (this.seats[1] ? null : 1) : 0;
    if (side === null) return null;
    const s = new Seat(token, side as Side, team);
    this.seats[side] = s;
    return s;
  }
  attach(seat: Seat, conn: Conn) {
    seat.conn = conn;
    this.broadcastRoom();
    this.sendState(seat);
    if (this.phase === "lobby" && this.seats[0] && this.seats[1]) this.startDraft();
  }
  detach(seat: Seat) {
    if (seat.conn === null) return;
    seat.conn = null;
    seat.disconnectedAt = this.env.now();
    this.broadcastRoom();
    if (this.phase === "lobby") { this.seats[seat.side] = null; if (!this.seats[0] && !this.seats[1]) this.close(); }
  }
  /** called every second by the server: hand away sides to the AI, forfeit after the reconnect window */
  tick() {
    const now = this.env.now();
    for (const s of this.seats) {
      if (!s || s.connected) continue;
      const away = (now - s.disconnectedAt) / 1000;
      if (this.phase === "match" && away >= this.O.forfeitSeconds && this.forfeit === null) { this.forfeit = s.side; this.toResults(); }
      else if ((this.phase === "results" || this.phase === "draft" || this.phase === "lineup") && away >= this.O.forfeitSeconds && !this.seats[other(s.side)]?.connected) this.close();
    }
    if (this.phase === "results" && this.seats.every((s) => !s || !s.connected)) {
      const t = Math.max(...this.seats.map((s) => s?.disconnectedAt ?? 0));
      if ((now - t) / 1000 > this.O.forfeitSeconds) this.close();
    }
  }
  close() {
    this.closed = true;
    this.clearTimer();
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
  }

  private send(side: Side, m: ServerMsg) { this.seats[side]?.conn?.send(m); }
  private both(m: ServerMsg) { this.send(0, m); this.send(1, m); }
  private seatInfo(s: Seat | null): SeatInfo | null {
    return s ? { team: s.team, connected: s.connected, ready: this.phase === "lineup" ? this.ready[s.side] : s.rematch } : null;
  }
  private broadcastRoom() {
    for (const s of this.seats) if (s) this.send(s.side, { t: "room", code: this.code, side: s.side, phase: this.phase, settings: this.settings, seats: [this.seatInfo(this.seats[0]), this.seatInfo(this.seats[1])], quick: this.quick });
  }
  /** Everything a (re)connecting client needs to rebuild its view. */
  private sendState(seat: Seat) {
    const side = seat.side;
    if (this.draftInit) {
      this.send(side, { t: "draft", init: this.draftInit, from: 0, actions: this.draftLog, reset: true });
      if (this.phase === "draft") {
        this.send(side, { t: "pickTimer", ms: Math.max(0, this.pickDeadline - this.env.now()) });
        for (const s of [0, 1] as Side[]) if (this.picks[s]) this.send(side, { t: "picked", side: s });
      }
    }
    if (this.rosters && this.phase === "lineup") this.send(side, { t: "rosters", rosters: this.rosters, ready: this.ready, ms: Math.max(0, this.lineupDeadline - this.env.now()) });
    if (this.matchInit) {
      this.send(side, { t: "match", init: this.matchInit, from: 0, actions: this.matchLog, reset: true });
      this.send(side, { t: "sum", at: this.matchLog.length, sum: this.match!.checksum() });
      this.sendWait(side);
      if (this.wait.step === "live") this.send(side, { t: "ticks", play: this.liveIdx, from: 0, inputs: this.confirmed });
    }
    if (this.phase === "results") this.send(side, { t: "results", forfeit: this.forfeit, rematch: [Boolean(this.seats[0]?.rematch), Boolean(this.seats[1]?.rematch)] });
  }

  // ---------------------------------------------------------------- messages
  handle(seat: Seat, m: ClientMsg) {
    const side = seat.side;
    switch (m.t) {
      case "pick": if (this.phase === "draft") this.onPick(side, m.cardId, m.slot, false); return;
      case "reroll": if (this.phase === "draft") this.onReroll(side); return;
      case "lineup": if (this.phase === "lineup") this.onLineup(side, m.roster); return;
      case "off": if (this.phase === "match" && this.wait.step === "offense" && this.wait.side === side) this.onOffense(m.part); return;
      case "def": if (this.phase === "match" && this.wait.step === "defense" && this.wait.side === side) this.onDefense(m.part); return;
      case "adjust": if (this.phase === "match" && this.wait.step === "presnap" && this.adjusts++ < 40) this.act({ t: "adjust", side, ch: m.ch }); return;
      case "hardCount":
        if (this.phase === "match" && this.wait.step === "presnap" && this.match!.live && side === this.match!.live.offSide && !this.match!.live.hardCounted) {
          const r = this.act({ t: "hardCount" });
          if (r) this.afterPlay();
        }
        return;
      case "go": if (this.phase === "match" && this.wait.step === "presnap" && this.match!.live && side === this.match!.live.offSide) this.startLive(); return;
      case "in": if (this.phase === "match" && this.wait.step === "live" && m.play === this.liveIdx) this.onInputs(side, m.from, m.inputs); return;
      case "resync": this.sendState(seat); return;
      case "rematch":
        if (this.phase !== "results") return;
        seat.rematch = true;
        this.broadcastRoom();
        this.both({ t: "results", forfeit: this.forfeit, rematch: [Boolean(this.seats[0]?.rematch), Boolean(this.seats[1]?.rematch)] });
        if (this.seats[0]?.rematch && this.seats[1]?.rematch) this.startDraft();
        return;
      default: return;
    }
  }

  // ---------------------------------------------------------------- timers
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private after(ms: number, fn: () => void) { this.clearTimer(); this.timer = setTimeout(() => { this.timer = null; if (!this.closed) fn(); }, Math.max(0, ms)); }

  // ---------------------------------------------------------------- draft
  private startDraft() {
    const s = this.settings;
    for (const x of this.seats) if (x) x.rematch = false;
    this.forfeit = null;
    // two teams in the same colours: the second one wears its colours the other way round
    const t0 = this.seats[0]!.team.info, t1 = this.seats[1]!.team.info;
    if (t0.c1.toLowerCase() === t1.c1.toLowerCase()) this.seats[1]!.team = { ...this.seats[1]!.team, info: { ...t1, c1: t1.c2, c2: t1.c1 } };
    if (t0.abbr === this.seats[1]!.team.info.abbr) this.seats[1]!.team = { ...this.seats[1]!.team, info: { ...this.seats[1]!.team.info, abbr: `${this.seats[1]!.team.info.abbr.slice(0, 2)}2` } };
    this.draftInit = {
      seed: this.env.seed(), settings: { format: s.format, mirror: s.mirror, revealPassed: s.revealPassed, themed: s.themed },
      setups: [{ info: this.seats[0]!.team.info }, { info: this.seats[1]!.team.info }],
    };
    this.draft = newDraft(this.draftInit, this.env.data, this.env.pool);
    this.draftLog = [];
    this.picks = [null, null];
    this.rosters = this.drafted = null;
    this.matchInit = null; this.match = null; this.matchLog.length = 0;
    this.phase = "draft";
    this.broadcastRoom();
    this.both({ t: "draft", init: this.draftInit, from: 0, actions: [], reset: true });
    this.startPickTimer();
  }
  private startPickTimer() {
    const sec = this.settings.timer ? this.env.data.draft.pickTimerSec : this.O.idlePickSeconds;
    this.pickDeadline = this.env.now() + sec * 1000;
    this.both({ t: "pickTimer", ms: sec * 1000 });
    this.after(sec * 1000, () => {
      // the timer ran out: the coach picks for whoever hasn't
      for (const side of [0, 1] as Side[]) {
        if (this.phase !== "draft" || this.picks[side]) continue;
        const c = this.draft!.aiChoice(side, "need", false);
        this.onPick(side, c.cardId, c.slot, true);
      }
    });
  }
  private onPick(side: Side, cardId: number, slot: string | null, auto: boolean) {
    const d = this.draft!;
    if (this.picks[side] || d.done) return;
    try { d.pick(side, cardId, slot, auto); } catch (e) { this.send(side, { t: "pickRejected", msg: (e as Error).message }); return; }
    this.picks[side] = { cardId, slot, auto };
    if (!this.picks[0] || !this.picks[1]) { this.both({ t: "picked", side }); return; }
    // both in: the engine resolved the round inside the second pick(); log it as one reveal
    const a: DraftAction = { t: "reveal", picks: [this.picks[0], this.picks[1]] };
    this.draftLog.push(a);
    this.picks = [null, null];
    this.both({ t: "draft", init: this.draftInit!, from: this.draftLog.length - 1, actions: [a], reset: false });
    if (d.done) this.startLineup(); else this.startPickTimer();
  }
  private onReroll(side: Side) {
    const d = this.draft!;
    if (this.picks[side] || !d.reroll(side)) return;
    const a: DraftAction = { t: "reroll", side };
    this.draftLog.push(a);
    if (d.settings.mirror && this.picks[other(side)]) {
      // mirror mode: a reroll redraws both teams' options, so the other team's locked pick is void
      this.picks[other(side)] = null;
      this.send(other(side), { t: "pickRejected", msg: "the options were rerolled" });
    }
    this.both({ t: "draft", init: this.draftInit!, from: this.draftLog.length - 1, actions: [a], reset: false });
  }

  // ---------------------------------------------------------------- lineup
  private startLineup() {
    const d = this.draft!;
    this.drafted = [rosterToWire(d.toRoster(0)), rosterToWire(d.toRoster(1))];
    this.rosters = [this.drafted[0], this.drafted[1]];
    this.ready = [false, false];
    this.phase = "lineup";
    this.lineupDeadline = this.env.now() + this.O.lineupSeconds * 1000;
    this.broadcastRoom();
    this.both({ t: "rosters", rosters: this.rosters, ready: this.ready, ms: this.O.lineupSeconds * 1000 });
    this.after(this.O.lineupSeconds * 1000, () => this.startMatch());
  }
  private onLineup(side: Side, r: WireRoster) {
    if (this.ready[side]) return;
    const drafted = this.drafted![side];
    if (!sameSquad(r, drafted)) { this.send(side, { t: "error", msg: "that lineup uses players you did not draft" }); return; }
    this.rosters![side] = { ...r, info: drafted.info };
    this.ready[side] = true;
    this.broadcastRoom();
    this.both({ t: "rosters", rosters: this.rosters!, ready: this.ready, ms: Math.max(0, this.lineupDeadline - this.env.now()) });
    if (this.ready[0] && this.ready[1]) this.startMatch();
  }

  // ---------------------------------------------------------------- match
  private startMatch() {
    this.clearTimer();
    const s = this.settings;
    this.matchInit = { seed: this.env.seed(), rosters: this.rosters!, quarterSeconds: Math.round(s.quarterMinutes * 60), abilities: s.abilities, controlDefender: s.controlDefender };
    this.match = new OnlineMatch(this.matchInit, this.env.data, this.env.ratings, this.env.byId);
    this.matchLog.length = 0;
    this.phase = "match";
    this.broadcastRoom();
    this.both({ t: "match", init: this.matchInit, from: 0, actions: [], reset: true });
    this.next();
  }
  /** Apply an action on the referee copy, log it and send it to both clients. */
  private act(a: MatchAction) {
    const r = this.match!.apply(a);
    this.matchLog.push(a);
    this.both({ t: "match", init: this.matchInit!, from: this.matchLog.length - 1, actions: [a], reset: false });
    this.both({ t: "sum", at: this.matchLog.length, sum: this.match!.checksum() });
    return r;
  }
  private setWait(w: MatchWait, ms?: number) {
    this.wait = w;
    this.waitDeadline = ms != null ? this.env.now() + ms : 0;
    this.sendWait(0); this.sendWait(1);
  }
  private sendWait(side: Side) {
    const w = { ...this.wait, ms: this.waitDeadline ? Math.max(0, this.waitDeadline - this.env.now()) : undefined };
    // the defense's view of the personnel is for the defense only
    if (w.personnel && w.side !== side) delete w.personnel;
    this.send(side, { t: "wait", wait: w });
  }
  /** Between plays: who decides next. */
  private next() {
    const m = this.match!, s = m.session;
    // seats that dropped hand their side to the AI; returning players take it back
    for (const seat of this.seats) {
      if (!seat) continue;
      const away = !seat.connected && (this.env.now() - seat.disconnectedAt) / 1000 >= this.O.aiAfterSeconds;
      if (away !== seat.aiPlaying) { seat.aiPlaying = away; this.act({ t: "human", side: seat.side, on: !away }); }
    }
    if (s.pending().kind === "final") { this.toResults(); return; }
    this.offPart = null;
    const off = s.state.possession;
    if (!s.isHuman(off)) { this.onOffense({}); return; }
    this.setWait({ step: "offense", side: off }, this.O.callSeconds * 1000);
    this.after(this.O.callSeconds * 1000, () => this.onOffense(autoOffense(m, `${this.matchInit!.seed}:${this.matchLog.length}`)));
  }
  private onOffense(part: OffensePart) {
    const m = this.match!, s = m.session, p = s.pending();
    this.clearTimer();
    this.offPart = part;
    const def = other(s.state.possession);
    const call = part.call;
    // no defensive decision for an extra point, a kneel or a spike
    if ((p.kind === "try" && part.tryChoice !== "twoPoint") || call?.kind === "kneel" || call?.kind === "spike" || !s.isHuman(def)) { this.onDefense({}); return; }
    const personnel = p.kind === "kickoff" ? "kickoff" : call ? personnelOf(this.env.data, call) : "?";
    this.setWait({ step: "defense", side: def, personnel }, this.O.defenseSeconds * 1000);
    this.after(this.O.defenseSeconds * 1000, () => this.onDefense({}));
  }
  private onDefense(part: DefensePart) {
    this.clearTimer();
    const off = this.offPart ?? {};
    this.offPart = null;
    let r;
    try { r = this.act({ t: "snap", off, def: part }); } catch (e) {
      // a bad call from a client: fall back to the coach's
      r = this.act({ t: "snap", off: autoOffense(this.match!, `bad:${this.matchLog.length}`), def: {} });
      void e;
    }
    if (r || !this.match!.live) { this.afterPlay(); return; }
    const live = this.match!.live;
    if (live.kick) { this.startLive(); return; }
    this.adjusts = 0;
    const humanOff = this.match!.session.isHuman(live.offSide);
    const ms = humanOff ? (this.env.data.tuning.presnap.playClock + this.O.presnapExtraSeconds) * 1000 : this.O.aiPresnapSeconds * 1000;
    this.setWait({ step: "presnap", side: live.offSide }, ms);
    this.after(ms, () => {
      if (!this.match!.live) return;
      if (humanOff) { this.act({ t: "delay" }); this.afterPlay(); } else this.startLive();
    });
  }
  private startLive() {
    this.clearTimer();
    const m = this.match!;
    this.liveIdx = this.matchLog.length;
    this.sim = m.live!.remake();
    this.got = [[], []]; this.have = [[], []]; this.firstSeen = []; this.confirmed = [];
    this.liveStart = this.env.now();
    this.setWait({ step: "live", play: this.liveIdx });
    if (this.pump) clearInterval(this.pump);
    this.pump = setInterval(() => this.pumpLive(true), 25);
  }
  private onInputs(side: Side, from: number, inputs: (UserInput | null)[]) {
    const lim = this.confirmed.length + 300;
    inputs.forEach((u, k) => {
      const t = from + k;
      if (t < this.confirmed.length || t >= lim || this.have[side][t]) return;
      this.got[side][t] = wireInput(u);
      this.have[side][t] = true;
      this.firstSeen[t] ??= this.env.now();
    });
    this.pumpLive(false);
  }
  /** Confirm every tick that has both inputs (or waited long enough), step the referee play, end it. */
  private pumpLive(fill: boolean) {
    const m = this.match!, live = m.live, sim = this.sim;
    if (!live || !sim || this.wait.step !== "live") return;
    const from = this.confirmed.length;
    const now = this.env.now();
    let done = false;
    // the referee never runs ahead of real time (+ a little lead for clients sending early)
    const maxTick = Math.floor((now - this.liveStart) / (1000 / this.env.data.rules.tickHz)) + this.O.maxPredictTicks * 2;
    for (;;) {
      const t = this.confirmed.length;
      if (t >= maxTick) break;
      const absent = (s: Side) => !this.seats[s]?.connected || !m.session.isHuman(s);
      const late = fill && this.firstSeen[t] !== undefined && now - this.firstSeen[t]! >= this.O.fillMs;
      const ready = (s: Side) => this.have[s][t] || absent(s) || late;
      if (!ready(0) || !ready(1)) break;
      const offSide = live.offSide;
      let o = this.have[offSide][t] ? this.got[offSide][t] ?? null : null;
      const d = this.have[other(offSide)][t] ? this.got[other(offSide)][t] ?? null : null;
      // server overrides: a human kicker who won't kick, a human offense in motion that won't snap
      const snap = sim.snapshot();
      const hz = this.env.data.rules.tickHz;
      if (live.kick?.userKick && snap.kick?.awaitingKick && t >= this.O.kickSeconds * hz) o = { ...(o ?? {}), kick: { aim: 0, power: 850, curve: 0 } };
      if (snap.presnap && t >= this.env.data.tuning.presnap.motionMaxSeconds * hz) o = { ...(o ?? {}), snap: true };
      this.confirmed.push([o, d]);
      if (sim.step(o, d)) { done = true; break; }
    }
    if (this.confirmed.length > from) this.both({ t: "ticks", play: this.liveIdx, from, inputs: this.confirmed.slice(from) });
    if (done) {
      if (this.pump) clearInterval(this.pump);
      this.pump = null;
      this.act({ t: "play", runs: packInputs(this.confirmed), ticks: this.confirmed.length });
      this.afterPlay();
    }
  }
  private afterPlay() {
    this.clearTimer();
    this.setWait({ step: "result" });
    this.after(this.O.resultSeconds * 1000, () => this.next());
  }
  private toResults() {
    this.clearTimer();
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    this.phase = "results";
    this.setWait({ step: "final" });
    this.broadcastRoom();
    this.both({ t: "results", forfeit: this.forfeit, rematch: [false, false] });
  }
}
