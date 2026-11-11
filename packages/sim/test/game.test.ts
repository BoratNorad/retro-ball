import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { GameSession, playGame, type LivePlay } from "../src/game.js";
import { suggestPlays } from "../src/coach.js";
import { fromInt } from "../src/fixed.js";
import type { Stats } from "../src/engine/play.js";

let data: GameData;
let ratings: (id: number) => Stats;
let pool: ReturnType<typeof PoolFileSchema.parse>["players"];
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
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

/** Step a live play to the end; a human kick gets a straight, full-power flick. */
function runOut(live: LivePlay) {
  const kick = live.kick?.userKick ? { kick: { aim: 0, power: 1000, curve: 0 } } : {};
  let n = 0;
  while (!live.sim.step(n++ === 0 ? kick : {}) && n < 5000) { /* run */ }
}

describe("play calling (M4)", () => {
  it("the human defense sees the AI's personnel before calling, and the snap uses that same call", () => {
    const s = new GameSession({ data, ratings, teams: [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)], seed: "pv", userSide: 0 });
    let checked = 0;
    for (let i = 0; i < 300 && checked < 5 && s.pending().kind !== "final"; i++) {
      const p = s.pending();
      if (p.kind === "scrimmage" && !s.isUserOffense()) {
        const dec = s.previewAiOffense();
        const r = s.snap({ defCall: data.defense.calls[0], defFront: "nickel" });
        if ("live" in r && dec?.kind === "play") {
          expect(r.live.personnel).toBe(dec.personnel);
          expect(r.live.play.id).toBe(dec.play.id);
          expect(r.live.front).toBe("nickel");
          checked++;
        }
        if ("live" in r) { runOut(r.live); s.finish(r.live); }
        continue;
      }
      const r = s.snap(s.isUserOffense() && p.kind === "scrimmage" ? { userCall: { kind: "play", play: data.offense.plays[0]!, flip: false } } : {});
      if ("live" in r) { runOut(r.live); s.finish(r.live); }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("suggested plays fit the situation: short yardage favours runs, 3rd and long favours passes", () => {
    const s = new GameSession({ data, ratings, teams: [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)], seed: "sg" });
    const st = { ...s.state, phase: "play" as const, down: 3, ballOn: fromInt(40) };
    const short = suggestPlays({ ...st, toGo: fromInt(1) }, s.teams[0], data, ratings);
    const long = suggestPlays({ ...st, toGo: fromInt(14) }, s.teams[0], data, ratings);
    expect(short.filter((c) => c.play.kind !== "pass").length).toBeGreaterThan(short.length / 2);
    expect(long.filter((c) => c.play.kind === "pass").length).toBeGreaterThan(long.length / 2);
    for (const c of [...short, ...long]) expect(c.play.formations).toContain(c.formation);
  });
});

describe("pre-snap (M5)", () => {
  const mk = (seed: string) => new GameSession({ data, ratings, teams: [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)], seed, userSide: 0 });
  const toUserSnap = (s: GameSession) => {
    for (let i = 0; i < 200; i++) {
      if (s.pending().kind === "scrimmage" && s.isUserOffense()) return;
      const r = s.snap({});
      if ("live" in r) { runOut(r.live); s.finish(r.live); }
    }
  };
  it("adjust() re-lines up with the same luck: the same adjustments replay the same play", () => {
    const s = mk("adj");
    toUserSnap(s);
    const r = s.snap({ userCall: { kind: "play", play: data.offense.plays.find((p) => p.id === "slants")!, flip: false } });
    if (!("live" in r)) return;
    const a = s.adjust(r.live, { preOff: { hot: { X: "go" } } });
    const b = s.adjust(r.live, { preOff: { hot: { X: "go" } } });
    while (!a.sim.step()); while (!b.sim.step());
    expect(JSON.stringify(a.sim.result().outcome)).toBe(JSON.stringify(b.sim.result().outcome));
    const aud = s.adjust(r.live, { play: data.offense.plays.find((p) => p.id === "inside_zone")! });
    expect(aud.play.id).toBe("inside_zone");
    expect(aud.personnel).toBe(r.live.personnel);
  });
  it("delay of game costs 5 yards; a hard count is once per play", () => {
    const s = mk("dog");
    toUserSnap(s);
    const before = s.state.ballOn;
    const r = s.snap({ userCall: { kind: "play", play: data.offense.plays[0]!, flip: false } });
    if (!("live" in r)) return;
    const hc = s.hardCount(r.live);
    expect(s.hardCount(r.live)).toBeNull();
    if (hc) return; // somebody jumped: that play is over
    const d = s.delayOfGame(r.live);
    expect(d.entry.result.split(" [")[0]).toBe("Delay of game");
    expect(s.state.ballOn).toBe(before - fromInt(5));
  });
});
