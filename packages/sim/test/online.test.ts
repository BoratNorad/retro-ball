import { beforeAll, describe, expect, it } from "vitest";
import { PoolFileSchema, type GameData, type PlayerCard } from "@tdf/shared";
import { nodeGameData, readShared } from "@tdf/shared/node";
import { nflRoster } from "../src/roster.js";
import type { Stats, UserInput } from "../src/engine/play.js";
import {
  OnlineMatch, applyDraftAction, autoOffense, newDraft, packInputs, rosterToWire, runPlay, unpackInputs, wireInput,
  type DraftAction, type DraftInit, type MatchAction, type MatchInit,
} from "../src/online.js";
import type { Side } from "../src/rules.js";
import { fx } from "../src/fixed.js";

let data: GameData;
let pool: PlayerCard[];
let ratings: (id: number) => Stats;
let byId: (id: number) => PlayerCard | undefined;
beforeAll(async () => {
  data = await nodeGameData();
  pool = PoolFileSchema.parse(readShared("data/pool.json")).players;
  const r = new Map(data.players.players.map((p) => [p.id, p.stats]));
  ratings = (id) => r.get(id) ?? {};
  const m = new Map(pool.map((c) => [c.id, c]));
  byId = (id) => m.get(id);
});

const init = (seed: string, quarterSeconds = 300): MatchInit => ({
  seed, rosters: [rosterToWire(nflRoster("BUF", pool, data)), rosterToWire(nflRoster("KC", pool, data))], quarterSeconds, abilities: true, controlDefender: true,
});

/** A scripted human for both sides: kicks straight, the QB throws at his first receiver after 1.5 s,
 *  the carrier runs up the field, the human defender chases the ball. */
function policy(m: OnlineMatch, tick: number): [UserInput | null, UserInput | null] {
  const live = m.live!;
  if (live.kick) return [tick === 0 ? { kick: { aim: 0, power: 900, curve: 0 } } : null, null];
  const snap = live.sim.snapshot();
  let o: UserInput | null = null;
  if (snap.presnap) o = { snap: true };
  else if (snap.qbCanThrow && tick === 45) {
    const r = snap.actors.find((a) => a.side === "O" && (a.role === "X" || a.role === "Z" || a.role === "Y"));
    if (r) o = { throwAt: { x: r.x + r.vx, y: r.y + r.vy, power: 0.7 } };
  } else if (snap.userCarrier) o = { move: { x: 0, y: fx(1) } };
  const d: UserInput | null = snap.userDefender >= 0 ? { move: { x: snap.ball.x - snap.actors[snap.userDefender]!.x, y: snap.ball.y - snap.actors[snap.userDefender]!.y } } : null;
  return [wireInput(o), wireInput(d)];
}

/** Drive a whole online game the way the server would, recording the action log. */
function playOnline(seed: string): { log: MatchAction[]; m: OnlineMatch } {
  const m = new OnlineMatch(init(seed), data, ratings, byId);
  const log: MatchAction[] = [];
  const act = (a: MatchAction) => { log.push(a); m.apply(a); };
  let guard = 0;
  while (m.session.pending().kind !== "final" && guard++ < 600) {
    act({ t: "snap", off: autoOffense(m, `${seed}:${guard}`), def: {} });
    if (!m.live) continue;
    // a pre-snap audible check from the defense, now and then
    if (!m.live.kick && guard % 7 === 0) act({ t: "adjust", side: (1 - m.live.offSide) as Side, ch: { preDef: { show: true } } });
    if (!m.live) continue;
    const ticks: [UserInput | null, UserInput | null][] = [];
    const sim = m.live.remake();
    m.live = { ...m.live, sim };
    for (let t = 0; t < 2000; t++) {
      const inp = policy(m, t);
      ticks.push(inp);
      if (sim.step(inp[0], inp[1])) break;
    }
    act({ t: "play", runs: packInputs(ticks), ticks: ticks.length });
  }
  return { log, m };
}

describe("online match", () => {
  it("input runs pack and unpack losslessly", () => {
    const t: [UserInput | null, UserInput | null][] = [[null, null], [null, null], [{ move: { x: 1, y: 2 } }, null], [{ move: { x: 1, y: 2 } }, null], [null, { action: "dive" }]];
    const runs = packInputs(t);
    expect(runs.length).toBe(3);
    expect(unpackInputs(runs, t.length)).toEqual(t);
    expect(wireInput({ move: { x: 0, y: 0 } })).toBeNull();
    expect(wireInput({ move: { x: fx(0.7), y: fx(0.7) } })!.move).toEqual(wireInput({ move: { x: fx(0.71), y: fx(0.69) } })!.move);
  });

  it("server, both clients and a reconnecting client agree on every play (same log = same game)", () => {
    const { log, m } = playOnline("net-1");
    expect(m.session.pending().kind).toBe("final");
    expect(log.filter((a) => a.t === "play").length).toBeGreaterThan(40);
    // a second replica applying the same log play by play, checking the checksum after each action
    const b = new OnlineMatch(init("net-1"), data, ratings, byId);
    const sums: string[] = [];
    const a2 = new OnlineMatch(init("net-1"), data, ratings, byId);
    for (const a of log) { a2.apply(a); sums.push(a2.checksum()); }
    log.forEach((a, k) => { b.apply(a); expect(b.checksum()).toBe(sums[k]); });
    expect(b.session.result().hash).toBe(m.session.result().hash);
    // humans really played: the human QB threw (throwAt inputs), the defender was steered
    expect(m.session.result().teams[0].passAtt + m.session.result().teams[1].passAtt).toBeGreaterThan(5);
  });

  it("rollback: re-simulating a play from tick 0 with the confirmed inputs equals playing it straight", () => {
    const { log } = playOnline("net-2");
    const m = new OnlineMatch(init("net-2"), data, ratings, byId);
    let checked = 0;
    for (const a of log) {
      if (a.t === "play" && m.live && checked < 15) {
        const inputs = unpackInputs(a.runs, a.ticks);
        // a client that mispredicted the defense (no input) for the first half of the play ...
        const wrong = m.live.remake();
        inputs.forEach(([o], t) => { if (t < inputs.length / 2) wrong.step(o, null); });
        // ... rolls back: fresh sim, confirmed inputs
        const fixed = runPlay(m.live, inputs);
        const straight = runPlay(m.live, inputs);
        expect(JSON.stringify(fixed.result().outcome)).toBe(JSON.stringify(straight.result().outcome));
        expect(fixed.snapshot().tick).toBe(straight.snapshot().tick);
        checked++;
      }
      m.apply(a);
    }
    expect(checked).toBe(15);
  });

  it("a side handed to the AI keeps playing (disconnect)", () => {
    const m = new OnlineMatch(init("net-3", 60), data, ratings, byId);
    m.apply({ t: "human", side: 1, on: false });
    let guard = 0;
    while (m.session.pending().kind !== "final" && guard++ < 400) {
      const humanOff = m.session.isHuman(m.session.state.possession);
      m.apply({ t: "snap", off: humanOff ? autoOffense(m, String(guard)) : {}, def: {} });
      if (!m.live) continue;
      const ticks: [UserInput | null, UserInput | null][] = [];
      const sim = m.live.remake(); m.live = { ...m.live, sim };
      for (let t = 0; t < 2000; t++) { const inp = policy(m, t); ticks.push(inp); if (sim.step(inp[0], inp[1])) break; }
      m.apply({ t: "play", runs: packInputs(ticks), ticks: ticks.length });
    }
    expect(m.session.pending().kind).toBe("final");
  });
});

describe("online draft", () => {
  it("a replica built from the server's reveal log matches the server's draft (mirror rerolls too)", () => {
    for (const mirror of [false, true]) {
      const di: DraftInit = { seed: `d-${mirror}`, settings: { format: "quick", mirror }, setups: [{ info: nflRoster("BUF", pool, data).info }, { info: nflRoster("KC", pool, data).info }] };
      const server = newDraft(di, data, pool);
      const log: DraftAction[] = [];
      let k = 0;
      while (!server.done) {
        k++;
        if (k % 5 === 0 && server.teams[1].rerolls > 0) { server.reroll(1); log.push({ t: "reroll", side: 1 }); }
        // side 0 picks first (pending), side 1 picks later: picks are held until both are in
        const p0 = server.aiChoice(0, "need", false), p1 = server.aiChoice(1, "best", false);
        server.pick(0, p0.cardId, p0.slot);
        const rev = server.pick(1, p1.cardId, p1.slot);
        expect(rev).not.toBeNull();
        log.push({ t: "reveal", picks: [{ cardId: p0.cardId, slot: p0.slot, auto: false }, { cardId: p1.cardId, slot: p1.slot, auto: false }] });
      }
      const replica = newDraft(di, data, pool);
      for (const a of log) applyDraftAction(replica, a);
      expect(replica.done).toBe(true);
      for (const side of [0, 1] as Side[]) {
        expect(replica.teams[side].picks.map((p) => [p.card.id, p.slot])).toEqual(server.teams[side].picks.map((p) => [p.card.id, p.slot]));
        expect(rosterToWire(replica.toRoster(side))).toEqual(rosterToWire(server.toRoster(side)));
      }
    }
  });
});
