// Online match controller (M8). Same screens as offline, but every decision goes to the server and
// only takes effect when it comes back in the shared action log; live plays run locally at 30 Hz
// with rollback: my input is applied `inputDelayTicks` late, the opponent's is predicted (his last
// confirmed run direction, no one-shot actions), and when the server's confirmed inputs differ from
// what was predicted the play is re-simulated from tick 0 (cheap: a play is a few hundred ticks).
import type { DefenseCall } from "@tdf/shared";
import {
  unpackInputs, wireInput,
  type DefensePart, type GameSession, type LivePlay, type MatchAction, type MatchWait, type OffensePart, type PlaySim,
  type PlaySnapshot, type PlaySummary, type Side, type UserCall, type UserInput, type WireAdjust, type WireCall,
} from "@tdf/sim";
import type { ClientData } from "../data.js";
import type { MatchListener, NetClient } from "../net/client.js";
import { Controller } from "./controller.js";

const TICK_MS = 1000 / 30;
const DEBUG = (() => { try { return localStorage.getItem("tdf.netdebug") === "1"; } catch { return false; } })();
const other = (s: Side) => (1 - s) as Side;

function wireCall(c: UserCall): WireCall {
  if (c.kind === "play") return { kind: "play", play: c.play.id, flip: c.flip, formation: c.formation, personnel: c.personnel };
  if (c.kind === "fake") return { kind: "fake", play: c.play.id, as: c.as };
  return { kind: c.kind };
}
/** The opponent's predicted input: keep steering the way he was, never repeat a one-shot action. */
const predict = (u: UserInput | null): UserInput | null => (u?.move ? { move: u.move } : null);
const same = (a: UserInput | null | undefined, b: UserInput | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class NetController extends Controller implements MatchListener {
  readonly net: NetClient;
  /** live play state */
  private playIdx = -1;
  private sim: PlaySim | null = null;
  private simTick = 0;
  private confirmed: [UserInput | null, UserInput | null][] = [];
  private used: [UserInput | null, UserInput | null][] = [];
  private mine = new Map<number, UserInput | null>();
  private nextSample = 0;
  private liveOn = false;
  private lastOpp: UserInput | null = null;
  rollbacks = 0;

  constructor(cd: ClientData, net: NetClient) {
    const m = net.match!;
    super(cd, m.session.teams, m.session.rules.quarterSeconds / 60, { session: m.session as GameSession });
    this.net = net;
    this.mySide = net.side;
    // ranked: no trajectory guide (the spec's "off in ranked")
    this.aimGuide = !net.room?.ranked || cd.data.modes.ranked.trajectoryGuide;
    net.listener = this;
    // pick up wherever the match is (start, or a reconnect mid-game)
    if (m.live) this.adoptLive(false);
    if (net.wait) this.onWait(net.wait);
  }
  private get m() { return this.net.match!; }
  private get mineO() { return this.m.live ? this.m.live.offSide === this.userSide : this.state.possession === this.userSide; }

  // ---------------------------------------------------------------- server events
  onAction(a: MatchAction, summary: PlaySummary | null) {
    if (DEBUG) console.log("[net] action", a.t, summary ? "summary" : "", this.m.live ? "live" : "");
    if (a.t === "play") {
      const reveal = this.revealText();
      if (this.live && summary) this.record(this.live, unpackInputs(a.runs, a.ticks), summary);
      this.stopLive();
      this.live = null;
      if (summary) this.showResult(summary, reveal);
      return;
    }
    if (summary) {
      // kneel, spike, a pre-snap foul, a hard count that drew them offside, delay of game, quarter end
      this.stopLive();
      this.live = null;
      this.showResult(summary, a.t === "hardCount" ? "hard count" : undefined);
      return;
    }
    if (a.t === "snap" && this.m.live) { this.adoptLive(true); return; }
    if (a.t === "hardCount" && this.m.live) { this.live = this.view(this.m.live, this.live?.sim ?? this.m.live.sim); this.set({ toast: this.mineO ? "Nobody bit on the hard count" : null, lineup: this.ui.lineup + 1 }); return; }
    if (a.t === "adjust" && this.m.live) { this.adoptLive(false); this.set({ lineup: this.ui.lineup + 1 }); }
  }
  onWait(w: MatchWait) {
    if (DEBUG) console.log("[net] wait", JSON.stringify(w), this.ui.mode);
    const me = this.userSide;
    const secs = w.ms != null ? w.ms / 1000 : null;
    this.set({ netClock: secs });
    if (w.step === "final") { this.set({ mode: "final", live: false, toast: null }); return; }
    if (w.step === "live") { if (w.play !== undefined) this.beginLive(w.play); return; }
    if (w.step === "presnap") {
      if (this.live && !this.live.kick && this.ui.mode !== "presnap") this.set({ mode: "presnap", playClock: secs ?? this.cd.data.tuning.presnap.playClock });
      else if (secs != null) this.set({ playClock: secs });
      return;
    }
    if (w.step === "result") return;
    // a call is due: mine, or the opponent's (the result banner finishes first, then advance())
    if (this.bannerUp) return;
    this.advance();
  }
  onTicks(play: number, from: number, inputs: [UserInput | null, UserInput | null][]) {
    if (play !== this.playIdx || !this.sim) return;
    let rewind = -1;
    inputs.forEach((pair, k) => {
      const t = from + k;
      if (t < this.confirmed.length) return;
      this.confirmed[t] = pair;
      const u = this.used[t];
      if (u && (!same(u[0], pair[0]) || !same(u[1], pair[1])) && rewind < 0) rewind = t;
    });
    const opp = this.confirmed[this.confirmed.length - 1]?.[this.mineO ? 1 : 0] ?? null;
    this.lastOpp = opp;
    if (rewind >= 0) this.resimulate();
  }

  // ---------------------------------------------------------------- decisions -> server
  private bannerUp = false;
  protected override showResult(sum: PlaySummary, reveal?: string) { this.bannerUp = true; super.showResult(sum, reveal); }
  override advance() {
    this.bannerUp = false;
    const w = this.net.wait;
    this.live = this.m.live ? this.view(this.m.live, this.sim ?? this.m.live.sim) : null;
    if (!w || this.session.pending().kind === "final") { if (this.session.pending().kind === "final") this.set({ mode: "final", live: false }); return; }
    const me = this.userSide, p = this.session.pending();
    if (w.step === "presnap" && this.live) { this.set({ mode: "presnap", live: false, userOffense: this.mineO }); return; }
    if (w.step === "live" || w.step === "result") return;
    if (w.side !== me) {
      const what = w.step === "offense" ? (p.kind === "kickoff" ? "is kicking off" : "is calling a play") : "is calling the defense";
      this.set({ mode: "waiting", live: false, waitText: `${this.team(other(me)).abbr} ${what}…`, toast: null });
      return;
    }
    this.set({ waitText: null });
    if (w.step === "offense") {
      if (p.kind === "kickoff") { this.set({ mode: "callKickoff", live: false, userOffense: true, toast: null }); return; }
      if (p.kind === "try" && this.pendingTry !== "twoPoint") { this.set({ mode: "callTry", live: false, userOffense: true, tryForTwo: !p.options.includes("pat") }); return; }
      this.set({ mode: "callOffense", live: false, userOffense: true, fg: this.fgInfo() });
      return;
    }
    // defense
    if (p.kind === "kickoff") { this.set({ mode: "callReturn", live: false, userOffense: false, toast: null }); return; }
    if (w.personnel === "punt" || w.personnel === "fieldGoal") { this.stKind = w.personnel; this.set({ mode: "callST", live: false, userOffense: false, toast: null }); return; }
    this.set({ mode: "callDefense", live: false, userOffense: false, preview: w.personnel && w.personnel !== "?" ? { personnel: w.personnel } : null });
  }
  private sendOff(part: OffensePart) { this.net.send({ t: "off", part }); this.set({ mode: "waiting", waitText: "Lining up…", toast: null }); }
  private sendDef(part: DefensePart) { this.net.send({ t: "def", part }); this.set({ mode: "waiting", waitText: "Lining up…", toast: null }); }
  override callOffense(call: UserCall, timeout = this.takeTimeout()) {
    const two = this.pendingTry === "twoPoint" && call.kind === "play";
    this.pendingTry = null;
    this.sendOff({ call: wireCall(call), timeout, active: this.takeActive(), ...(two ? { tryChoice: "twoPoint" as const } : {}) });
  }
  override callTry(choice: "pat" | "twoPoint") {
    if (choice === "pat") { this.sendOff({ tryChoice: "pat", active: this.takeActive() }); return; }
    this.pendingTry = "twoPoint";
    this.set({ mode: "callOffense", userOffense: true, fg: null });
  }
  override kickoff(kind: "kickoff" | "squib" | "onside") { this.sendOff({ kickoffKind: kind, active: this.takeActive() }); }
  override callDefense(call: DefenseCall | null, front: string | null = null, timeout = this.takeTimeout()) {
    this.sendDef({ ...(call ? { call: call.id, front: front ?? undefined } : {}), timeout, active: this.takeActive() });
  }
  override receiveKick(side: "L" | "M" | "R") { this.sendDef({ returnSide: side, active: this.takeActive() }); }
  override callST(mode: "block" | "safe" | "normal", side: "L" | "M" | "R" = "M") { this.sendDef({ stDefense: mode, returnSide: side, timeout: this.takeTimeout(), active: this.takeActive() }); }
  override adjust(ch: Parameters<GameSession["adjust"]>[1]) {
    if (!this.live || this.ui.mode !== "presnap") return;
    const w: WireAdjust = {};
    if (ch.play) w.play = ch.play.id;
    if (ch.formation) w.formation = ch.formation;
    if (ch.flip !== undefined) w.flip = ch.flip;
    if (ch.call) w.call = ch.call.id;
    if (ch.front) w.front = ch.front;
    if (ch.preOff) w.preOff = ch.preOff;
    if (ch.preDef) w.preDef = ch.preDef;
    if (ch.active !== undefined) w.active = ch.active;
    this.net.send({ t: "adjust", ch: w });
  }
  override hardCount() { if (this.live && this.mineO) this.net.send({ t: "hardCount" }); }
  override snapBall() {
    if (!this.live) return;
    if (this.liveOn) { if (this.mineO && this.cur?.presnap) this.input.snap = true; return; }
    if (this.ui.mode === "presnap" && this.mineO) this.net.send({ t: "go" });
  }
  override fastForward() { /* not online */ }
  override callTimeout() { this.timeoutQueued = true; this.set({ toast: "Timeout (at your next call)" }); }

  // ---------------------------------------------------------------- live play with rollback
  /** The play as this browser sees it: the human flags say what *I* control. */
  private view(l: LivePlay, sim: PlaySim): LivePlay {
    const o = this.mineO;
    return {
      ...l, sim, userOffense: o, userDefense: !o && l.userDefense,
      kick: l.kick && { ...l.kick, userKick: o && l.kick.userKick, userReturn: !o && l.kick.userReturn },
    };
  }
  /** Mask snapshot fields that belong to the other player's controls. */
  private mask(s: PlaySnapshot): PlaySnapshot {
    const o = this.mineO;
    if (o) return { ...s, userDefender: -1, kick: s.kick && { ...s.kick, userPlayer: -1, canFairCatch: false, canKneel: false }, userCarrier: s.kick ? false : s.userCarrier };
    return { ...s, qbCanThrow: s.qbCanThrow, userCarrier: s.kick ? s.userCarrier : false, canKeep: false };
  }
  /** A new or re-lined-up play from the log. */
  private adoptLive(fresh: boolean) {
    const l = this.m.live!;
    const sim = l.remake();
    this.live = this.view(l, sim);
    this.prev = this.cur = this.mask(sim.snapshot());
    this.acc = 0;
    this.input = {};
    if (!fresh) return;
    this.optionKeep = false;
    const s0 = this.cur;
    const common = { toast: null, preview: null, userDefense: this.live.userDefense, userDefender: s0.userDefender, canKeep: s0.canKeep, lineup: this.ui.lineup + 1, waitText: null };
    if (l.kick) {
      if (this.live.kick!.userKick) this.set({ mode: "kick", live: false, userOffense: true, fast: false, ...common });
      else this.set({ mode: "live", live: true, userOffense: this.mineO, fast: false, ...common });
      return;
    }
    this.set({ mode: "presnap", live: false, userOffense: this.mineO, fast: false, playClock: this.cd.data.tuning.presnap.playClock, ...common });
  }
  private beginLive(play: number) {
    if (this.playIdx === play && this.liveOn) return;
    if (!this.m.live) return;
    this.playIdx = play;
    const l = this.m.live;
    this.sim = l.remake();
    this.live = this.view(l, this.sim);
    this.simTick = 0; this.confirmed = []; this.used = []; this.mine = new Map(); this.nextSample = 0; this.lastOpp = null;
    this.liveOn = true;
    this.prev = this.cur = this.mask(this.sim.snapshot());
    this.acc = 0;
    // my first ticks (before my delayed input arrives) carry no input
    const D = this.cd.data.online.inputDelayTicks;
    const first: (UserInput | null)[] = [];
    for (let t = 0; t < D; t++) { this.mine.set(t, null); first.push(null); }
    this.nextSample = D;
    this.net.send({ t: "in", play, from: 0, inputs: first });
    // in motion: the line-up stays on screen until the offense snaps it (tap again)
    if (this.ui.mode !== "kick") this.set(this.cur.presnap ? { mode: "presnap", live: false, userOffense: this.mineO } : { mode: "live", live: true, userOffense: this.mineO });
    // inputs the server already confirmed (a reconnect in the middle of the play)
    const t = this.net.ticks;
    if (t.play === play && t.inputs.length) this.onTicks(play, 0, t.inputs);
  }
  private stopLive() { this.liveOn = false; this.sim = null; this.playIdx = -1; }

  /** The inputs for tick t: confirmed if the server has them, else mine + the opponent predicted. */
  private inputsFor(t: number): [UserInput | null, UserInput | null] {
    const c = this.confirmed[t];
    if (c) return c;
    const myIn = this.mine.get(t) ?? null, opp = predict(this.lastOpp);
    return this.mineO ? [myIn, opp] : [opp, myIn];
  }
  private resimulate() {
    if (!this.m.live) return;
    this.rollbacks++;
    const sim = this.m.live.remake();
    const n = this.simTick;
    this.used = [];
    for (let t = 0; t < n; t++) {
      const pair = this.inputsFor(t);
      this.used[t] = pair;
      if (sim.step(pair[0], pair[1])) break;
    }
    this.sim = sim;
    this.live = this.view(this.m.live, sim);
    this.prev = this.cur = this.mask(sim.snapshot());
  }

  override frame(dtMs: number) {
    if (this.ui.mode === "presnap" && !this.liveOn) { this.presnapFrame(dtMs); return; }
    if (!this.liveOn || !this.sim || (this.ui.mode !== "live" && this.ui.mode !== "kick" && this.ui.mode !== "presnap")) return;
    const O = this.cd.data.online;
    this.acc += Math.min(dtMs, 100);
    while (this.acc >= TICK_MS) {
      // too far ahead of what the server has confirmed: wait for it
      if (this.simTick - this.confirmed.length >= O.maxPredictTicks) { this.acc = 0; break; }
      this.acc -= TICK_MS;
      // sample my input now, for a few ticks from now
      if (this.optionKeep && this.cur?.canKeep && !this.input.action) this.input.action = "keep";
      const mv = this.input.move;
      const flip = !this.mineO; // my screen is turned around when I'm defending / returning
      const raw: UserInput = { ...this.input, move: mv && flip ? { x: -mv.x, y: -mv.y } : mv ?? null };
      const u = wireInput(raw);
      this.mine.set(this.nextSample, u);
      this.net.send({ t: "in", play: this.playIdx, from: this.nextSample, inputs: [u] });
      this.nextSample++;
      this.input = { move: this.input.move ?? null };
      // advance one tick (if the local play isn't over)
      if (this.sim.snapshot().done) continue;
      const pair = this.inputsFor(this.simTick);
      this.used[this.simTick] = pair;
      this.prev = this.cur;
      this.sim.step(pair[0], pair[1]);
      this.simTick++;
      this.cur = this.mask(this.sim.snapshot());
    }
    const c = this.cur;
    if (!c) return;
    if (this.ui.mode === "presnap" && !c.presnap) this.set({ mode: "live", live: true });
    const kv = c.kick;
    if (kv && (kv.canFairCatch !== this.ui.canFairCatch || kv.canKneel !== this.ui.canKneel || (kv.userPlayer >= 0) !== this.ui.scramble)) {
      this.set({ canFairCatch: kv.canFairCatch, canKneel: kv.canKneel, scramble: kv.userPlayer >= 0 && kv.phase === "loose" });
    }
    const qb = this.mineO && c.qbCanThrow;
    if (qb !== this.ui.qbCanThrow || c.userCarrier !== this.ui.userCarrier || c.canKeep !== this.ui.canKeep ||
        c.userDefender !== this.ui.userDefender || c.cooldowns.juke !== this.ui.cooldowns.juke || c.cooldowns.burst !== this.ui.cooldowns.burst) {
      this.set({ qbCanThrow: qb, userCarrier: c.userCarrier, cooldowns: c.cooldowns, canKeep: c.canKeep, userDefender: c.userDefender });
    }
  }
  protected override presnapFrame(dtMs: number) {
    const left = Math.max(0, this.ui.playClock - dtMs / 1000);
    if (Math.ceil(left) !== Math.ceil(this.ui.playClock)) this.set({ playClock: left }); else this.ui.playClock = left;
  }
  /** After the whistle you see what the other side was in. */
  private revealText(): string | undefined {
    const l = this.live;
    if (!l || l.kick) return undefined;
    return l.offSide === this.userSide ? `vs ${l.call.name}` : `${this.team(l.offSide).abbr} ran ${l.play.name}`;
  }
  dispose() { if (this.net.listener === this) this.net.listener = null; if (this.resultTimer) clearTimeout(this.resultTimer); }
}
