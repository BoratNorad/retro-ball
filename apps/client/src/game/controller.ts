// Game flow for the browser: wraps GameSession, runs live plays at 30 Hz with the player's input,
// and exposes a small observable UI state for Preact.
import type { DefenseCall } from "@tdf/shared";
import {
  Fx, GameSession, fgDistance, fgMakePerMille, suggestPlays,
  type GameResult, type LivePlay, type PlayCall, type PlaySnapshot, type PlaySummary, type Side, type UserCall, type UserInput,
} from "@tdf/sim";
import type { ClientData } from "../data.js";

export type Mode =
  | "callOffense"   // pick a play (or punt/FG/kneel/spike)
  | "callDefense"   // pick a coverage for the AI's snap
  | "callTry"       // PAT or 2
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
}

export interface Settings {
  /** defensive control mode: play one defender (else call-only, Retro Bowl style) */
  controlDefense: boolean;
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
  readonly userSide: Side;
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

  constructor(cd: ClientData, user: string, opp: string, quarterMinutes: number, seed = String(Date.now() % 1e9)) {
    this.cd = cd;
    this.userSide = 0;
    this.session = new GameSession({
      data: cd.data, ratings: cd.ratings, teams: [cd.roster(user), cd.roster(opp)], seed, userSide: 0,
      quarterSeconds: Math.round(quarterMinutes * 60),
    });
    this.ui = {
      mode: "result", toast: null, bigToast: null, live: false, userOffense: false, qbCanThrow: false, userCarrier: false,
      cooldowns: { juke: 0, spin: 0, burst: 0 }, fg: null, tryForTwo: false, fast: false,
      userDefense: false, userDefender: -1, canKeep: false, preview: null,
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
    const k = this.session.teams[s.possession].starters.K!;
    const dist = fgDistance(s.ballOn, this.cd.data);
    return { dist, pct: Math.round(fgMakePerMille(dist, k, { data: this.cd.data, ratings: this.cd.ratings }) / 10) };
  }

  // ---------------------------------------------------------------- flow
  /** Decide what happens next and either resolve it or ask the player. */
  advance() {
    const p = this.session.pending();
    this.live = null;
    if (p.kind === "final") { this.set({ mode: "final", live: false, toast: null }); return; }
    if (p.kind === "kickoff") { this.handle(this.session.snap({})); return; }
    const userOff = this.session.isUserOffense();
    if (p.kind === "try") {
      if (userOff) { this.set({ mode: "callTry", live: false, userOffense: true, tryForTwo: !p.options.includes("pat") }); return; }
      this.set({ mode: "callDefense", live: false, userOffense: false });
      return;
    }
    if (userOff) { this.set({ mode: "callOffense", live: false, userOffense: true, fg: this.fgInfo() }); return; }
    // the AI offense decides first; its personnel comes on the field before you call the defense
    const dec = this.session.previewAiOffense();
    if (dec && dec.kind !== "play") { this.handle(this.session.snap({})); return; }  // punt, FG, kneel, spike
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
    this.handle(this.session.snap({ userCall: call, timeout }));
  }
  callTry(choice: "pat" | "twoPoint") {
    if (choice === "pat") { this.handle(this.session.snap({ tryChoice: "pat" })); return; }
    this.pendingTry = "twoPoint";
    this.set({ mode: "callOffense", userOffense: true, fg: null });
  }
  callDefense(call: DefenseCall | null, front: string | null = null, timeout = this.takeTimeout()) {
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
    const common = { toast: null, preview: null, userDefense: r.live.userDefense, userDefender: snap0.userDefender, canKeep: snap0.canKeep };
    if (r.live.userOffense) this.set({ mode: "presnap", live: false, userOffense: true, ...common });
    else if (r.live.userDefense) this.set({ mode: "presnap", live: false, userOffense: false, fast: false, ...common });
    else this.set({ mode: "live", live: true, userOffense: false, fast: false, ...common });
  }

  snapBall() { if (this.ui.mode === "presnap") this.set({ mode: "live", live: true }); }
  fastForward() { this.set({ fast: true }); }

  /** Called every animation frame with elapsed ms. Runs whole 30 Hz ticks. */
  frame(dtMs: number) {
    if (this.ui.mode !== "live" || !this.live) return;
    const sim = this.live.sim;
    this.acc += Math.min(dtMs, 100) * (this.ui.fast ? 4 : 1);
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.prev = this.cur;
      if (this.optionKeep && this.cur?.canKeep && !this.input.action) this.input.action = "keep";
      // the screen is flipped when the AI has the ball: your stick directions turn around
      const mv = this.input.move;
      const inp = this.live.userOffense ? this.input
        : this.live.userDefense ? { ...this.input, move: mv ? { x: -mv.x, y: -mv.y } : null } : null;
      const done = sim.step(inp);
      // one-shot inputs are consumed by the tick
      this.input = { move: this.input.move ?? null };
      this.cur = sim.snapshot();
      if (done) { this.endLive(); return; }
    }
    const c = this.cur!;
    if (c.qbCanThrow !== this.ui.qbCanThrow || c.userCarrier !== this.ui.userCarrier || c.canKeep !== this.ui.canKeep ||
        c.userDefender !== this.ui.userDefender || c.cooldowns.juke !== this.ui.cooldowns.juke || c.cooldowns.burst !== this.ui.cooldowns.burst) {
      this.set({ qbCanThrow: c.qbCanThrow, userCarrier: c.userCarrier, cooldowns: c.cooldowns, canKeep: c.canKeep, userDefender: c.userDefender });
    }
  }

  private endLive() {
    const live = this.live!;
    const sum = this.session.finish(live);
    // after the whistle you get to see what the other side was in
    this.showResult(sum, live.userOffense ? `vs ${live.call.name}` : `${this.team(live.offSide).abbr} ran ${live.play.name}`);
  }

  private showResult(sum: PlaySummary, reveal?: string) {
    this.lastSummary = sum;
    const big = bigCallout(sum, this.userSide);
    const text = describe(sum, this) + (reveal ? ` · ${reveal}` : "");
    this.set({ mode: "result", live: false, toast: text, bigToast: big, qbCanThrow: false, userCarrier: false, canKeep: false, userDefense: false, userDefender: -1 });
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
  if (e.result.includes("INTERCEPTED")) head = "Intercepted!";
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
