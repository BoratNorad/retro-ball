import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type PlayerCard, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { ALL_SLOTS, PACKAGE_SLOTS, nflRoster, slotPos } from "../src/roster.js";
import { simulatePlay } from "../src/engine/play.js";
import { Rng } from "../src/rng.js";
import { fx } from "../src/fixed.js";
import { slotOverall } from "../src/cards.js";

let data: GameData;
let pool: PlayerCard[];
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
});

describe("rosters", () => {
  it("all 32 real teams fill every starting slot with distinct players", () => {
    for (const t of data.teams.teams) {
      const r = nflRoster(t.abbr, pool, data);
      expect(Object.keys(r.starters).sort()).toEqual([...ALL_SLOTS].sort());
      const ids = Object.values(r.starters).map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(r.bench.length).toBeGreaterThan(10);
    }
  });

  it("starters are mostly natural fits (Bills QB is Josh Allen)", () => {
    const r = nflRoster("BUF", pool, data);
    expect(r.starters.QB!.name).toBe("Josh Allen");
    const natural = Object.entries(r.starters).filter(([s, c]) => c.natural.includes(slotPos(s))).length;
    expect(natural).toBeGreaterThanOrEqual(20);
    for (const [s, c] of Object.entries(r.starters)) expect(slotOverall(c, slotPos(s), data)).toBeGreaterThan(40);
  });
});

describe("playbook cross-references", () => {
  const ELIG = ["X", "Y", "Z", "H", "RB"];
  it("formations place QB, the line and five eligibles; personnel and fronts use real roster slots", () => {
    const want = ["QB", "LT", "LG", "C", "RG", "RT", ...ELIG].sort();
    for (const f of data.formations.offense) {
      expect(Object.keys(f.spots).sort(), f.id).toEqual(want);
      for (const p of f.personnel) expect(data.formations.personnel[p], `${f.id}: personnel ${p}`).toBeTruthy();
    }
    const slots = new Set<string>([...ALL_SLOTS, ...PACKAGE_SLOTS]);
    for (const p of Object.values(data.formations.personnel)) for (const r of ELIG) expect(slots.has(p[r]!), `personnel slot ${p[r]}`).toBe(true);
    for (const f of data.formations.defense) {
      expect(Object.keys(f.roles).length, f.id).toBe(11);
      for (const r of Object.values(f.roles)) expect(slots.has(r.slot), `${f.id}: ${r.slot}`).toBe(true);
      for (const r of f.rush) expect(f.roles[r], `${f.id}: rush ${r}`).toBeTruthy();
    }
    expect(data.formations.offense.length).toBeGreaterThanOrEqual(15);
    expect(data.formations.defense.map((f) => f.id)).toEqual(expect.arrayContaining(["base43", "base34", "nickel", "dime", "quarter", "46", "bear", "goal_line"]));
  });

  it("60+ offensive plays reference real formations, routes and roles", () => {
    const fids = new Set(data.formations.offense.map((f) => f.id));
    expect(data.offense.plays.length).toBeGreaterThanOrEqual(60);
    expect(new Set(data.offense.plays.map((p) => p.id)).size).toBe(data.offense.plays.length);
    for (const p of data.offense.plays) {
      for (const f of p.formations) expect(fids.has(f), `${p.id}: formation ${f}`).toBe(true);
      if (p.kind !== "run") {
        expect(p.routes && p.read && p.drop, p.id).toBeTruthy();
        for (const [role, route] of Object.entries(p.routes!)) {
          expect(ELIG.includes(role), `${p.id}: role ${role}`).toBe(true);
          expect(data.routes.routes[route.split(":")[0]!], `${p.id}: route ${route}`).toBeTruthy();
        }
        for (const r of p.read!) expect(p.routes![r] && !data.routes.routes[p.routes![r]!.split(":")[0]!]!.block, `${p.id}: read ${r} must run a route`).toBeTruthy();
      }
      if (p.kind !== "pass") expect(["QB", ...ELIG].includes(p.carrier!) && p.aim && p.block, p.id).toBeTruthy();
    }
  });

  it("defensive calls reference real zones", () => {
    for (const c of data.defense.calls) {
      for (const z of [...c.deep.map((d) => d.zone), ...c.under]) expect(data.defense.zones[z], `${c.id}: zone ${z}`).toBeTruthy();
      for (const f of c.notFrom) expect(data.formations.defense.find((x) => x.id === f), `${c.id}: front ${f}`).toBeTruthy();
    }
    expect(data.defense.calls.length).toBeGreaterThanOrEqual(15);
  });

  it("every play runs from every formation against every front (smoke)", () => {
    const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
    const ratings = (id: number) => byId.get(id) ?? {};
    const o = nflRoster("PHI", pool, data), d = nflRoster("BAL", pool, data);
    let n = 0;
    for (const p of data.offense.plays) for (const f of p.formations) {
      const fo = data.formations.offense.find((x) => x.id === f)!;
      for (const pers of fo.personnel) {
        const front = data.formations.defense[n % data.formations.defense.length]!.id;
        const call = data.defense.calls[(n * 7) % data.defense.calls.length]!;
        const r = simulatePlay({ data, ratings, offense: o, defense: d, offSide: 0, ballOn: fx(35), ballX: fx(26.67), toGo: fx(10),
          play: p, formation: f, personnel: pers, call, front, flip: n % 2 === 1, rng: new Rng("smoke" + n) });
        expect(r.outcome.elapsedTicks, `${p.id}/${f}/${pers}`).toBeGreaterThan(0);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });
});
