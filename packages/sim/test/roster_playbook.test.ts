import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type Creature, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { ALL_SLOTS, nflRoster, slotPos } from "../src/roster.js";
import { slotOverall } from "../src/creatures.js";

let data: GameData;
let pool: Creature[];
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).creatures;
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
  it("formations cover every role", () => {
    const offRoles = Object.keys(data.formations.roles.offense).sort();
    const defRoles = Object.keys(data.formations.roles.defense).sort();
    for (const f of data.formations.offense) expect(Object.keys(f.spots).sort()).toEqual(offRoles);
    for (const f of data.formations.defense) expect(Object.keys(f.spots).sort()).toEqual(defRoles);
    for (const slot of [...Object.values(data.formations.roles.offense), ...Object.values(data.formations.roles.defense)])
      expect(ALL_SLOTS).toContain(slot);
  });

  it("offensive plays reference real formations, routes and roles", () => {
    const fids = new Set(data.formations.offense.map((f) => f.id));
    const roles = new Set(Object.keys(data.formations.roles.offense));
    for (const p of data.offense.plays) {
      for (const f of p.formations) expect(fids.has(f), `${p.id}: formation ${f}`).toBe(true);
      if (p.kind === "pass") {
        expect(p.routes && p.read && p.drop).toBeTruthy();
        for (const [role, route] of Object.entries(p.routes!)) {
          expect(roles.has(role), `${p.id}: role ${role}`).toBe(true);
          expect(data.routes.routes[route], `${p.id}: route ${route}`).toBeTruthy();
        }
        for (const r of p.read!) expect(p.routes![r] && p.routes![r] !== "block", `${p.id}: read ${r} must run a route`).toBeTruthy();
      } else {
        expect(roles.has(p.carrier!) && p.aim && p.block).toBeTruthy();
      }
    }
  });

  it("defensive calls assign every role and reference real zones/targets", () => {
    const defRoles = Object.keys(data.formations.roles.defense).sort();
    const offRoles = new Set(Object.keys(data.formations.roles.offense));
    for (const c of data.defense.calls) {
      expect(Object.keys(c.roles).sort(), c.id).toEqual(defRoles);
      for (const a of Object.values(c.roles)) {
        if (typeof a === "object" && "zone" in a) expect(data.defense.zones[a.zone], `${c.id}: zone ${a.zone}`).toBeTruthy();
        if (typeof a === "object" && "man" in a) expect(offRoles.has(a.man), `${c.id}: man ${a.man}`).toBe(true);
      }
      expect(Object.values(c.roles).filter((a) => a === "rush").length).toBeGreaterThanOrEqual(4);
    }
  });
});
