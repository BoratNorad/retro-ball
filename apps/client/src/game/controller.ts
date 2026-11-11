// Game flow for the browser: wraps GameSession, runs live plays at 30 Hz with the player's input,
// and exposes a small observable UI state for Preact.
import type { DefenseCall } from "@tdf/shared";
import {
  Fx, GameSession, fgDistance, suggestPlays,
  type GameResult, type LivePlay, type PlayCall, type PlaySnapshot, type PlaySummary, type Side, type UserCall, type UserInput,
  type PreSnapDefense, type PreSnapOffense, type Roster,
} from "@tdf/sim";
import type { OffensePlay } from "@tdf/shared";
import type { ClientData } from "../data.js";

export type Mode =
  | "callOffense"   // pick a play (or punt/FG/kneel/spike)
  | "callDefense"   // pick a coverage for the AI's snap
  | "callTry"       // PAT or 2
  | "callKickoff"   // you kick off: deep, squib or onside
  | "callReturn"    // they kick off: pick your return wall
  | "callST"        // they line up to punt / kick a field goal: return side, block or safe
  | "kick"          // waiting for your kick flick
  | "pass"          // hot-seat: hand the device to the other player
  | "presnap"       // lined up, waiting for SNAP
  | "live"          // play running
  | "result"        // brief result banner
  | "final";

export interface UiState {
  mode: Mode;
  toast: string | null;
  bigToast: string | null;
  live: boolean;
  userOffense: boolean;
  qbCanThrow: boolean;
  userCarrier: boolean;
  cooldowns: { juke: number; spin: number; burst: number };
  fg: { dist: number; pct: number } | null;
  tryForTwo: boolean;
  fast: boolean;
  /** human controls a defender this play */
  userDefense: boolean;
  userDefender: number;
  /** read option: KEEP is available */
  canKeep: boolean;
  /** the AI offense's personnel group, visible before the defense calls */
  preview: { personnel: string } | null;
  /** seconds left on the play clock (pre-snap) */
  playClock: number;
  /** bumps whenever the pre-snap lineup changes (forces a redraw of the panel) */
  lineup: number;
  /** returns: fair catch / kneel available; loose-ball scramble (onside) under your control */
  canFairCatch: boolean; canKneel: boolean; scramble: boolean;
  /** hot-seat privacy screen: who takes the device, and for what */
  passTo: { team: string; next: "defense" | "offense" } | null;
}

export interface Settings {
  /** defensive control mode: play one defender (else call-only, Retro Bowl style) */
  controlDefense: boolean;
  /** 5 audible slots per side (play ids / call ids) */
  audiblesOff?: string[];
  audiblesDef?: string[];
}
const SETTINGS_KEY = "tdf.settings";
export function loadSettings(): Settings {
  try { return { controlDefense: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") }; } catch { return { controlDefense: false }; }
}
export function saveSettings(s: Settings) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ } }

const TICK_MS = 1000 / 30;

export class Controller {
  readonly cd: ClientData;
  readonly session: GameSession;
  /** the side the human controls now (hot-seat: whoever has the ball) */
  get userSide(): Side { return this.session.userSide ?? 0; }
  live: LivePlay | null = null;
  prev: PlaySnapshot | null = null;
  cur: PlaySnapshot | null = null;
  /** ms accumulated toward the next tick, for render interpolation */
  acc = 0;
  ui: UiState;
  private listeners = new Set<() => void>();
  private resultTimer: ReturnType<typeof setTimeout> | null = null;
  /** input for the next tick */
  input: UserInput = {};
  pendingTry: "pat" | "twoPoint" | null = null;
  lastSummary: PlaySummary | null = null;
  settings: Settings = loadSettings();

  constructor(cd: ClientData, teams: [Roster, Roster], quarterMinutes: number, opts: { hotseat?: boolean; seed?: string } = {}) {
    this.cd = cd;
    this.session = new GameSession({
      data: cd.data, ratings: cd.ratings, teams, seed: opts.seed ?? String(Date.now() % 1e9), userSide: 0, hotseat: opts.hotseat,
      quarterSeconds: Math.round(quarterMinutes * 60),
    });
    this.ui = {
      mode: "result", toast: null, bigToast: null, live: false, userOffense: false, qbCanThrow: false, userCarrier: false,
      cooldowns: { juke: 0, spin: 0, burst: 0 }, fg: null, tryForTwo: false, fast: false,
      userDefense: false, userDefender: -1, canKeep: false, preview: null, playClock: 0, lineup: 0, canFairCatch: false, canKneel: false, scramble: false, passTo: null,
    };
    queueMicrotask(() => this.advance());
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const f of this.listeners) f(); }
  private set(p: Partial<UiState>) { this.ui = { ...this.ui, ...p }; this.emit(); }

  get state() { return this.session.state; }
  team(side: Side) { return this.session.teams[side].info; }
  result(): GameResult { return this.session.result(); }

  /** Field-goal distance and make chance from the current spot (for the call sheet). */
  fgInfo() {
    const s = this.state;
    const dist = fgDistance(s.ballOn, this.cd.data);
    return { dist, pct: Math.round(this.session.kickChanceFor("fieldGoal", s.ballOn) / 10) };
  }
  /** Wind as you feel it attacking up the screen (mph). */
  windForUser() { return this.session.windFor(this.userSide); }

  // ---------------------------------------------------------------- flow
  /** Decide what happens next and either resolve it or ask the player. */
  advance() {
    const p = this.session.pending();
    this.live = null;
    if (p.kind === "final") { this.set({ mode: "final", live: false, toast: null }); return; }
    if (p.kind === "kickoff") {
      if (this.state.possession === this.userSide) this.set({ mode: "callKickoff", live: false, userOffense: true, toast: null });
      else this.set({ mode: "callReturn", live: false, userOffense: false, toast: null });
      return;
    }
    const userOff = this.session.isUserOffense();
    if (p.kind === "try") {
      if (userOff) { this.set({ mode: "callTry", live: false, userOffense: true, tryForTwo: !p.options.includes("pat") }); return; }
      this.set({ mode: "callDefense", live: false, userOffense: false });
      return;
    }
    if (this.session.hotseat) {
      // the defending player calls first, privately; then the offense
      this.hsDef = null;
      this.set({ mode: "pass", live: false, userOffense: false, passTo: { team: this.team(this.state.possession === 0 ? 1 : 0).name, next: "defense" } });
      return;
    }
    if (userOff) { this.set({ mode: "callOffense", live: false, userOffense: true, fg: this.fgInfo() }); return; }
    // the AI offense decides first; its personnel comes on the field before you call the defense
    const dec = this.session.previewAiOffense();
    if (dec && (dec.kind === "punt" || dec.kind === "fieldGoal" || dec.kind === "fake")) {
      // a fake looks like the kick it came out of
      const as = dec.kind === "fake" ? dec.as ?? "punt" : dec.kind;
      this.stKind = as;
      this.set({ mode: "callST", live: false, userOffense: false, toast: null });
      return;
    }
    if (dec && dec.kind !== "play") { this.handle(this.session.snap({})); return; }  // kneel, spike
    this.set({ mode: "callDefense", live: false, userOffense: false, preview: dec ? { personnel: dec.personnel } : null });
  }

  /** Coach's suggestions for this down and distance. */
  suggestions(): PlayCall[] {
    const s = this.state, off = this.session.teams[s.possession];
    return suggestPlays(s, off, this.cd.data, this.cd.ratings, this.session.tend[s.possession === 0 ? 1 : 0]);
  }
  setControlDefense(on: boolean) { this.settings = { ...this.settings, controlDefense: on }; saveSettings(this.settings); this.set({}); }
  /** read option: plan to keep (can be set before the snap or pressed during the mesh) */
  optionKeep = false;
  setOptionKeep(on: boolean) { this.optionKeep = on; this.set({}); }

  callOffense(call: UserCall, timeout = this.takeTimeout()) {
    if (this.pendingTry === "twoPoint" && call.kind === "play") {
      this.pendingTry = null;
      this.handle(this.session.snap({ tryChoice: "twoPoint", userCall: call }));
      return;
    }
    const hs = this.session.hotseat && this.hsDef?.call ? { defCall: this.hsDef.call, defFront: this.hsDef.front ?? undefined } : {};
    this.handle(this.session.snap({ userCall: call, timeout, ...hs }));
  }
  /** what the opponent is lining up for (callST) */
  stKind: "punt" | "fieldGoal" = "punt";
  kickoff(kind: "kickoff" | "squib" | "onside") { this.handle(this.session.snap({ kickoffKind: kind })); }
  receiveKick(side: "L" | "M" | "R") { this.handle(this.session.snap({ returnSide: side })); }
  callST(mode: "block" | "safe" | "normal", side: "L" | "M" | "R" = "M") { this.handle(this.session.snap({ stDefense: mode, returnSide: side, timeout: this.takeTimeout() })); }
  /** Your flick: aim (radians, + right), power 0..1, curve -1..1. */
  kickBall(aim: number, power: number, curve: number) {
    if (this.ui.mode !== "kick") return;
    this.input.kick = { aim: Math.round(aim * 1000), power: Math.round(power * 1000), curve: Math.round(curve * 1000) };
    this.set({ mode: "live", live: true });
  }
  callTry(choice: "pat" | "twoPoint") {
    if (choice === "pat") { this.handle(this.session.snap({ tryChoice: "pat" })); return; }
    this.pendingTry = "twoPoint";
    this.set({ mode: "callOffense", userOffense: true, fg: null });
  }
  /** hot-seat: the defending player's call, held until the offense snaps */
  hsDef: { call: DefenseCall | null; front: string | null } | null = null;
  /** hot-seat: the device has been handed over */
  passed() {
    const p = this.ui.passTo;
    if (!p) return;
    if (p.next === "defense") this.set({ mode: "callDefense", passTo: null, userOffense: false, preview: null });
    else this.set({ mode: "callOffense", passTo: null, userOffense: true, fg: this.fgInfo() });
  }
  callDefense(call: DefenseCall | null, front: string | null = null, timeout = this.takeTimeout()) {
    if (this.session.hotseat) {
      this.hsDef = { call, front };
      this.set({ mode: "pass", passTo: { team: this.team(this.state.possession).name, next: "offense" } });
      return;
    }
    this.handle(this.session.snap({ defCall: call ?? undefined, defFront: call ? front ?? undefined : undefined, timeout, controlDefender: this.settings.controlDefense }));
  }
  callTimeout() {
    // a timeout before the next snap: applied when the play is called
    this.timeoutQueued = true;
    this.set({ toast: "Timeout" });
  }
  timeoutQueued = false;
  private takeTimeout() { const t = this.timeoutQueued; this.timeoutQueued = false; return t; }

  private handle(r: ReturnType<GameSession["snap"]>) {
    if ("done" in r) { this.showResult(r.done); return; }
    this.live = r.live;
    this.prev = this.cur = r.live.sim.snapshot();
    this.acc = 0;
    this.input = {};
    this.optionKeep = false;
    const snap0 = r.live.sim.snapshot();
    const common = { toast: null, preview: null, userDefense: r.live.userDefense, userDefender: snap0.userDefender, canKeep: snap0.canKeep,
      playClock: this.cd.data.tuning.presnap.playClock, lineup: this.ui.lineup + 1 };
    if (r.live.kick) {
      // special teams: your kick waits for the flick; otherwise the play just starts
      if (r.live.kick.userKick) this.set({ mode: "kick", live: false, userOffense: true, fast: false, ...common });
      else this.set({ mode: "live", live: true, userOffense: false, fast: false, ...common });
      return;
    }
    // both sides get a pre-snap window (offense: motion, audibles...; defense: looks, audibles)
    this.set({ mode: "presnap", live: false, userOffense: r.live.userOffense, fast: false, ...common });
  }

  snapBall() {
    if (this.ui.mode !== "presnap" || !this.live) return;
    // offense in motion: the snap is an input to the running pre-snap phase
    if (this.live.userOffense && this.cur?.presnap) this.input.snap = true;
    this.set({ mode: "live", live: true });
  }

  // ---------------------------------------------------------------- pre-snap
  get preOff(): PreSnapOffense { return this.live?.preOff ?? {}; }
  get preDef(): PreSnapDefense { return this.live?.preDef ?? {}; }
  /** Re-line up with changes (audible, motion, hot route, looks...). */
  adjust(ch: Parameters<GameSession["adjust"]>[1]) {
    if (!this.live || this.ui.mode !== "presnap") return;
    this.live = this.session.adjust(this.live, ch);
    this.prev = this.cur = this.live.sim.snapshot();
    this.acc = 0;
    this.input = {};
    this.set({ lineup: this.ui.lineup + 1, canKeep: this.cur.canKeep, userDefender: this.cur.userDefender });
  }
  setPreOff(p: Partial<PreSnapOffense>) { this.adjust({ preOff: { ...this.preOff, ...p } }); }
  setPreDef(p: Partial<PreSnapDefense>) { this.adjust({ preDef: { ...this.preDef, ...p } }); }
  audibleOff(play: OffensePlay) {
    // a new play brings its own motion (if any) and drops the old hot routes
    const { motion: _m, hot: _h, ...rest } = this.preOff;
    this.adjust({ play, preOff: rest });
  }
  hardCount() {
    if (!this.live || !this.live.userOffense) return;
    const r = this.session.hardCount(this.live);
    if (r) { this.live = null; this.showResult(r, "hard count"); }
    else this.set({ toast: "Nobody bit on the hard count" });
  }
  audibleSlots(side: "off" | "def"): string[] {
    const d = this.cd.data.coach.presnap.audibles;
    return (side === "off" ? this.settings.audiblesOff : this.settings.audiblesDef) ?? (side === "off" ? d.offense : d.defense);
  }
  setAudibleSlot(side: "off" | "def", k: number, id: string) {
    const slots = [...this.audibleSlots(side)];
    slots[k] = id;
    this.settings = side === "off" ? { ...this.settings, audiblesOff: slots } : { ...this.settings, audiblesDef: slots };
    saveSettings(this.settings);
    this.set({});
  }
  fastForward() { this.set({ fast: true }); }

  /** Called every animation frame with elapsed ms. Runs whole 30 Hz ticks. */
  frame(dtMs: number) {
    if (this.ui.mode === "presnap" && this.live) { this.presnapFrame(dtMs); return; }
    if (this.ui.mode !== "live" || !this.live) return;
    const sim = this.live.sim;
    this.acc += Math.min(dtMs, 100) * (this.ui.fast ? 4 : 1);
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.prev = this.cur;
      if (this.optionKeep && this.cur?.canKeep && !this.input.action) this.input.action = "keep";
      // the screen is flipped when the AI has the ball: your stick directions turn around
      const mv = this.input.move;
      const flippedHuman = this.live.userDefense || Boolean(this.live.kick?.userReturn);
      const inp = this.live.userOffense ? this.input
        : flippedHuman ? { ...this.input, move: mv ? { x: -mv.x, y: -mv.y } : null } : null;
      const done = sim.step(inp);
      // one-shot inputs are consumed by the tick
      this.input = { move: this.input.move ?? null };
      void 0;
      this.cur = sim.snapshot();
      if (done) { this.endLive(); return; }
    }
    const c = this.cur!;
    const kv = c.kick;
    if (kv && (kv.canFairCatch !== this.ui.canFairCatch || kv.canKneel !== this.ui.canKneel || (kv.userPlayer >= 0) !== this.ui.scramble)) {
      this.set({ canFairCatch: kv.canFairCatch, canKneel: kv.canKneel, scramble: kv.userPlayer >= 0 && kv.phase === "loose" });
    }
    if (c.qbCanThrow !== this.ui.qbCanThrow || c.userCarrier !== this.ui.userCarrier || c.canKeep !== this.ui.canKeep ||
        c.userDefender !== this.ui.userDefender || c.cooldowns.juke !== this.ui.cooldowns.juke || c.cooldowns.burst !== this.ui.cooldowns.burst) {
      this.set({ qbCanThrow: c.qbCanThrow, userCarrier: c.userCarrier, cooldowns: c.cooldowns, canKeep: c.canKeep, userDefender: c.userDefender });
    }
  }

  /** Pre-snap: run the play clock; let motion run (the sim waits in its pre-snap phase). */
  private presnapFrame(dtMs: number) {
    const live = this.live!;
    const left = Math.max(0, this.ui.playClock - dtMs / 1000);
    if (Math.ceil(left) !== Math.ceil(this.ui.playClock)) this.set({ playClock: left }); else this.ui.playClock = left;
    if (left <= 0) {
      if (live.userOffense) { this.live = null; this.showResult(this.session.delayOfGame(live), "play clock"); }
      else this.snapBall();
      return;
    }
    if (live.userOffense && this.cur?.presnap) {
      this.acc += Math.min(dtMs, 100);
      while (this.acc >= TICK_MS) {
        this.acc -= TICK_MS;
        this.prev = this.cur;
        live.sim.step({});
        this.cur = live.sim.snapshot();
      }
    }
  }

  private endLive() {
    const live = this.live!;
    const sum = this.session.finish(live);
    // after the whistle you get to see what the other side was in
    this.showResult(sum, live.kick ? undefined : live.userOffense ? `vs ${live.call.name}` : `${this.team(live.offSide).abbr} ran ${live.play.name}`);
  }

  private showResult(sum: PlaySummary, reveal?: string) {
    this.lastSummary = sum;
    const big = bigCallout(sum, this.userSide);
    const text = describe(sum, this) + (reveal ? ` · ${reveal}` : "");
    this.set({ mode: "result", live: false, toast: text, bigToast: big, qbCanThrow: false, userCarrier: false, canKeep: false, userDefense: false, userDefender: -1,
      canFairCatch: false, canKneel: false, scramble: false });
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => { this.set({ bigToast: null }); this.advance(); }, big ? 1900 : 1300);
  }

  // ---------------------------------------------------------------- frames (user-team view)
  /** Should this snapshot be drawn flipped (the AI has the ball, so it attacks down the screen)? */
  flipped(): boolean { return this.live ? this.live.offSide !== this.userSide : this.state.possession !== this.userSide; }
}

/** Plain-English summary of a play for the result banner. */
function describe(sum: PlaySummary, c: Controller): string {
  const e = sum.entry;
  const s = sum.state;
  const evs = sum.events.map((x) => x.t);
  const yards = e.yards;
  let head = e.name;
  const res0 = e.result.split(" [")[0]!;
  if (["False start", "Offside", "Delay of game", "Offside (hard count)"].includes(res0)) head = res0;
  else if (e.result.includes("INTERCEPTED")) head = "Intercepted!";
  else if (e.result.includes("FUMBLE")) head = "Fumble!";
  else if (e.result.includes("SACK")) head = `Sacked, ${yards} yds`;
  else if (e.result.includes("incomplete") || e.result.includes("throws it away")) head = "Incomplete";
  else if (e.kind === "play" && !["Punt", "Kneel", "Spike", "—"].includes(e.name) && !e.name.includes("field goal")) head = `${yards >= 0 ? "+" : ""}${yards} yds`;
  else head = e.result.split(" [")[0]!;
  if (evs.includes("penalty")) head += ` · ${sum.events.find((x) => x.t === "penalty")?.text ?? "penalty"}`;
  if (s.phase === "play") {
    const team = c.team(s.possession).abbr;
    head += ` · ${team} ${ordinal(s.down)} & ${toGoText(s)}`;
  }
  return head;
}
function bigCallout(sum: PlaySummary, user: Side): string | null {
  for (const e of sum.events) {
    if (e.t === "touchdown") return "TOUCHDOWN!";
    if (e.t === "fieldGoal") return "IT'S GOOD!";
    if (e.t === "fgMissed") return "NO GOOD";
    if (e.t === "safety") return "SAFETY!";
    if (e.t === "turnover") return e.side === user ? "TURNOVER" : "TAKEAWAY!";
    if (e.t === "downs") return "TURNOVER ON DOWNS";
    if (e.t === "halftime") return "HALFTIME";
    if (e.t === "final") return "FINAL";
  }
  return null;
}
export const ordinal = (n: number) => ["", "1st", "2nd", "3rd", "4th"][n] ?? `${n}th`;
export function toGoText(s: { ballOn: number; toGo: number }) {
  const togo = Math.round(s.toGo / 65536);
  return Math.round((s.ballOn + s.toGo) / 65536) >= 100 ? "Goal" : String(Math.max(1, togo));
}
export function spotText(ballOn: number) {
  const y = Math.round(ballOn / 65536);
  return y === 50 ? "50" : y < 50 ? `OWN ${y}` : `OPP ${100 - y}`;
}
export const fxToYd = (v: number) => Fx.toFloat(v);
