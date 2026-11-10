import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type Creature, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import {
  buildPool, outOfPositionPenalty, overallAt, poolHash, rarityOf, slotOverall, typeChart, typeModifier,
} from "../src/creatures.js";
import { letterFor, teamGrade, type Lineup } from "../src/grade.js";

let data: GameData;
let pool: Creature[];
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

describe("types", () => {
  it("chart: every type strong vs exactly 2 and weak vs exactly 2, never both ways", () => {
    const chart = typeChart(data);
    for (const [t, strong] of chart) {
      expect(strong.size).toBe(2);
      const weak = [...chart].filter(([, s]) => s.has(t)).map(([k]) => k);
      expect(weak).toHaveLength(2);
      for (const s of strong) expect(chart.get(s)!.has(t)).toBe(false);
    }
  });

  it("modifier is symmetric and bounded", () => {
    const m = data.types.modifier;
    expect(typeModifier(["BLAZE"], ["SHADOW"], data)).toBe(m);
    expect(typeModifier(["SHADOW"], ["BLAZE"], data)).toBe(-m);
    expect(typeModifier(["BLAZE"], ["BLAZE"], data)).toBe(0);
  });

  it("every creature has 1-2 types, each eligible for its position group", () => {
    for (const c of pool) {
      expect(c.types.length).toBeGreaterThanOrEqual(1);
      for (const t of c.types) expect(data.types.types.find((d) => d.id === t)!.eligible).toContain(c.group);
    }
  });
});

describe("rarity, abilities, grades", () => {
  it("rarity follows the configured thresholds", () => {
    expect(rarityOf(99, data)).toBe("MYTHIC");
    expect(rarityOf(85, data)).toBe("EPIC");
    expect(rarityOf(70, data)).toBe("RARE");
    expect(rarityOf(55, data)).toBe("COMMON");
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
    expect(g.offense.letter).toMatch(/^[A-F][+-]?$/);
  });
});
