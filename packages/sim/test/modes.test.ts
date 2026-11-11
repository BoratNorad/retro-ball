import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { teamGrade } from "../src/grade.js";
import { playGame } from "../src/game.js";
import { chooseDefense } from "../src/coach.js";
import { newGame } from "../src/rules.js";
import { Rng } from "../src/rng.js";
import {
  bossRoster, dailyDate, elo, newDaily, newGauntlet, nextGame, rankedSeason, record, recordResult, runScore, runSummary,
} from "../src/modes.js";
import type { Stats } from "../src/engine/play.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const r = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => r.get(id) ?? {};
});

describe("League Bosses", () => {
  it("boss rosters are real, unique, deterministic, and get stronger with strength; focus groups stand out", () => {
    for (const b of data.bosses.bosses) {
      const r = bossRoster(b, 78, data, pool, "s");
      const ids = [...Object.values(r.starters), ...r.bench].map((c) => c.id); // (sub-package players are bench players)
      expect(new Set(ids).size).toBe(ids.length);
      expect(Object.keys(r.starters).length).toBeGreaterThanOrEqual(24);
      expect(JSON.stringify(bossRoster(b, 78, data, pool, "s").starters)).toBe(JSON.stringify(r.starters));
      expect(r.style).toBe(b.style);
    }
    const b = data.bosses.bosses[0]!;
    const g = (s: number) => teamGrade(bossRoster(b, s, data, pool, "x").starters, data).overall.score;
    expect(g(84)).toBeGreaterThan(g(72) + 3);
    const air = bossRoster(data.bosses.bosses.find((x) => x.id === "air_raid")!, 76, data, pool, "f");
    expect(air.starters.QB!.ovr).toBeGreaterThan(air.starters.LT!.ovr);
  });

  it("a blitz boss blitzes far more than a coverage boss", () => {
    const s = newGame(data.rules, 0);
    const count = (id: string) => {
      const r = bossRoster(data.bosses.bosses.find((x) => x.id === id)!, 78, data, pool, "d");
      const rng = new Rng("calls");
      let n = 0;
      for (let k = 0; k < 400; k++) if (chooseDefense(s, data, rng, "11", r).call.tags.includes("blitz")) n++;
      return n;
    };
    expect(count("blitz")).toBeGreaterThan(count("air_raid") * 2);
  });

  it("an NFL team can play a boss to a final whistle", () => {
    const boss = bossRoster(data.bosses.bosses.find((x) => x.id === "ground")!, 80, data, pool, "g");
    const r = playGame({ data, ratings, teams: [nflRoster("BUF", pool, data), boss], seed: "boss" });
    expect(r.state.phase).toBe("final");
  });
});

describe("Boss Gauntlet", () => {
  it("17 weeks, no boss twice in a row, rising strength; 10+ wins adds the playoffs, a loss there ends it", () => {
    let run = newGauntlet("run1", data);
    const G = data.modes.gauntlet;
    expect(run.games).toHaveLength(G.weeks);
    for (let k = 1; k < run.games.length; k++) expect(run.games[k]!.boss).not.toBe(run.games[k - 1]!.boss);
    expect(run.games[G.weeks - 1]!.strength).toBeGreaterThan(run.games[0]!.strength);
    expect(run.games.some((g) => data.bosses.bosses.find((b) => b.id === g.boss)?.final)).toBe(false);
    // win 15, lose 2
    for (let w = 1; w <= G.weeks; w++) run = recordResult(run, w, w === 4 || w === 9 ? 10 : 24, 17, false, data);
    expect(record(run)).toMatchObject({ wins: 15, losses: 2 });
    expect(run.done).toBe(false);
    expect(run.games.filter((g) => g.round)).toHaveLength(G.playoffRounds.length);
    const champ = run.games[run.games.length - 1]!;
    expect(data.bosses.bosses.find((b) => b.id === champ.boss)?.final).toBe(true);
    run = recordResult(run, nextGame(run)!.week, 30, 20, false, data);
    run = recordResult(run, nextGame(run)!.week, 13, 20, false, data);
    expect(run.done).toBe(true);
    expect(nextGame(run)).toBeNull();
    expect(runSummary(run, data)).toContain("lost in the Conference round");
    expect(runScore(run, data)).toBe(15 * G.winPoints + 1 * G.playoffPoints + Math.min(G.pointDiffCap, record(run).pointsFor - record(run).pointsAgainst));
  });

  it("a perfect run: 17-0 and the title", () => {
    let run = newGauntlet("perfect", data);
    while (nextGame(run)) run = recordResult(run, nextGame(run)!.week, 28, 3, true, data);
    expect(run.done).toBe(true);
    expect(runSummary(run, data)).toBe(`${data.modes.gauntlet.weeks}-0 · CHAMPIONS · PERFECT SEASON`);
  });

  it("missing the playoffs ends the run after week 17", () => {
    let run = newGauntlet("bad", data);
    while (nextGame(run)) run = recordResult(run, nextGame(run)!.week, 0, 7, false, data);
    expect(run.games).toHaveLength(data.modes.gauntlet.weeks);
    expect(runSummary(run, data)).toContain("missed the playoffs");
  });

  it("the Daily Draft gauntlet is the same for everyone on a day", () => {
    const d = dailyDate(new Date("2026-11-11T13:00:00Z"));
    expect(d).toBe("2026-11-11");
    expect(newDaily(d, data)).toEqual(newDaily(d, data));
    expect(newDaily(d, data).games.map((g) => g.boss)).not.toEqual(newDaily("2026-11-12", data).games.map((g) => g.boss));
    let run = newDaily(d, data);
    expect(run.games).toHaveLength(data.modes.daily.dailyGames);
    while (nextGame(run)) run = recordResult(run, nextGame(run)!.week, 21, 14, false, data);
    expect(run.done).toBe(true);
    expect(runScore(run, data)).toBe(data.modes.daily.dailyGames * (data.modes.daily.winPoints + 7));
  });
});

describe("ranked", () => {
  it("Elo moves both ratings by the same amount; an upset moves them more", () => {
    const [a, b] = elo(1200, 1200, 1, 32);
    expect(a).toBe(1216); expect(b).toBe(1184);
    const [c] = elo(1000, 1400, 1, 32);
    expect(c - 1000).toBeGreaterThan(a - 1200);
    expect(elo(1300, 1100, 0.5, 32)[0]).toBeLessThan(1300);
    expect(rankedSeason(new Date("2026-11-30T23:00:00Z"))).toBe("2026-11");
  });
});
