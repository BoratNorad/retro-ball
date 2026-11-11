import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { createPlay, simulatePlay, type PlayInput, type Stats } from "../src/engine/play.js";
import { Rng } from "../src/rng.js";
import { fromInt, fx } from "../src/fixed.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => byId.get(id) ?? {};
});

const input = (playId: string, callId: string, seed: string, more: Partial<PlayInput> = {}): PlayInput => ({
  data, ratings, offense: nflRoster("BUF", pool, data), defense: nflRoster("KC", pool, data), offSide: 0,
  ballOn: fromInt(30), ballX: fx(26.67), toGo: fromInt(10),
  play: data.offense.plays.find((p) => p.id === playId)!, call: data.defense.calls.find((c) => c.id === callId)!,
  flip: false, rng: new Rng(seed), ...more,
});

describe("interactive play engine", () => {
  it("stepping a play by hand gives exactly the same result as simulatePlay", () => {
    for (const [p, c] of [["slants", "cover3"], ["inside_zone", "cover1"], ["four_verts", "cover2"]] as const) {
      const a = simulatePlay(input(p, c, "eq"));
      const sim = createPlay(input(p, c, "eq"));
      let n = 0;
      while (!sim.step()) n++;
      expect(sim.result().outcome).toEqual(a.outcome);
      expect(sim.result().log).toEqual(a.log);
      expect(sim.snapshot().done).toBe(true);
      expect(n).toBeGreaterThan(10);
    }
  });

  it("with a human QB the AI never throws; a throw at an open receiver can be caught", () => {
    let caught = 0, waited = 0;
    for (let i = 0; i < 40; i++) {
      const sim = createPlay(input("curl_flat", "cover2", "h" + i, { userOffense: true }));
      // wait 1.6 s without input: the QB must still have the ball
      for (let t = 0; t < 48 && !sim.step(); t++);
      const snap = sim.snapshot();
      if (snap.qbCanThrow) waited++;
      if (!snap.qbCanThrow) continue;
      // throw a bullet at the slot receiver running the flat
      const slot = snap.actors.find((a) => a.side === "O" && a.role === "H")!;
      sim.step({ throwAt: { x: slot.x + slot.vx / 3, y: slot.y + slot.vy / 3, power: 1 } });
      while (!sim.step());
      if (sim.result().log.some((l) => l.startsWith("caught by"))) caught++;
    }
    expect(waited).toBeGreaterThan(30);   // no auto-throws (a few plays end in sacks)
    expect(caught).toBeGreaterThan(15);
  });

  it("move input steers the ball carrier; actions respect cooldowns", () => {
    const sim = createPlay(input("inside_zone", "cover3", "steer", { userOffense: true }));
    for (let t = 0; t < 6; t++) sim.step();
    const before = sim.snapshot();
    const rb = before.actors[before.carrier]!;
    // hard left for half a second
    for (let t = 0; t < 15 && !sim.step({ move: { x: -fx(1), y: 0 } }); t++);
    const after = sim.snapshot();
    if (!after.done) {
      const rb2 = after.actors[after.carrier]!;
      expect(rb2.x).toBeLessThan(rb.x - fx(1));
      expect(after.userCarrier).toBe(true);
      sim.step({ action: "juke", move: { x: 0, y: fx(1) } });
      const cd = sim.snapshot().cooldowns.juke;
      expect(cd).toBeGreaterThan(0);
      sim.step({ action: "juke" });
      expect(sim.snapshot().cooldowns.juke).toBe(cd - 1); // second juke ignored while cooling down
    }
  });
});

describe("M4 play calling", () => {
  it("defensive calls compile against any front: Cover 0 sends 6+, Cover 3 drops 3 deep", () => {
    for (const front of ["base43", "nickel", "dime", "base34", "bear"]) {
      for (const [callId, minRush, deep] of [["cover0", 6, 0], ["cover3", 4, 3], ["cover2", 3, 2]] as const) {
        const sim = createPlay(input("slants", callId, "c" + front, { front }));
        const tasks = sim.assignments().map((a) => a.task);
        expect(tasks.filter((t) => t === "rush").length, `${front} ${callId}`).toBeGreaterThanOrEqual(minRush);
        expect(tasks.filter((t) => t.startsWith("deep")).length, `${front} ${callId}`).toBe(deep);
      }
    }
  });

  it("read option: a human can keep it; the AI gives or keeps", () => {
    let kept = 0;
    for (let i = 0; i < 6; i++) {
      const sim = createPlay(input("zone_read", "cover3", "opt" + i, { userOffense: true }));
      expect(sim.snapshot().canKeep).toBe(true);
      sim.step({ action: "keep" });
      while (!sim.step({})) { /* run */ }
      if (sim.result().log.some((l) => l.includes("keeps it"))) kept++;
    }
    expect(kept).toBe(6);
  });

  it("defensive control mode: the human defender dives at a carrier in range", () => {
    let opps = 0, dives = 0;
    for (let i = 0; i < 30; i++) {
      const sim = createPlay(input(i % 2 ? "outside_zone" : "slants", "cover3", "dv" + i, { userDefense: true }));
      let t = 0, done = false, tried = false;
      while (!done && t++ < 400) {
        const sn = sim.snapshot();
        expect(sn.userDefender).toBeGreaterThanOrEqual(11);
        const me = sn.actors[sn.userDefender]!, c = sn.actors[sn.carrier];
        const close = !tried && c && c.side === "O" && !sn.qbCanThrow && Math.hypot(c.x - me.x, c.y - me.y) < fx(2.3);
        if (close) { opps++; tried = true; }
        done = sim.step(close ? { action: "dive" } : {});
      }
      if (sim.result().log.some((l) => l.includes("dives"))) dives++;
    }
    expect(opps).toBeGreaterThan(0);
    expect(dives).toBeGreaterThanOrEqual(Math.floor(opps * 0.8)); // an engaged or stunned defender cannot dive
  });
});

describe("M5 pre-snap", () => {
  const xOf = (sim: ReturnType<typeof createPlay>, side: "O" | "D", role: string) => sim.snapshot().actors.find((a) => a.side === side && a.role === role)!;
  it("motion waits for the snap; a man defender follows the motion man (zone defenders stay)", () => {
    const man = createPlay(input("slants", "cover1", "m1", { userOffense: true, preOff: { motion: { role: "H", kind: "across" } } }));
    expect(man.snapshot().presnap).toBe(true);
    const asg = man.assignments().find((a) => a.task === "man:H")!;
    const h0 = xOf(man, "O", "H").x;
    for (let i = 0; i < 90; i++) man.step({});
    expect(man.snapshot().presnap).toBe(true);
    const h1 = xOf(man, "O", "H").x;
    expect(Math.abs(h1 - h0)).toBeGreaterThan(fx(8));
    expect(Math.abs(xOf(man, "D", asg.role).x - h1)).toBeLessThan(fx(3));
    man.step({ snap: true });
    expect(man.snapshot().presnap).toBe(false);
    const zone = createPlay(input("slants", "cover3", "m1", { userOffense: true, preOff: { motion: { role: "H", kind: "across" } } }));
    const zs = zone.snapshot().actors.filter((a) => a.side === "D").map((a) => a.x);
    for (let i = 0; i < 60; i++) zone.step({});
    expect(zone.snapshot().actors.filter((a) => a.side === "D").map((a) => a.x)).toEqual(zs);
  });

  it("the AI snaps a jet sweep on its own and the jet man carries", () => {
    const r = simulatePlay(input("jet_sweep", "cover3", "j1"));
    expect(r.log.some((l) => l.includes("jet motion"))).toBe(true);
    expect(r.outcome.elapsedTicks).toBeGreaterThan(0);
  });

  it("hot routes, keep-in and defensive looks change the lineup", () => {
    const base = createPlay(input("four_verts", "cover3", "h1"));
    const hot = createPlay(input("four_verts", "cover3", "h1", { preOff: { hot: { X: "slant" }, keepIn: ["H"] } }));
    const routeOf = (sim: ReturnType<typeof createPlay>, role: string) => { const sn = sim.snapshot(); const i = sn.actors.findIndex((a) => a.side === "O" && a.role === role); return sn.routes.find((r) => r.i === i); };
    expect(routeOf(hot, "X")!.pts).not.toEqual(routeOf(base, "X")!.pts);
    expect(routeOf(hot, "H")).toBeUndefined();
    const press = createPlay(input("slants", "cover1", "h1", { preDef: { corners: "press", safeties: "two", show: true } }));
    const sn = press.snapshot();
    const cb = sn.actors.find((a) => a.side === "D" && a.role === "LCB")!;
    expect(cb.y - sn.los).toBeLessThan(fx(2));
    const mlb = sn.actors.find((a) => a.side === "D" && a.role === "MLB")!;
    expect(mlb.y - sn.los).toBeLessThan(fx(2.5));
    // cover 1 called, two-high shown: both safeties stand deep and wide
    const ss = sn.actors.filter((a) => a.side === "D" && (a.role === "FS" || a.role === "SS"));
    expect(ss.every((a) => a.y - sn.los > fx(12))).toBe(true);
    expect(press.assignments().filter((a) => a.task.startsWith("deep")).length).toBe(1);
  });

  it("spy and double-team overrides", () => {
    const sim = createPlay(input("slants", "cover3", "s1", { preDef: { spy: "MLB", double: "Z" } }));
    const a = sim.assignments();
    expect(a.find((x) => x.role === "MLB")!.task).toBe("spy");
    expect(a.filter((x) => x.task === "man:Z").length).toBe(1);
  });
});
