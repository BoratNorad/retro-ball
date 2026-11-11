// Replays, highlights and drive summaries (M9). A play is re-created from its LivePlay (same seed,
// same calls) and the inputs that were fed to it tick by tick, so any play can be replayed exactly
// from the seed + input log, with no recorded positions.
import type { GameEvent, Side } from "./rules.js";
import type { PlayLog, PlaySummary } from "./game.js";
import type { PlaySim, PlaySnapshot, UserInput } from "./engine/play.js";

/** One tick's inputs exactly as they were passed to step(): `d === undefined` = a one-argument call. */
export type TickInput = [UserInput | null | undefined, UserInput | null | undefined];

/** Re-run a play from tick 0 and collect a snapshot per tick (the first is the line-up). */
export function replayFrames(remake: () => PlaySim, inputs: readonly TickInput[]): PlaySnapshot[] {
  const sim = remake();
  const out: PlaySnapshot[] = [strip(sim.snapshot())];
  for (const [o, d] of inputs) {
    const done = d === undefined ? sim.step(o) : sim.step(o, d);
    out.push(strip(sim.snapshot()));
    if (done) break;
  }
  return out;
}
/** Snapshots share the sim's growing log arrays; copy what a frame needs. */
function strip(s: PlaySnapshot): PlaySnapshot {
  return { ...s, log: s.log.slice(), fx: s.fx?.slice(), routes: [], assign: [] };
}

export type HighlightKind = "TOUCHDOWN" | "INTERCEPTION" | "FUMBLE" | "SACK" | "BIG PLAY" | "BLOCKED KICK" | "FIELD GOAL";
/** Is this play worth keeping as a highlight? (TDs, picks, fumbles, sacks, 20+ yard plays, blocked kicks, long FGs) */
export function highlightOf(sum: PlaySummary, bigPlayYards = 20): HighlightKind | null {
  const ev = (t: GameEvent["t"]) => sum.events.some((e) => e.t === t);
  const r = sum.entry.result;
  if (ev("touchdown")) return "TOUCHDOWN";
  if (r.includes("INTERCEPTED")) return "INTERCEPTION";
  if (r.includes("FUMBLE") && ev("turnover")) return "FUMBLE";
  if (/blocked/i.test(r)) return "BLOCKED KICK";
  if (r.includes("SACK")) return "SACK";
  if (ev("fieldGoal") && /^(\d+)-yd/.test(sum.entry.name) && Number(/^(\d+)/.exec(sum.entry.name)![1]) >= 50) return "FIELD GOAL";
  if (sum.entry.yards >= bigPlayYards) return "BIG PLAY";
  return null;
}

export interface DriveSummary {
  side: Side; quarter: number; startBallOn: number; plays: number; yards: number;
  /** game seconds used */
  seconds: number;
  result: string;
}
/** Split a game log into drives (possessions between kickoffs, turnovers and scores). */
export function drives(log: readonly PlayLog[], quarterSeconds: number, tickHz: number): DriveSummary[] {
  const out: DriveSummary[] = [];
  let cur: (DriveSummary & { t0: number }) | null = null;
  const tAbs = (e: PlayLog) => (e.q - 1) * quarterSeconds + (quarterSeconds - e.clock / tickHz);
  const close = (result: string, e: PlayLog | null) => {
    if (!cur) return;
    const { t0, ...d } = cur;
    out.push({ ...d, result, seconds: Math.max(0, Math.round((e ? tAbs(e) : t0) - t0)) });
    cur = null;
  };
  for (const e of log) {
    if (e.kind === "kickoff" || e.kind === "try" || e.name === "—") {
      if (e.events.some((x) => x.t === "halftime" || x.t === "final")) close(e.events.some((x) => x.t === "final") ? "End of game" : "End of half", e);
      continue;
    }
    if (!cur || cur.side !== e.off) {
      close("Change of possession", e);
      cur = { side: e.off, quarter: e.q, startBallOn: e.ballOn, plays: 0, yards: 0, seconds: 0, result: "", t0: tAbs(e) };
    }
    cur.plays++;
    if (e.name !== "Punt" && !e.name.includes("field goal")) cur.yards += e.yards;
    const t = (k: GameEvent["t"]) => e.events.some((x) => x.t === k);
    const end = t("touchdown") ? "Touchdown" : t("fieldGoal") ? "Field goal" : t("fgMissed") ? "Missed FG" : t("safety") ? "Safety"
      : t("turnover") ? (e.result.includes("INTERCEPTED") ? "Interception" : "Fumble") : t("downs") ? "Downs" : e.name === "Punt" ? "Punt"
      : t("halftime") ? "End of half" : t("final") ? "End of game" : null;
    if (end) close(end, e);
  }
  close("In progress", null);
  return out;
}
