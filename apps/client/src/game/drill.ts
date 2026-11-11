// Practice drills (M12): a Controller whose game never moves on. Every rep starts from the drill's
// spot, down and distance, against a fixed defensive look; each result counts toward the goal.
import { Fx, type PlaySummary, type UserCall } from "@tdf/sim";
import type { ClientData } from "../data.js";
import { Controller } from "./controller.js";

export type Drill = ClientData["data"]["tutorial"]["drills"][number];
const DONE_KEY = "tdf.tutorial.done";
export function drillsDone(): string[] { try { return JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]"); } catch { return []; } }
function markDone(id: string) { try { localStorage.setItem(DONE_KEY, JSON.stringify([...new Set([...drillsDone(), id])])); } catch { /* private */ } }

export class DrillController extends Controller {
  readonly drill: Drill;
  /** reps run, successes, the last rep's verdict, the drill is complete */
  progress = { reps: 0, made: 0, last: null as null | { ok: boolean; text: string }, done: false };
  private usedMotion = false;

  constructor(cd: ClientData, drill: Drill) {
    super(cd, [cd.roster("KC"), cd.roster("NYJ")], 15, { seed: `drill:${drill.id}:${Date.now() % 1e6}` });
    this.drill = drill;
    this.coverageHints = Boolean(drill.hints);
  }
  protected override snapExtras() {
    const st = this.drill?.setup;
    const call = st?.call ? this.cd.data.defense.calls.find((c) => c.id === st.call) : undefined;
    return call ? { practiceDefense: { call, front: st!.front } } : {};
  }
  /** Back to the drill's starting spot (the score and clock never matter). */
  private reset() {
    const st = this.drill.setup, s = this.session.state;
    this.session.state = {
      ...s, phase: "play", quarter: 1, clock: this.cd.data.rules.quarterSeconds * this.cd.data.rules.tickHz, possession: st.offense ? 0 : 1,
      ballOn: Fx.fromInt(st.ballOn), down: st.down, toGo: Fx.fromInt(st.toGo), score: [0, 0], tryKind: null, ot: null, clockRunning: false,
    };
    this.usedMotion = false;
  }
  override advance() {
    if (!this.drill) return; // (the base constructor queues a first advance)
    if (this.progress.done) { this.set({ mode: "result", toast: null }); return; }
    this.reset();
    const st = this.drill.setup;
    if (st.kick) { this.callOffense({ kind: "fieldGoal" }); return; }
    if (st.play) {
      const play = this.cd.data.offense.plays.find((p) => p.id === st.play)!;
      this.callOffense({ kind: "play", play, flip: false } as UserCall);
      return;
    }
    super.advance();
  }
  override adjust(ch: Parameters<Controller["adjust"]>[0]) {
    if (ch.play || ch.preOff?.motion || (ch.preOff?.hot && Object.keys(ch.preOff.hot).length)) this.usedMotion = true;
    super.adjust(ch);
  }
  protected override presnapFrame(dtMs: number) {
    // no play clock in practice
    this.ui.playClock = this.cd.data.tuning.presnap.playClock;
    super.presnapFrame(dtMs);
  }
  protected override showResult(sum: PlaySummary, reveal?: string) {
    const d = this.drill, e = sum.entry, ev = (t: string) => sum.events.some((x) => x.t === t);
    const foul = ev("penalty");
    let ok = false;
    if (d.goal === "complete") ok = e.result.includes("caught by") && !e.result.includes("INTERCEPTED") && !foul;
    else if (d.goal === "gain") ok = !foul && (e.yards >= d.n || ev("touchdown")) && !e.result.includes("INTERCEPTED") && !e.result.includes("FUMBLE");
    else if (d.goal === "fieldGoal") ok = ev("fieldGoal");
    else if (d.goal === "stop") ok = e.yards < d.n && !ev("touchdown") && !ev("firstDown");
    else if (d.goal === "motion") ok = this.usedMotion && !foul && (e.yards >= d.n || ev("touchdown"));
    const why = !ok && d.goal === "motion" && !this.usedMotion ? " (use motion or an audible first)" : "";
    this.progress.reps++;
    if (ok) this.progress.made++;
    this.progress.last = { ok, text: ok ? "GOOD REP!" : `NOT THIS TIME${why}` };
    if (this.progress.made >= d.reps) { this.progress.done = true; markDone(d.id); }
    super.showResult(sum, reveal);
  }
}
