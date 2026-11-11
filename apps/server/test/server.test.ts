import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  OnlineMatch, applyDraftAction, autoOffense, newDraft, wireInput, Fx,
  type ClientMsg, type Draft, type ServerMsg, type Side, type TeamSetupWire, type UserInput,
} from "@tdf/sim";
import { loadEnv } from "../src/env.js";
import { startServer, type GameServer } from "../src/server.js";
import type { ServerEnv } from "../src/room.js";

let env: ServerEnv;
let server: GameServer;
beforeAll(async () => {
  const e = await loadEnv();
  // fast timers for the test
  env = { ...e, data: { ...e.data, online: { ...e.data.online, resultSeconds: 0.01, aiPresnapSeconds: 0.01, aiAfterSeconds: 0.3, fillMs: 40 } } };
  server = await startServer(env, 0);
});
afterAll(async () => { await server.close(); });

const team = (abbr: string): TeamSetupWire => ({ info: { abbr, name: `Team ${abbr}`, nick: abbr, c1: "#123456", c2: "#ffffff", c3: "#000000" }, icon: "star" });

/** A scripted player: replicates the draft and the match from the server's logs and plays. */
class Bot {
  ws!: WebSocket;
  side: Side = 0;
  token = "";
  draft: Draft | null = null;
  match: OnlineMatch | null = null;
  pickedRound = 0;
  lineupSent = false;
  sums: string[] = [];
  mismatches = 0;
  seen: ServerMsg[] = [];
  results: ServerMsg | null = null;
  sentLive = -1;
  constructor(readonly name: string) {}
  connect(token?: string): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    this.ws.on("message", (raw) => this.on(JSON.parse(String(raw)) as ServerMsg));
    return new Promise((res) => this.ws.on("open", () => { this.send({ t: "hello", poolHash: env.poolHash, token }); res(); }));
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  private on(m: ServerMsg) {
    this.seen.push(m);
    switch (m.t) {
      case "welcome": this.token = m.token; break;
      case "room": this.side = m.side; break;
      case "draft": {
        if (m.from === 0) { this.draft = newDraft(m.init, env.data, env.pool); this.pickedRound = 0; }
        for (const a of m.actions) applyDraftAction(this.draft!, a);
        this.maybePick();
        break;
      }
      case "pickRejected": this.pickedRound = 0; this.maybePick(); break;
      case "rosters":
        if (!this.lineupSent && !m.ready[this.side]) { this.lineupSent = true; this.send({ t: "lineup", roster: m.rosters[this.side] }); }
        break;
      case "match": {
        if (m.from === 0) { this.match = new OnlineMatch(m.init, env.data, env.ratings, env.byId); this.sentLive = -1; }
        if (m.from !== this.match!.applied) break; // already have these
        for (const a of m.actions) this.match!.apply(a);
        break;
      }
      case "sum":
        if (this.match && this.match.applied === m.at) { if (this.match.checksum() !== m.sum) this.mismatches++; this.sums.push(m.sum); }
        break;
      case "wait": this.onWait(m.wait); break;
      case "results": this.results = m; break;
      default: break;
    }
  }
  private maybePick() {
    const d = this.draft!;
    if (d.done || this.pickedRound === d.round) return;
    this.pickedRound = d.round;
    const c = d.aiChoice(this.side, "need", false);
    this.send({ t: "pick", cardId: c.cardId, slot: c.slot });
  }
  private onWait(w: import("@tdf/sim").MatchWait) {
    const m = this.match;
    if (!m) return;
    if (w.step === "offense" && w.side === this.side) this.send({ t: "off", part: autoOffense(m, `bot${this.name}${m.applied}`) });
    if (w.step === "defense" && w.side === this.side) this.send({ t: "def", part: {} });
    if (w.step === "presnap" && w.side === this.side) this.send({ t: "go" });
    if (w.step === "live" && w.play !== undefined && this.sentLive !== w.play && m.live) {
      this.sentLive = w.play;
      // play the whole play locally with my inputs (no input for the other side) and send them all
      const live = m.live, sim = live.remake(), mineO = live.offSide === this.side;
      const inputs: (UserInput | null)[] = [];
      for (let t = 0; t < 900; t++) {
        const s = sim.snapshot();
        let u: UserInput | null = null;
        if (mineO) {
          if (live.kick && t === 0) u = { kick: { aim: 0, power: 900, curve: 0 } };
          else if (s.presnap) u = { snap: true };
          else if (s.qbCanThrow && t === 40) {
            const r = s.actors.find((a) => a.side === "O" && (a.role === "X" || a.role === "Z"));
            if (r) u = { throwAt: { x: r.x + r.vx, y: r.y + r.vy, power: 0.7 } };
          } else if (s.userCarrier) u = { move: { x: 0, y: Fx.fx(1) } };
        }
        inputs.push(wireInput(u));
        if (mineO ? sim.step(inputs[t], null) : sim.step(null, inputs[t])) break;
      }
      for (let k = 0; k < inputs.length; k += 100) this.send({ t: "in", play: w.play, from: k, inputs: inputs.slice(k, k + 100) });
    }
  }
}

const until = async (cond: () => boolean, ms = 60_000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

describe("game server", () => {
  it("quick match: draft, lineup and a full game in lockstep, with a reconnect in the middle", async () => {
    const a = new Bot("a"), b = new Bot("b");
    await a.connect(); await b.connect();
    a.send({ t: "quick", team: team("AAA") });
    b.send({ t: "quick", team: team("BBB") });
    await until(() => Boolean(a.draft && b.draft));
    expect(a.side).not.toBe(b.side);
    // offers: each side sees the same draft (replicated from the log)
    await until(() => Boolean(a.match && b.match && a.match.applied > 20));
    expect(a.draft!.done && b.draft!.done).toBe(true);
    expect(a.draft!.teams.map((t) => t.picks.map((p) => p.card.id))).toEqual(b.draft!.teams.map((t) => t.picks.map((p) => p.card.id)));
    // b drops and comes back with its token: it rebuilds everything from the logs
    const token = b.token;
    b.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const b2 = new Bot("b2");
    b2.lineupSent = true;
    await b2.connect(token);
    await until(() => Boolean(b2.match && b2.match.applied >= a.match!.applied - 2));
    // the game goes on to the end
    await until(() => Boolean(a.results && b2.results), 120_000);
    expect(a.match!.session.pending().kind).toBe("final");
    expect(b2.match!.session.result().hash).toBe(a.match!.session.result().hash);
    expect(a.mismatches + b2.mismatches).toBe(0);
    const room = [...server.rooms.values()].find((r) => r.match);
    expect(room!.match!.session.result().hash).toBe(a.match!.session.result().hash);
    // hidden info: the defense never saw the offense's call before the snap (only its personnel)
    const offCalls = a.seen.filter((m) => m.t === "wait" && m.wait.step === "defense" && m.wait.side === a.side);
    expect(offCalls.every((m) => m.t === "wait" && !("call" in m.wait))).toBe(true);
    a.ws.close(); b2.ws.close();
  }, 180_000);

  it("private rooms by code; a wrong code and a version mismatch are refused", async () => {
    const a = new Bot("c"), b = new Bot("d"), c = new Bot("e");
    await a.connect(); await b.connect(); await c.connect();
    a.send({ t: "create", settings: { format: "quick", mirror: true, revealPassed: true, themed: false, timer: true, quarterMinutes: 1, abilities: false, controlDefender: true }, team: team("CCC") });
    await until(() => a.seen.some((m) => m.t === "room"));
    const room = a.seen.find((m) => m.t === "room") as Extract<ServerMsg, { t: "room" }>;
    expect(room.code).toHaveLength(env.data.online.codeLength);
    c.send({ t: "join", code: "ZZZZZ", team: team("EEE") });
    await until(() => c.seen.some((m) => m.t === "error"));
    b.send({ t: "join", code: room.code.toLowerCase(), team: team("DDD") });
    await until(() => Boolean(a.draft && b.draft));
    expect(a.draft!.settings.mirror).toBe(true);
    const x = new WebSocket(`ws://localhost:${server.port}/ws`);
    const got: ServerMsg[] = [];
    x.on("message", (raw) => got.push(JSON.parse(String(raw))));
    await new Promise((r) => x.on("open", r));
    x.send(JSON.stringify({ t: "hello", poolHash: "nope" }));
    await until(() => got.length > 0);
    expect(got[0]!.t).toBe("error");
    for (const s of [a.ws, b.ws, c.ws, x]) s.close();
  }, 60_000);
});
