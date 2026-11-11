import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type PlayerCard, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import {
  buildPool, outOfPositionPenalty, overallAt, poolHash, slotOverall, tierOfOvr,
} from "../src/cards.js";
import { letterFor, teamGrade, type Lineup } from "../src/grade.js";

let data: GameData;
let pool: PlayerCard[];
beforeAll(async () => {
  data = await nodeGameData();
  pool = buildPool(data);
});

describe("data files", () => {
  it("all data and config files pass their schemas", () => {
    expect(data.players.players.length).toBeGreaterThan(1900);
    expect(data.teams.teams).toHaveLength(32);
    expect(data.abilities.abilities.length).toBeGreaterThanOrEqual(50);
  });

  it("committed pool.json is valid and up to date with the generator", () => {
    const file = PoolFileSchema.parse(readShared("data/pool.json"));
    expect(file.hash).toBe(poolHash(pool));
  });

  it("pool generation is deterministic", () => {
    expect(poolHash(buildPool(data))).toBe(poolHash(pool));
  });
});

describe("position overalls", () => {
  it("reproduce Madden's own overall at the player's real position (fit check)", () => {
    let within3 = 0;
    for (const p of data.players.players) {
      const home = data.positions.maddenToGame[p.pos]!;
      if (Math.abs(overallAt(p.stats, home, data) - p.ovr) <= 3) within3++;
    }
    expect(within3 / data.players.players.length).toBeGreaterThan(0.93);
  });

  it("every creature has an overall at every position and its home position is natural", () => {
    for (const c of pool) {
      for (const pos of data.positions.positions) expect(c.overallAt[pos.id]).toBeTypeOf("number");
      expect(c.natural[0]).toBe(c.pos);
      expect(c.overallAt[c.pos]).toBe(c.ovr);
      expect(c.natural.length).toBeLessThanOrEqual(data.positions.naturalPositions.max);
    }
  });

  it("playing out of position costs overall", () => {
    const qb = pool.find((c) => c.name === "Josh Allen" && c.pos === "QB")!;
    expect(outOfPositionPenalty(qb.natural, "QB", data)).toBe(0);
    expect(slotOverall(qb, "CB", data)).toBeLessThan(qb.ovr - 20);
    expect(outOfPositionPenalty(["DE"], "DT", data)).toBe(data.positions.outOfPosition.sameGroup);
    expect(outOfPositionPenalty(["DE"], "OLB", data)).toBe(data.positions.outOfPosition.adjacentGroup);
    expect(outOfPositionPenalty(["DE"], "WR", data)).toBe(data.positions.outOfPosition.otherGroup);
  });
});

describe("real-football identity", () => {
  it("cards keep the Madden archetype and real bio, with no invented attributes", () => {
    const allen = pool.find((c) => c.name === "Josh Allen" && c.pos === "QB")!;
    expect(allen.arch).toBe("Improviser");
    expect([allen.htIn, allen.wt]).toEqual([77, 237]);
    expect(Object.keys(allen)).not.toContain("types");
  });
});

describe("tiers, abilities, grades", () => {
  it("talent tiers follow the configured overall thresholds", () => {
    expect(tierOfOvr(99, data)).toBe("ELITE");
    expect(tierOfOvr(85, data)).toBe("PRO_BOWL");
    expect(tierOfOvr(70, data)).toBe("STARTER");
    expect(tierOfOvr(55, data)).toBe("DEPTH");
  });

  it("every creature has a passive and an active ability; 88+ get a signature", () => {
    const kind = new Map(data.abilities.abilities.map((a) => [a.id, a.kind]));
    for (const c of pool) {
      expect(c.abilities.some((a) => kind.get(a.id) === "P")).toBe(true);
      expect(c.abilities.some((a) => kind.get(a.id) === "A")).toBe(true);
      expect(Boolean(c.signature)).toBe(c.ovr >= data.abilities.signatures.minOvr);
      for (const a of c.abilities) expect(a.text).not.toContain("{a}");
    }
  });

  it("letter grades and a real team's grade are sensible", () => {
    expect(letterFor(95, data)).toBe("A+");
    expect(letterFor(10, data)).toBe("F");
    const bills = data.teams.teams.find((t) => t.abbr === "BUF")!;
    const lineup: Lineup = {};
    const slotMap: Record<string, string> = { HB: "RB", WR1: "WR", WR2: "WR#2", WR3: "WR#3", LEDG: "DE", REDG: "DE#2",
      DT1: "DT", DT2: "DT#2", SAM: "OLB", WILL: "OLB#2", MIKE: "MLB", CB1: "CB", CB2: "CB#2" };
    for (const [slot, id] of Object.entries(bills.lineup)) {
      const c = pool.find((x) => x.id === id);
      if (c) lineup[slotMap[slot] ?? slot] = c;
    }
    const g = teamGrade(lineup, data);
    expect(g.overall.score).toBeGreaterThan(70);
    expect(g.overall.score).toBeLessThan(95);
    expect(g.chemistry.total).toBeLessThanOrEqual(data.grade.chemistry.maxTotal);
    // a real team's QB throws to his own receivers and its line plays together -> chemistry
    expect(g.chemistry.qbTargets).toBeGreaterThan(0);
    expect(g.chemistry.olCohesion).toBeGreaterThan(0);
    expect(g.offense.letter).toMatch(/^[A-F][+-]?$/);
  });
});
