// The game server: HTTP (health check) + WebSocket on /ws. Rooms by code, a quick-match queue,
// seat tokens for reconnecting, a per-connection flood limit. The game logic lives in room.ts.
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, RoomSettings, ServerMsg, TeamSetupWire } from "@tdf/sim";
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
  const L = env.data.online;

  const http: Server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      res.end(`ok ${rooms.size} rooms`);
      return;
    }
    res.writeHead(404); res.end();
  });
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
      if (m.t === "leave") { drop(c, true); return; }
      if (c.at) c.at.room.handle(c.at.seat, m);
    });
    ws.on("close", () => drop(c, false));
  });

  const drop = (c: Client, leaving: boolean) => {
    const qi = queue.findIndex((q) => q.conn === c);
    if (qi >= 0) queue.splice(qi, 1);
    if (!c.at) return;
    const { room, seat } = c.at;
    if (seat.conn === c) room.detach(seat);
    if (leaving) { seats.delete(seat.token); c.at = null; }
  };

  const ticker = setInterval(() => {
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
