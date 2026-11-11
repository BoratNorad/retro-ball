import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { createKick, kickChance, type KickPlayInput } from "../src/engine/special.js";
import type { Stats } from "../src/engine/play.js";
import { Rng } from "../src/rng.js";
import { fx } from "../src/fixed.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => byId.get(id) ?? {};
});
const inp = (kind: KickPlayInput["kind"], seed: string, more: Partial<KickPlayInput> = {}): KickPlayInput => ({
  data, ratings, kicking: nflRoster("BAL", pool, data), receiving: nflRoster("CHI", pool, data), kickSide: 0, kind,
  spot: kind === "kickoff" || kind === "squib" || kind === "onside" ? fx(35) : fx(70), ballX: fx(26.67), rng: new Rng(seed),
  wind: { x: 0, y: 0 }, pressure: false, ...more,
});
const run = (k: KickPlayInput, first: Parameters<ReturnType<typeof createKick>["step"]>[0] = {}) => {
  const sim = createKick(k);
  let n = 0;
  while (!sim.step(n++ === 0 ? first : {}) && n < 2000) { /* run */ }
  return sim.result();
};

describe("special teams", () => {
  it("field-goal chances fall with distance and with a strong crosswind", () => {
    const ch = (ballOn: number, wind = { x: 0, y: 0 }) => kickChance(data, 92, 88, "fieldGoal", fx(ballOn), wind, false);
    expect(ch(85)).toBeGreaterThanOrEqual(ch(70));
    expect(ch(70)).toBeGreaterThan(ch(60));
    expect(ch(60)).toBeGreaterThan(ch(55));
    expect(ch(60, { x: fx(20), y: 0 })).toBeLessThan(ch(60));
  });

  it("a kick replays exactly from the same seed", () => {
    for (const kind of ["kickoff", "punt", "fieldGoal", "onside", "squib"] as const) {
      expect(JSON.stringify(run(inp(kind, "rep")).outcome)).toBe(JSON.stringify(run(inp(kind, "rep")).outcome));
    }
  });

  it("a human kicker's play waits for the flick; aim matters", () => {
    const sim = createKick(inp("fieldGoal", "h", { userKick: true }));
    for (let i = 0; i < 50; i++) expect(sim.step({})).toBe(false);
    expect(sim.snapshot().kick!.awaitingKick).toBe(true);
    let straight = 0, wide = 0;
    for (let i = 0; i < 20; i++) {
      if (run(inp("fieldGoal", "s" + i, { userKick: true }), { kick: { aim: 0, power: 950, curve: 0 } }).outcome.good) straight++;
      if (run(inp("fieldGoal", "s" + i, { userKick: true }), { kick: { aim: 250, power: 950, curve: 0 } }).outcome.good) wide++;
    }
    expect(straight).toBeGreaterThan(14);
    expect(wide).toBeLessThan(3);
  });

  it("returns, fair catches, onside recoveries and blocks all happen", () => {
    let ret = 0, fair = 0, onside = 0, blocked = 0, tb = 0;
    for (let i = 0; i < 120; i++) {
      const k = run(inp("kickoff", "k" + i));
      if (k.meta.touchback) tb++; else if (k.meta.returnYds > 0) ret++;
      if (run(inp("punt", "p" + i)).meta.fairCatch) fair++;
      if (run(inp("onside", "o" + i)).meta.kickingRecovered) onside++;
      if (run(inp("fieldGoal", "b" + i, { stDefense: "block" })).meta.blocked) blocked++;
    }
    expect(ret).toBeGreaterThan(20); expect(tb).toBeGreaterThan(10);
    expect(fair).toBeGreaterThan(5);
    expect(onside).toBeGreaterThan(2); expect(onside).toBeLessThan(50);
    expect(blocked).toBeGreaterThan(0); expect(blocked).toBeLessThan(25);
  });

  it("a human returner can call a fair catch", () => {
    const sim = createKick(inp("punt", "fc", { userReturn: true }));
    let n = 0;
    while (!sim.step(sim.snapshot().kick!.canFairCatch ? { action: "fairCatch" } : {}) && n++ < 2000) { /* run */ }
    const r = sim.result();
    expect(r.meta.fairCatch || r.meta.touchback || r.meta.muffed || r.log.some((l) => l.includes("downed") || l.includes("rest") || l.includes("bounds"))).toBe(true);
  });
});
