// The game server: HTTP (health check) + WebSocket on /ws. Rooms by code, a quick-match queue,
// seat tokens for reconnecting, a per-connection flood limit. The game logic lives in room.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { dailyDate, elo, rankedSeason, type ClientMsg, type RoomSettings, type ServerMsg, type TeamSetupWire } from "@tdf/sim";
import { cleanName } from "./store.js";
import { Room, type Seat, type ServerEnv } from "./room.js";

export interface GameServer { port: number; close(): Promise<void>; rooms: Map<string, Room> }

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export function defaultSettings(): RoomSettings {
  return { format: "quick", mirror: false, revealPassed: true, themed: false, timer: true, quarterMinutes: 3, abilities: true, controlDefender: false };
}

export async function startServer(env: ServerEnv, port = 0): Promise<GameServer> {
  const rooms = new Map<string, Room>();
  const seats = new Map<string, { room: Room; seat: Seat }>();
  const queue: { ws: WebSocket; team: TeamSetupWire; conn: Client }[] = [];
  const rankedQueue: { team: TeamSetupWire; conn: Client; account: string; rating: number; since: number }[] = [];
  const L = env.data.online;

  const M = env.data.modes;
  const http: Server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      res.end(`ok ${rooms.size} rooms`);
      return;
    }
    if (req.url?.startsWith("/api/")) { void api(req, res); return; }
    res.writeHead(404); res.end();
  });

  // ---------------------------------------------------------------- HTTP API (accounts, leaderboards)
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((ok) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 16_384) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
  });
  const BOARDS = ["daily", "gauntlet", "ranked"];
  async function api(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://x");
    const st = env.store, now = new Date(env.now());
    if (req.method === "OPTIONS") return json(res, 204, {});
    try {
      if (url.pathname === "/api/account" && req.method === "POST") {
        const b = await readBody(req);
        const name = cleanName(b.name);
        if (!name) return json(res, 400, { error: "pick a name of 2-16 letters" });
        return json(res, 200, st.createAccount(name));
      }
      if (url.pathname === "/api/rename" && req.method === "POST") {
        const b = await readBody(req), a = st.auth(b.id, b.secret), name = cleanName(b.name);
        if (!a || !name) return json(res, 400, { error: "bad account or name" });
        st.rename(a.id, name);
        return json(res, 200, { ok: true, name });
      }
      if (url.pathname === "/api/me") {
        const a = st.auth(url.searchParams.get("id"), url.searchParams.get("secret"));
        if (!a) return json(res, 404, { error: "unknown account" });
        const season = rankedSeason(now);
        return json(res, 200, { name: a.name, season, ranked: st.rating(a.id, season, M.ranked.ratingStart), today: dailyDate(now) });
      }
      if (url.pathname === "/api/board") {
        const kind = url.searchParams.get("kind") ?? "", key = url.searchParams.get("key") ?? "";
        if (!BOARDS.includes(kind)) return json(res, 400, { error: "unknown board" });
        if (kind === "ranked") return json(res, 200, { kind, key, rows: st.rankedBoard(key || rankedSeason(now)) });
        return json(res, 200, { kind, key, rows: st.board(kind, key) });
      }
      if (url.pathname === "/api/submit" && req.method === "POST") {
        const b = await readBody(req), a = st.auth(b.id, b.secret);
        if (!a) return json(res, 403, { error: "unknown account" });
        const kind = String(b.kind), key = String(b.key), score = Number(b.score);
        // plausibility: today's (or yesterday's) Daily Draft; the Gauntlet board is all-time; scores in range
        const okKey = kind === "daily" ? [dailyDate(now), dailyDate(new Date(now.getTime() - 86_400_000))].includes(key) : kind === "gauntlet" && key === "all";
        const max = kind === "daily" ? M.daily.dailyGames * (M.daily.winPoints + 100)
          : (M.gauntlet.weeks * M.gauntlet.winPoints + M.gauntlet.playoffRounds.length * M.gauntlet.playoffPoints + M.gauntlet.pointDiffCap);
        if (!okKey || !Number.isFinite(score) || Math.abs(score) > max) return json(res, 400, { error: "that result can't be right" });
        const best = st.submit(kind, key, a.id, Math.round(score), String(b.summary ?? "").slice(0, 80), JSON.stringify(b.detail ?? {}).slice(0, 2000));
        return json(res, 200, { ok: true, best, rows: st.board(kind, key) });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) { return json(res, 500, { error: String(e) }); }
  }
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 256 * 1024 });

  const newCode = () => {
    for (;;) {
      const b = randomBytes(L.codeLength);
      const code = [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
      if (!rooms.has(code)) return code;
    }
  };
  const makeRoom = (settings: RoomSettings, quick: boolean) => {
    const r = new Room(newCode(), settings, env, quick);
    rooms.set(r.code, r);
    return r;
  };
  const sit = (c: Client, room: Room, team: TeamSetupWire) => {
    const token = randomUUID();
    const seat = room.addSeat(token, team);
    if (!seat) { c.send({ t: "error", msg: "that room is full" }); return; }
    seats.set(token, { room, seat });
    c.at = { room, seat };
    c.send({ t: "welcome", token });
    room.attach(seat, c);
  };

  class Client {
    at: { room: Room; seat: Seat } | null = null;
    helloOk = false;
    private count = 0;
    private windowStart = Date.now();
    constructor(readonly ws: WebSocket) {}
    send(m: ServerMsg) { if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m)); }
    flood(): boolean {
      const now = Date.now();
      if (now - this.windowStart > 1000) { this.windowStart = now; this.count = 0; }
      return ++this.count > L.maxMsgsPerSecond;
    }
  }

  wss.on("connection", (ws) => {
    const c = new Client(ws);
    ws.on("message", (raw) => {
      if (c.flood()) { c.send({ t: "error", msg: "too many messages" }); ws.close(); return; }
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)) as ClientMsg; } catch { return; }
      if (!m || typeof m !== "object" || typeof (m as { t?: unknown }).t !== "string") return;
      if (m.t === "ping") { c.send({ t: "pong", at: m.at }); return; }
      if (m.t === "hello") {
        if (m.poolHash !== env.poolHash) { c.send({ t: "error", msg: "version mismatch: reload the page" }); return; }
        c.helloOk = true;
        const s = m.token ? seats.get(m.token) : undefined;
        if (s && !s.room.closed) {
          if (s.seat.conn && s.seat.conn !== c) (s.seat.conn as Client).ws.close();
          c.at = s;
          c.send({ t: "welcome", token: m.token! });
          s.room.attach(s.seat, c);
        }
        return;
      }
      if (!c.helloOk) return;
      if (m.t === "create") { if (!c.at) sit(c, makeRoom({ ...defaultSettings(), ...sanitize(m.settings) }, false), m.team); return; }
      if (m.t === "join") {
        if (c.at) return;
        const room = rooms.get(String(m.code).toUpperCase());
        if (!room || room.closed || room.phase !== "lobby") { c.send({ t: "error", msg: "no open room with that code" }); return; }
        sit(c, room, m.team);
        return;
      }
      if (m.t === "quick") {
        if (c.at || queue.some((q) => q.conn === c)) return;
        const mate = queue.findIndex((q) => q.ws.readyState === q.ws.OPEN);
        if (mate < 0) { queue.push({ ws, team: m.team, conn: c }); c.send({ t: "error", msg: "searching for an opponent..." }); return; }
        const q = queue.splice(mate, 1)[0]!;
        const room = makeRoom(defaultSettings(), true);
        sit(q.conn, room, q.team);
        sit(c, room, m.team);
        return;
      }
      if (m.t === "ranked") {
        if (c.at || rankedQueue.some((q) => q.conn === c)) return;
        const a = env.store.auth(m.account?.id, m.account?.secret);
        if (!a) { c.send({ t: "error", msg: "ranked needs an account: set your name first" }); return; }
        if (rankedQueue.some((q) => q.account === a.id)) { c.send({ t: "error", msg: "you are already in the ranked queue" }); return; }
        const r = env.store.rating(a.id, rankedSeason(new Date(env.now())), M.ranked.ratingStart);
        rankedQueue.push({ team: m.team, conn: c, account: a.id, rating: r.rating, since: env.now() });
        c.send({ t: "error", msg: `searching for a ranked opponent near ${r.rating}...` });
        matchRanked();
        return;
      }
      if (m.t === "leave") { drop(c, true); return; }
      if (c.at) c.at.room.handle(c.at.seat, m);
    });
    ws.on("close", () => drop(c, false));
  });

  /** Pair ranked players whose ratings are close; the window widens the longer they wait. */
  function matchRanked() {
    const now = env.now();
    for (let i = 0; i < rankedQueue.length; i++) {
      for (let j = i + 1; j < rankedQueue.length; j++) {
        const a = rankedQueue[i]!, b = rankedQueue[j]!;
        if (a.conn.ws.readyState !== a.conn.ws.OPEN || b.conn.ws.readyState !== b.conn.ws.OPEN) continue;
        const wait = Math.min(now - a.since, now - b.since) / 1000;
        if (Math.abs(a.rating - b.rating) > M.ranked.ratingWindow + M.ranked.windowGrowthPerSec * wait) continue;
        rankedQueue.splice(j, 1); rankedQueue.splice(i, 1);
        const room = makeRoom({ ...defaultSettings(), quarterMinutes: M.ranked.quarterMinutes, timer: true, abilities: true }, true);
        room.ranked = [a.account, b.account];
        room.onResult = rankedResult;
        sit(a.conn, room, a.team);
        sit(b.conn, room, b.team);
        return matchRanked();
      }
    }
  }
  /** Elo after a ranked game (a forfeit is a loss whatever the score). */
  function rankedResult(room: Room, score: [number, number], forfeit: 0 | 1 | null) {
    const [ida, idb] = room.ranked!;
    const season = rankedSeason(new Date(env.now()));
    const ra = env.store.rating(ida, season, M.ranked.ratingStart), rb = env.store.rating(idb, season, M.ranked.ratingStart);
    const sA = forfeit === 0 ? 0 : forfeit === 1 ? 1 : score[0] > score[1] ? 1 : score[0] < score[1] ? 0 : 0.5;
    const [na, nb] = elo(ra.rating, rb.rating, sA, M.ranked.eloK);
    env.store.recordRanked(season, ra, rb, score[0], score[1], forfeit, na, nb);
    room.tell(0, { t: "rating", season, before: ra.rating, after: na, opponent: rb.name });
    room.tell(1, { t: "rating", season, before: rb.rating, after: nb, opponent: ra.name });
  }

  const drop = (c: Client, leaving: boolean) => {
    const qi = queue.findIndex((q) => q.conn === c);
    if (qi >= 0) queue.splice(qi, 1);
    const ri = rankedQueue.findIndex((q) => q.conn === c);
    if (ri >= 0) rankedQueue.splice(ri, 1);
    if (!c.at) return;
    const { room, seat } = c.at;
    if (seat.conn === c) room.detach(seat);
    if (leaving) { seats.delete(seat.token); c.at = null; }
  };

  const ticker = setInterval(() => {
    matchRanked();
    for (const [code, r] of rooms) {
      r.tick();
      if (r.closed) {
        rooms.delete(code);
        for (const [tok, s] of seats) if (s.room === r) seats.delete(tok);
      }
    }
  }, 1000);

  await new Promise<void>((res) => http.listen(port, res));
  const addr = http.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : port,
    rooms,
    close: () => new Promise<void>((res) => {
      clearInterval(ticker);
      for (const r of rooms.values()) r.close();
      for (const ws of wss.clients) ws.terminate();
      env.store.close();
      wss.close(() => http.close(() => res()));
    }),
  };
}

/** Keep only sane room settings from a client. */
function sanitize(s: Partial<RoomSettings> | undefined): Partial<RoomSettings> {
  if (!s) return {};
  const out: Partial<RoomSettings> = {};
  if (s.format === "quick" || s.format === "full") out.format = s.format;
  for (const k of ["mirror", "revealPassed", "themed", "timer", "abilities", "controlDefender"] as const) if (typeof s[k] === "boolean") out[k] = s[k];
  if (typeof s.quarterMinutes === "number" && [1, 2, 3, 5, 8, 15].includes(s.quarterMinutes)) out.quarterMinutes = s.quarterMinutes;
  return out;
}
