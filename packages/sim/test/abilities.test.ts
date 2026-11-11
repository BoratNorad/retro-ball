import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import { createPlay, simulatePlay, type PlayInput, type Stats } from "../src/engine/play.js";
import { abilityKit, activesOf, SIGNATURE } from "../src/engine/abilities.js";
import { GameSession, playGame } from "../src/game.js";
import { Rng } from "../src/rng.js";
import { fromInt, fx, ONE } from "../src/fixed.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const byId = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => byId.get(id) ?? {};
});

const input = (playId: string, callId: string, seed: string, more: Partial<PlayInput> = {}): PlayInput => ({
  data, ratings, offense: nflRoster("BUF", pool, data), defense: nflRoster("KC", pool, data), offSide: 0,
  ballOn: fromInt(30), ballX: fx(26.67), toGo: fromInt(10),
  play: data.offense.plays.find((p) => p.id === playId)!, call: data.defense.calls.find((c) => c.id === callId)!,
  flip: false, rng: new Rng(seed), ...more,
});

describe("abilities", () => {
  it("a kit has passives always, actives only when armed, and parses signature boosts", () => {
    const qb = nflRoster("BUF", pool, data).starters.QB!;
    expect(qb.signature).toBeTruthy();
    const passive = qb.abilities.find((a) => data.abilities.abilities.find((d) => d.id === a.id)?.kind === "P");
    const active = qb.abilities.find((a) => data.abilities.abilities.find((d) => d.id === a.id)?.kind === "A");
    const kit = abilityKit(qb, data, null);
    if (passive) expect(kit.mag(passive.id)).toBeGreaterThan(0);
    if (active) {
      expect(kit.mag(active.id)).toBe(0);
      const armed = abilityKit(qb, data, active.id);
      expect(armed.once(active.id)).toBeGreaterThan(0);
      expect(armed.once(active.id)).toBe(0); // one shot
    }
    const sig = abilityKit(qb, data, SIGNATURE);
    expect(sig.signature).toBe("QB");
    expect(Object.keys(sig.boosts).length).toBeGreaterThan(0);
    expect(abilityKit(qb, data, SIGNATURE, false).mag(passive?.id ?? "x")).toBe(0);
    expect(activesOf(qb, data).some((a) => a.id === SIGNATURE && a.cost === data.abilities.signatures.cost)).toBe(true);
  });

  it("an armed QB signature move makes passes better; it only counts when he is on the field", () => {
    const qb = nflRoster("BUF", pool, data).starters.QB!;
    let base = 0, sig = 0, used = 0;
    const N = 160;
    for (let i = 0; i < N; i++) {
      for (const play of ["curl_flat", "slants", "four_verts"]) {
        const a = simulatePlay(input(play, "cover1", `s${i}`));
        const b = simulatePlay(input(play, "cover1", `s${i}`, { actives: { O: { player: qb.id, ability: SIGNATURE } } }));
        base += (a.outcome.endY - fromInt(30)) / ONE;
        sig += (b.outcome.endY - fromInt(30)) / ONE;
        if (b.activesUsed?.O) used++;
      }
    }
    expect(used).toBe(N * 3);
    expect(sig / (N * 3)).toBeGreaterThan(base / (N * 3) + 0.5);
    // a player who isn't on the field: not used (no momentum spent)
    const r = simulatePlay(input("slants", "cover1", "x", { actives: { O: { player: -5, ability: SIGNATURE } } }));
    expect(r.activesUsed?.O).toBe(false);
    // the abilities ruleset off: identical to no abilities at all, nothing used
    const off = simulatePlay(input("slants", "cover1", "y", { abilities: false, actives: { O: { player: qb.id, ability: SIGNATURE } } }));
    expect(off.activesUsed?.O).toBe(false);
  });

  it("ability popups show in the snapshot when they fire", () => {
    const qb = nflRoster("BUF", pool, data).starters.QB!;
    const sim = createPlay(input("four_verts", "cover1", "fx", { actives: { O: { player: qb.id, ability: SIGNATURE } } }));
    while (!sim.step()) { /* run */ }
    expect((sim.snapshot().fx ?? []).length).toBeGreaterThan(0);
  });

  it("momentum builds from events, is capped, and pays for AI actives; the ruleset can be turned off", () => {
    const teams = () => [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)] as [ReturnType<typeof nflRoster>, ReturnType<typeof nflRoster>];
    const g = new GameSession({ data, ratings, teams: teams(), seed: "mom" });
    let peak = 0;
    while (g.state.phase !== "final") {
      g.stepAuto();
      peak = Math.max(peak, g.momentum[0], g.momentum[1]);
      expect(g.momentum[0]).toBeGreaterThanOrEqual(0);
      expect(g.momentum[0]).toBeLessThanOrEqual(data.tuning.abilities.momentumMax);
    }
    expect(peak).toBeGreaterThan(0);
    const r = g.result();
    expect(r.teams[0].actives + r.teams[1].actives).toBeGreaterThan(0);
    const off = playGame({ data, ratings, teams: teams(), seed: "mom", abilities: false });
    expect(off.teams[0].actives + off.teams[1].actives).toBe(0);
    // deterministic with abilities on
    expect(playGame({ data, ratings, teams: teams(), seed: "mom" }).hash).toBe(r.hash);
  });

  it("a human can arm only what he can afford; momentum is spent only when the play is run", () => {
    const g = new GameSession({ data, ratings, teams: [nflRoster("BUF", pool, data), nflRoster("KC", pool, data)], seed: "arm", userSide: 0 });
    const qb = g.teams[0].starters.QB!;
    const sig = { player: qb.id, ability: SIGNATURE };
    expect(g.affordable(0, sig)).toBe(false);
    g.momentum[0] = data.tuning.abilities.momentumMax;
    expect(g.affordable(0, sig)).toBe(true);
    // get to a scrimmage snap with BUF on offense
    let guard = 0;
    while (!(g.pending().kind === "scrimmage" && g.state.possession === 0) && guard++ < 50) {
      const r = g.snap({});
      if ("live" in r) { while (!r.live.sim.step({ kick: { aim: 0, power: 900, curve: 0 } })) { /* run */ } g.finish(r.live); }
    }
    g.momentum[0] = data.tuning.abilities.momentumMax;
    const play = data.offense.plays.find((p) => p.id === "slants")!;
    const r = g.snap({ userCall: { kind: "play", play, flip: false } });
    expect("live" in r).toBe(true);
    if (!("live" in r)) return;
    let live = g.adjust(r.live, { active: sig });
    expect(live.actives?.O).toEqual(sig);
    live = g.adjust(live, { active: null });
    expect(live.actives?.O ?? null).toBeNull();
    live = g.adjust(live, { active: sig });
    const before = g.momentum[0];
    while (!live.sim.step()) { /* AI QB */ }
    g.finish(live);
    const cost = data.abilities.signatures.cost * data.tuning.abilities.pointsPerBar;
    expect(g.momentum[0]).toBeLessThanOrEqual(before - cost + data.tuning.abilities.gainTouchdown);
    expect(g.momentum[0]).toBeLessThan(data.tuning.abilities.momentumMax);
  });
});
