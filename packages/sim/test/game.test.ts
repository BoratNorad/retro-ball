import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { playGame } from "../src/game.js";
import type { Stats } from "../src/engine/play.js";

let data: GameData;
let ratings: (id: number) => Stats;
let pool: ReturnType<typeof PoolFileSchema.parse>["creatures"];
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).creatures;
  const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => byId.get(id) ?? {};
});

const game = (seed: string, a = "BUF", b = "KC") =>
  playGame({ data, ratings, teams: [nflRoster(a, pool, data), nflRoster(b, pool, data)], seed });

describe("full games", () => {
  it("a game runs to a final whistle with a sane box score", () => {
    const r = game("test-1");
    expect(r.state.phase).toBe("final");
    expect(r.state.quarter).toBeGreaterThanOrEqual(4);
    expect(r.teams[0].score).toBe(r.state.score[0]);
    expect(r.teams[0].plays + r.teams[1].plays).toBeGreaterThan(80);
    for (const t of r.teams) {
      expect(t.byQuarter.reduce((x, y) => x + y, 0)).toBe(t.score);
      expect(t.passComp).toBeLessThanOrEqual(t.passAtt);
    }
  });

  it("replay determinism: the same seed gives the identical game (state hash)", () => {
    const a = game("determinism"), b = game("determinism");
    expect(a.hash).toBe(b.hash);
    expect(a.log.map((p) => p.result)).toEqual(b.log.map((p) => p.result));
    expect(game("determinism-2").hash).not.toBe(a.hash);
  });
});
