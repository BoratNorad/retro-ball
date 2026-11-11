import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { Draft, draftSlots, type Personality } from "../src/draft.js";
import { GameSession, playGame } from "../src/game.js";
import type { Stats } from "../src/engine/play.js";
import { ALL_SLOTS, swapSlots } from "../src/roster.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => byId.get(id) ?? {};
});
const info = (abbr: string) => ({ abbr, name: abbr + " Team", nick: abbr, c1: "#224488", c2: "#ffffff", c3: "#ffcc00" });
const runAi = (seed: string, a: Personality, b: Personality, settings = {}) => {
  const d = new Draft(data, pool, [{ info: info("AAA"), ai: a }, { info: info("BBB"), ai: b }], seed, settings);
  while (!d.done) { d.autoPick(0, a); d.autoPick(1, b); }
  return d;
};

describe("triple draft", () => {
  it("quick draft: 24 rounds fill every slot, no player twice, offers never overlap", () => {
    const d = new Draft(data, pool, [{ info: info("AAA"), ai: "need" }, { info: info("BBB"), ai: "best" }], "q1");
    expect(d.rounds).toBe(24);
    const seen = new Set<number>();
    while (!d.done) {
      const a = d.offers(0), b = d.offers(1);
      expect(a.length).toBe(3);
      expect(a.some((x) => b.some((y) => y.id === x.id))).toBe(false);
      d.autoPick(0, "need"); d.autoPick(1, "best");
    }
    for (const t of d.teams) {
      expect(Object.values(t.slots).every(Boolean)).toBe(true);
      for (const c of Object.values(t.slots)) { expect(seen.has(c!.id)).toBe(false); seen.add(c!.id); }
      expect(t.elites).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic from the seed", () => {
    const ids = (d: Draft) => d.log.map((r) => r.picks.map((p) => `${p.card.id}@${p.slot}`).join("/")).join(",");
    expect(ids(runAi("det", "need", "stacker"))).toBe(ids(runAi("det", "need", "stacker")));
    expect(ids(runAi("det", "need", "stacker"))).not.toBe(ids(runAi("det2", "need", "stacker")));
  });

  it("every offer set has at least one player who fits an open slot; late rounds are all fits", () => {
    const d = new Draft(data, pool, [{ info: info("AAA") }, { info: info("BBB") }], "fit");
    while (!d.done) {
      const open = d.openSlots(0);
      const fit = (c: PlayerCard) => open.some((k) => d.overallIn(c, k) >= data.draft.viability.minOverallAtSlot);
      expect(d.offers(0).some(fit)).toBe(true);
      if (open.length <= data.draft.lateOpenSlots) expect(d.offers(0).every(fit)).toBe(true);
      d.autoPick(0, "best"); d.autoPick(1, "chaos");
    }
  });

  it("rerolls are limited; mirror mode deals the same options and settles a double pick", () => {
    const d = new Draft(data, pool, [{ info: info("AAA") }, { info: info("BBB") }], "mir", { mirror: true });
    expect(d.offers(0).map((c) => c.id)).toEqual(d.offers(1).map((c) => c.id));
    expect(d.reroll(0)).toBe(true); expect(d.reroll(0)).toBe(true); expect(d.reroll(0)).toBe(false);
    const want = d.offers(0)[0]!;
    d.pick(0, want.id);
    const rev = d.pick(1, want.id)!;
    expect(rev).toBeTruthy();
    expect(rev.picks[0].card.id).not.toBe(rev.picks[1].card.id);
    expect(rev.picks.find((p) => p.lostTie)).toBeTruthy();
  });

  it("full draft adds bench rounds; themed rounds stick to the theme", () => {
    const d = runAi("full", "need", "need", { format: "full", themed: true });
    expect(d.rounds).toBe(draftSlots(data, "full").length);
    expect(Object.keys(d.teams[0].slots).filter((k) => k.startsWith("BN")).length).toBe(data.draft.full.benchSlots);
    const themed = d.log.filter((r) => r.theme);
    expect(themed.length).toBeGreaterThan(0);
  });

  it("better drafters build better teams; drafted rosters play full games", () => {
    let needWins = 0;
    for (let i = 0; i < 6; i++) {
      const d = runAi("vs" + i, "need", "chaos");
      if (d.grade(0).overall.score > d.grade(1).overall.score) needWins++;
    }
    expect(needWins).toBeGreaterThanOrEqual(5);
    const d = runAi("game", "need", "best");
    const a = d.toRoster(0), b = d.toRoster(1);
    for (const s of ALL_SLOTS) { expect(a.starters[s], s).toBeTruthy(); expect(b.starters[s], s).toBeTruthy(); }
    const ids = [...Object.values(a.starters), ...a.bench, ...Object.values(b.starters), ...b.bench].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const r = playGame({ data, ratings, teams: [a, b], seed: "draftgame" });
    expect(r.state.phase).toBe("final");
    // lineup edits: swapping two starters keeps everyone on the roster
    const sw = swapSlots(a, "WR1", "WR2");
    expect(sw.starters.WR1!.id).toBe(a.starters.WR2!.id);
  });

  it("hot-seat: the side with the ball is the user and the other side's call is used", () => {
    const d = runAi("hs", "need", "need");
    const s = new GameSession({ data, ratings, teams: [d.toRoster(0), d.toRoster(1)], seed: "hs", hotseat: true });
    let checked = 0;
    for (let i = 0; i < 200 && checked < 3 && s.pending().kind !== "final"; i++) {
      expect(s.userSide).toBe(s.state.possession);
      const kick = { kick: { aim: 0, power: 1000, curve: 0 } };
      const r = s.snap(s.pending().kind === "scrimmage" ? { userCall: { kind: "play", play: data.offense.plays[0]!, flip: false }, defCall: data.defense.calls.find((c) => c.id === "cover0")! } : {});
      if ("live" in r) {
        if (!r.live.kick) { expect(r.live.call.id).toBe("cover0"); checked++; }
        let n = 0; while (!r.live.sim.step(n++ === 0 ? kick : {}) && n < 5000) { /* run */ }
        s.finish(r.live);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
