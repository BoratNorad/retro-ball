import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { GameSession, playGame } from "../src/game.js";
import { drives, highlightOf, replayFrames, type TickInput } from "../src/replay.js";
import type { Stats, UserInput } from "../src/engine/play.js";
import { fx } from "../src/fixed.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const r = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => r.get(id) ?? {};
});

describe("replays and drives", () => {
  it("a recorded play replays exactly from its seed + input log (human offense, kicks too)", () => {
    const g = new GameSession({ data, ratings, teams: [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)], seed: "rep", userSide: 0 });
    let checked = 0, highlights = 0;
    for (let n = 0; n < 60 && g.state.phase !== "final"; n++) {
      const userOff = g.isUserOffense();
      const play = data.offense.plays.find((p) => p.id === (n % 2 ? "slants" : "inside_zone"))!;
      const r = g.snap(userOff && g.pending().kind === "scrimmage" ? { userCall: { kind: "play", play, flip: false } } : {});
      if ("done" in r) continue;
      const inputs: TickInput[] = [];
      for (let t = 0; t < 1500; t++) {
        const s = r.live.sim.snapshot();
        let u: UserInput | null = null;
        if (r.live.kick?.userKick && s.kick?.awaitingKick) u = { kick: { aim: 0, power: 850, curve: 0 } };
        else if (r.live.userOffense && s.qbCanThrow && t === 40) { const x = s.actors.find((a) => a.role === "X")!; u = { throwAt: { x: x.x, y: x.y + fx(4), power: 0.6 } }; }
        else if (r.live.userOffense && s.userCarrier) u = { move: { x: 0, y: fx(1) } };
        inputs.push([u, undefined]);
        if (r.live.sim.step(u)) break;
      }
      const frames = replayFrames(r.live.remake, inputs);
      const last = frames[frames.length - 1]!;
      expect(last.done).toBe(true);
      expect(JSON.stringify(last.ball)).toBe(JSON.stringify(r.live.sim.snapshot().ball));
      expect(last.tick).toBe(r.live.sim.snapshot().tick);
      const sum = g.finish(r.live);
      if (highlightOf(sum)) highlights++;
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    expect(highlights).toBeGreaterThan(0);
  });

  it("a game splits into drives that add up", () => {
    const res = playGame({ data, ratings, teams: [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)], seed: "drives" });
    const d = drives(res.log, data.rules.quarterSeconds, data.rules.tickHz);
    expect(d.length).toBeGreaterThan(12);
    // every offensive touchdown ends a drive
    expect(d.filter((x) => x.result === "Touchdown").length).toBe(res.teams[0].passTd + res.teams[0].rushTd + res.teams[1].passTd + res.teams[1].rushTd);
    for (const x of d) { expect(x.plays).toBeGreaterThan(0); expect(x.result.length).toBeGreaterThan(0); expect(x.seconds).toBeGreaterThanOrEqual(0); }
    const plays = d.reduce((a, x) => a + x.plays, 0);
    expect(plays).toBeGreaterThan(res.teams[0].plays + res.teams[1].plays - 5);
  });
});
