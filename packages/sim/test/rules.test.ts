import { beforeAll, describe, expect, it } from "vitest";
import type { RulesConfig } from "@tdf/shared";
import { nodeGameData } from "@tdf/shared/node";
import { fromInt } from "../src/fixed.js";
import {
  applyOutcome, beforeSnap, newGame, prepareTry, tryOptions,
  type GameState, type PlayOutcome,
} from "../src/rules.js";

let cfg: RulesConfig;
beforeAll(async () => { cfg = (await nodeGameData()).rules; });

const Y = fromInt;
const yd = (fx: number) => fx / 65536;
const sec = (s: number) => s * cfg.tickHz;
const play = (endY: number, more: Partial<PlayOutcome> = {}): PlayOutcome =>
  ({ play: "scrimmage", endY: Y(endY), elapsedTicks: sec(5), ...more });

/** a game where side 0 has 1st & 10 at its own `at` */
function drive(at = 25, patch: Partial<GameState> = {}): GameState {
  const g = newGame(cfg, 0);
  const s = applyOutcome(g, { play: "kickoff", endY: Y(100), elapsedTicks: 0 }, cfg).state; // touchback
  return { ...s, ballOn: Y(at), down: 1, toGo: Y(10), ...patch };
}

describe("kickoffs and downs", () => {
  it("opening kickoff touchback gives the receiver 1st & 10 at the 30", () => {
    const g = newGame(cfg, 0);
    expect(g.phase).toBe("kickoff");
    expect(g.possession).toBe(1);
    const { state, events } = applyOutcome(g, { play: "kickoff", endY: Y(105), elapsedTicks: 0 }, cfg);
    expect(state.possession).toBe(0);
    expect(yd(state.ballOn)).toBe(cfg.spots.kickoffTouchback);
    expect([state.down, yd(state.toGo), state.phase]).toEqual([1, 10, "play"]);
    expect(events.map((e) => e.t)).toContain("touchback");
  });

  it("returned kickoff: receiver gets the ball at the return spot (its own frame)", () => {
    const s = applyOutcome(newGame(cfg, 0), { play: "kickoff", endY: Y(72), elapsedTicks: sec(6) }, cfg).state;
    expect(yd(s.ballOn)).toBe(28);
  });

  it("gains, first downs, goal to go", () => {
    let s = drive(25);
    s = applyOutcome(s, play(29), cfg).state;
    expect([s.down, yd(s.toGo), yd(s.ballOn)]).toEqual([2, 6, 29]);
    const r = applyOutcome(s, play(36), cfg);
    expect([r.state.down, yd(r.state.toGo)]).toEqual([1, 10]);
    expect(r.events.map((e) => e.t)).toContain("firstDown");
    s = applyOutcome({ ...r.state, ballOn: Y(84) }, play(94), cfg).state;
    expect([s.down, yd(s.toGo)]).toEqual([1, 6]); // goal to go
  });

  it("turnover on downs flips the spot", () => {
    const s = applyOutcome(drive(60, { down: 4, toGo: Y(3) }), play(61), cfg);
    expect(s.state.possession).toBe(1);
    expect(yd(s.state.ballOn)).toBe(39);
    expect(s.events.map((e) => e.t)).toContain("downs");
  });
});

describe("scoring", () => {
  it("touchdown -> try -> kickoff by the scoring team", () => {
    let s = applyOutcome(drive(80), play(100), cfg).state;
    expect([s.phase, s.score[0]]).toEqual(["try", 6]);
    expect(tryOptions(s, cfg)).toEqual(["pat", "twoPoint"]);
    s = prepareTry(s, "pat", cfg);
    expect(yd(s.ballOn)).toBe(cfg.spots.patLine);
    s = applyOutcome(s, { play: "pat", endY: s.ballOn, good: true, elapsedTicks: 0 }, cfg).state;
    expect(s.score).toEqual([7, 0]);
    expect([s.phase, s.possession]).toEqual(["kickoff", 0]);
  });

  it("safety: 2 points and a free kick from the 20 by the team that gave it up", () => {
    const s = applyOutcome(drive(3), play(-1), cfg).state;
    expect(s.score).toEqual([0, 2]);
    expect([s.phase, s.possession, yd(s.freeKickFrom)]).toEqual(["kickoff", 0, 20]);
  });

  it("pick six and touchback on an interception in the end zone", () => {
    const six = applyOutcome(drive(30), play(-2, { turnover: "interception" }), cfg).state;
    expect([six.score[1], six.phase, six.possession]).toEqual([6, "try", 1]);
    const tb = applyOutcome(drive(70), play(104, { turnover: "interception" }), cfg);
    expect([tb.state.possession, yd(tb.state.ballOn)]).toEqual([1, 20]);
  });

  it("field goals: make -> kickoff; miss -> spot of the kick, never inside the 20", () => {
    const made = applyOutcome(drive(70), { play: "fieldGoal", endY: Y(70), good: true, elapsedTicks: sec(4) }, cfg).state;
    expect([made.score[0], made.phase]).toEqual([3, "kickoff"]);
    const miss = applyOutcome(drive(60), { play: "fieldGoal", endY: Y(60), good: false, elapsedTicks: sec(4) }, cfg).state;
    expect([miss.possession, yd(miss.ballOn)]).toEqual([1, 47]);  // spot of kick = own 53 -> their 47
    const close = applyOutcome(drive(90), { play: "fieldGoal", endY: Y(90), good: false, elapsedTicks: sec(4) }, cfg).state;
    expect(yd(close.ballOn)).toBe(20);
  });
});

describe("clock", () => {
  it("incompletions stop the clock; in-bounds runs keep it running; late out-of-bounds stops it", () => {
    expect(applyOutcome(drive(), play(25, { incomplete: true }), cfg).state.clockRunning).toBe(false);
    expect(applyOutcome(drive(), play(30), cfg).state.clockRunning).toBe(true);
    expect(applyOutcome(drive(), play(30, { outOfBounds: true }), cfg).state.clockRunning).toBe(true); // early Q1
    const late = drive(30, { quarter: 4, clock: sec(200) });
    expect(applyOutcome(late, play(35, { outOfBounds: true }), cfg).state.clockRunning).toBe(false);
  });

  it("runoff between plays, timeouts stop it", () => {
    const s = { ...drive(), clockRunning: true, clock: sec(600) };
    expect(beforeSnap(s, { tempo: "normal" }, cfg).state.clock).toBe(sec(600 - cfg.runoffSeconds.normal));
    expect(beforeSnap(s, { tempo: "hurry" }, cfg).state.clock).toBe(sec(600 - cfg.runoffSeconds.hurry));
    const to = beforeSnap(s, { tempo: "normal", timeoutBy: 0 }, cfg);
    expect([to.state.clock, to.state.timeouts[0]]).toEqual([sec(600), cfg.timeoutsPerHalf - 1]);
  });

  it("two-minute warning stops the clock at 2:00 exactly", () => {
    const s = { ...drive(), quarter: 4, clock: sec(130), clockRunning: true };
    const r = beforeSnap(s, { tempo: "milk" }, cfg);
    expect(r.state.clock).toBe(sec(120));
    expect(r.state.clockRunning).toBe(false);
    expect(r.events.map((e) => e.t)).toContain("twoMinuteWarning");
    const again = beforeSnap({ ...r.state, clockRunning: true }, { tempo: "milk" }, cfg).state;
    expect(again.clock).toBe(sec(120 - cfg.runoffSeconds.milk));
  });

  it("quarters roll over; halftime kickoff goes the other way", () => {
    const q1 = beforeSnap({ ...drive(40), clock: sec(10), clockRunning: true }, { tempo: "normal" }, cfg);
    expect(q1.quarterEnded).toBe(true);
    expect([q1.state.quarter, q1.state.clock, yd(q1.state.ballOn), q1.state.possession]).toEqual([2, sec(900), 40, 0]);
    const q2 = applyOutcome({ ...drive(40), quarter: 2, clock: sec(3) }, play(45), cfg).state;
    expect([q2.quarter, q2.phase, q2.possession]).toEqual([3, "kickoff", 0]); // side 0 received the opening kick
    expect(q2.timeouts).toEqual([cfg.timeoutsPerHalf, cfg.timeoutsPerHalf]);
  });

  it("a touchdown on the last play still gets its try, then the game ends", () => {
    let s = applyOutcome({ ...drive(90), quarter: 4, clock: sec(4), score: [10, 14] }, play(100), cfg).state;
    expect([s.phase, s.clock, s.score[0]]).toEqual(["try", 0, 16]);
    s = prepareTry(s, "pat", cfg);
    s = applyOutcome(s, { play: "pat", endY: s.ballOn, good: true, elapsedTicks: 0 }, cfg).state;
    expect([s.phase, s.score[0]]).toEqual(["final", 17]);
  });
});

describe("college overtime", () => {
  const tiedEnd = () => applyOutcome({ ...drive(40), quarter: 4, clock: sec(2), score: [20, 20] }, play(42), cfg);

  it("tied after regulation starts OT at the 25", () => {
    const { state, events } = tiedEnd();
    expect(events.map((e) => e.t)).toContain("overtime");
    expect([state.quarter, state.phase, yd(state.ballOn), state.ot?.period]).toEqual([5, "play", 75, 1]);
  });

  it("TD+PAT then a field goal: game over", () => {
    let s = tiedEnd().state;
    const first = s.possession;
    s = applyOutcome({ ...s, ballOn: Y(95) }, play(100), cfg).state;
    s = applyOutcome(prepareTry(s, "pat", cfg), { play: "pat", endY: Y(85), good: true, elapsedTicks: 0 }, cfg).state;
    expect(s.possession).toBe(first === 0 ? 1 : 0);
    expect(yd(s.ballOn)).toBe(75);
    s = applyOutcome(s, { play: "fieldGoal", endY: s.ballOn, good: true, elapsedTicks: 0 }, cfg).state;
    expect(s.phase).toBe("final");
  });

  it("period 2 must go for two; period 3+ is a two-point shootout", () => {
    let s = tiedEnd().state;
    s = applyOutcome(s, { play: "fieldGoal", endY: s.ballOn, good: true, elapsedTicks: 0 }, cfg).state;
    s = applyOutcome(s, { play: "fieldGoal", endY: s.ballOn, good: true, elapsedTicks: 0 }, cfg).state;
    expect(s.ot?.period).toBe(2);
    s = applyOutcome({ ...s, ballOn: Y(97) }, play(100), cfg).state;
    expect(tryOptions(s, cfg)).toEqual(["twoPoint"]);
    s = applyOutcome(prepareTry(s, "twoPoint", cfg), { play: "twoPoint", endY: Y(98), good: false, elapsedTicks: 0 }, cfg).state;
    s = applyOutcome({ ...s, ballOn: Y(97) }, play(100), cfg).state;
    s = applyOutcome(prepareTry(s, "twoPoint", cfg), { play: "twoPoint", endY: Y(98), good: false, elapsedTicks: 0 }, cfg).state;
    expect([s.ot?.period, s.phase, s.tryKind]).toEqual([3, "try", "twoPoint"]);
  });

  it("a defensive touchdown in OT ends the game", () => {
    const s = applyOutcome(tiedEnd().state, play(-1, { turnover: "fumble" }), cfg).state;
    expect(s.phase).toBe("final");
  });
});

describe("penalties", () => {
  it("false start: 5 yards back, replay the down; offsides can give a first down", () => {
    const fs = applyOutcome(drive(30, { down: 2, toGo: Y(7) }), play(30, { elapsedTicks: 0, foul: { name: "False start", on: "O", yards: 5, kind: "preSnap" } }), cfg).state;
    expect([fs.down, yd(fs.toGo), yd(fs.ballOn)]).toEqual([2, 12, 25]);
    const off = applyOutcome(drive(30, { down: 3, toGo: Y(2) }), play(30, { elapsedTicks: 0, foul: { name: "Offside", on: "D", yards: 5, kind: "preSnap" } }), cfg).state;
    expect([off.down, yd(off.ballOn)]).toEqual([1, 35]);
  });

  it("half the distance to the goal", () => {
    const s = applyOutcome(drive(6), play(6, { elapsedTicks: 0, foul: { name: "False start", on: "O", yards: 5, kind: "preSnap" } }), cfg).state;
    expect(yd(s.ballOn)).toBe(3);
  });

  it("offensive holding: the defense accepts on a big gain, declines on a sack", () => {
    const hold = { name: "Holding", on: "O" as const, yards: 10, kind: "live" as const };
    const gain = applyOutcome(drive(40), play(62, { foul: hold }), cfg);
    expect([gain.state.down, yd(gain.state.toGo), yd(gain.state.ballOn)]).toEqual([1, 20, 30]);
    const sack = applyOutcome(drive(40, { down: 3, toGo: Y(8) }), play(31, { foul: hold }), cfg);
    expect(sack.events.map((e) => e.t)).toContain("declined");
    expect(sack.state.down).toBe(4);
  });

  it("defensive holding on an incompletion: 5 yards and an automatic first down", () => {
    const s = applyOutcome(drive(40, { down: 3, toGo: Y(9) }), play(40, { incomplete: true, foul: { name: "Defensive holding", on: "D", yards: 5, kind: "live", autoFirst: true } }), cfg).state;
    expect([s.down, yd(s.ballOn)]).toEqual([1, 45]);
  });

  it("pass interference is a spot foul", () => {
    const s = applyOutcome(drive(40), play(40, { incomplete: true, foul: { name: "Pass interference", on: "D", yards: 0, kind: "live", spotY: Y(78), autoFirst: true } }), cfg).state;
    expect([s.down, yd(s.ballOn)]).toEqual([1, 78]);
  });
});
