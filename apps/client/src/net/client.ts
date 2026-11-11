// The browser side of online play: one WebSocket to the game server, reconnecting with the seat
// token, and local replicas of the draft and the match rebuilt from the server's action logs.
import {
  OnlineMatch, applyDraftAction, newDraft,
  type ClientMsg, type Draft, type DraftInit, type MatchAction, type MatchInit, type MatchWait, type PlaySummary,
  type RoomSettings, type ServerMsg, type Side, type TeamSetupWire, type UserInput, type WireRoster,
} from "@tdf/sim";
import type { ClientData } from "../data.js";

type RoomMsg = Extract<ServerMsg, { t: "room" }>;
const TOKEN_KEY = "tdf.online.token";
/** A seat in an online room is remembered for this tab (a reload reconnects to it). */
export function hasOnlineSeat(): boolean { try { return Boolean(sessionStorage.getItem(TOKEN_KEY)); } catch { return false; } }

/** What the match screen listens to (the NetController). */
export interface MatchListener {
  onAction(a: MatchAction, summary: PlaySummary | null): void;
  onWait(w: MatchWait): void;
  onTicks(play: number, from: number, inputs: [UserInput | null, UserInput | null][]): void;
}

export function serverUrl(): string {
  const q = new URLSearchParams(location.search).get("server");
  if (q) return q;
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_SERVER_URL) return env.VITE_SERVER_URL;
  // Render: the static site is built with the game server's host name (render.yaml fromService)
  if (env.VITE_SERVER_HOST) return `wss://${env.VITE_SERVER_HOST}/ws`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567/ws`;
}

export class NetClient {
  readonly cd: ClientData;
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  status: "connecting" | "open" | "offline" = "connecting";
  token: string | null;
  error: string | null = null;
  info: string | null = null;
  room: RoomMsg | null = null;
  // draft
  draftInit: DraftInit | null = null;
  draft: Draft | null = null;
  draftApplied = 0;
  /** the round each side has locked in (opponent: from the server's "picked") */
  lockedRound: [number, number] = [0, 0];
  pickDeadline = 0;
  /** reveals not yet shown */
  newReveals = 0;
  // lineup
  rosters: [WireRoster, WireRoster] | null = null;
  ready: [boolean, boolean] = [false, false];
  lineupDeadline = 0;
  // match
  matchInit: MatchInit | null = null;
  match: OnlineMatch | null = null;
  /** bumps when a new match replica is built (start, reconnect, resync) */
  matchVersion = 0;
  wait: MatchWait | null = null;
  waitDeadline = 0;
  results: Extract<ServerMsg, { t: "results" }> | null = null;
  listener: MatchListener | null = null;
  /** confirmed inputs of the current live play (kept for a controller that starts mid-play) */
  ticks: { play: number; inputs: [UserInput | null, UserInput | null][] } = { play: -1, inputs: [] };
  private listeners = new Set<() => void>();
  rtt = 0;

  constructor(cd: ClientData) {
    this.cd = cd;
    this.token = (() => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } })();
    this.open();
    setInterval(() => { if (this.status === "open") this.send({ t: "ping", at: performance.now() }); }, 3000);
  }
  get side(): Side { return this.room?.side ?? 0; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const f of this.listeners) f(); }

  private open() {
    this.status = "connecting";
    const ws = new WebSocket(serverUrl());
    this.ws = ws;
    ws.onopen = () => { this.status = "open"; this.retry = 0; this.send({ t: "hello", poolHash: this.cd.poolHash, token: this.token ?? undefined }); this.emit(); };
    ws.onmessage = (ev) => { try { this.on(JSON.parse(String(ev.data)) as ServerMsg); } catch (e) { console.error(e); } };
    ws.onclose = () => {
      this.ws = null;
      this.status = "offline";
      this.emit();
      if (this.closedByUser) return;
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), wait);
    };
  }
  send(m: ClientMsg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  /** Leave the room for good (forget the seat). */
  leave() {
    this.send({ t: "leave" });
    this.token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
    this.room = null; this.draft = null; this.match = null; this.results = null; this.wait = null; this.rosters = null;
    this.emit();
  }
  close() { this.closedByUser = true; this.ws?.close(); }

  quick(team: TeamSetupWire) { this.error = null; this.send({ t: "quick", team }); }
  create(settings: RoomSettings, team: TeamSetupWire) { this.error = null; this.send({ t: "create", settings, team }); }
  join(code: string, team: TeamSetupWire) { this.error = null; this.send({ t: "join", code: code.trim().toUpperCase(), team }); }

  private on(m: ServerMsg) {
    switch (m.t) {
      case "welcome":
        this.token = m.token;
        try { sessionStorage.setItem(TOKEN_KEY, m.token); } catch { /* private mode */ }
        this.info = null;
        break;
      case "error":
        if (m.msg.startsWith("searching")) this.info = m.msg; else this.error = m.msg;
        break;
      case "room": this.room = m; this.info = null; break;
      case "draft": {
        if (m.reset) { this.draftInit = m.init; this.draft = newDraft(m.init, this.cd.data, this.cd.pool); this.draftApplied = 0; this.lockedRound = [0, 0]; this.newReveals = 0; this.results = null; this.match = null; this.rosters = null; }
        if (!this.draft || m.from !== this.draftApplied) { if (this.draft && m.from > this.draftApplied) this.send({ t: "resync" }); break; }
        for (const a of m.actions) {
          applyDraftAction(this.draft, a);
          this.draftApplied++;
          if (a.t === "reveal") this.newReveals++;
        }
        break;
      }
      case "pickTimer": this.pickDeadline = Date.now() + m.ms; break;
      case "picked": if (this.draft) this.lockedRound[m.side] = this.draft.round; break;
      case "pickRejected": this.lockedRound[this.side] = 0; this.error = `pick not taken: ${m.msg}`; break;
      case "rosters": this.rosters = m.rosters; this.ready = m.ready; this.lineupDeadline = Date.now() + m.ms; break;
      case "match": {
        if (m.reset) {
          this.matchInit = m.init;
          this.match = new OnlineMatch(m.init, this.cd.data, this.cd.ratings, this.cd.byId);
          this.matchVersion++;
          this.results = null;
          // a replayed log (reconnect): apply quietly, the new screen starts from the current state
          for (const a of m.actions) this.match.apply(a);
          break;
        }
        if (!this.match || m.from !== this.match.applied) { if (this.match && m.from > this.match.applied) this.send({ t: "resync" }); break; }
        for (const a of m.actions) {
          const r = this.match.apply(a);
          this.listener?.onAction(a, r);
        }
        break;
      }
      case "sum":
        if (this.match && this.match.applied === m.at && this.match.checksum() !== m.sum) {
          console.warn("desync: rebuilding the match from the server log");
          this.send({ t: "resync" });
        }
        break;
      case "wait":
        this.wait = m.wait;
        this.waitDeadline = m.wait.ms != null ? Date.now() + m.wait.ms : 0;
        this.listener?.onWait(m.wait);
        break;
      case "ticks":
        if (m.play !== this.ticks.play) this.ticks = { play: m.play, inputs: [] };
        m.inputs.forEach((x, k) => { this.ticks.inputs[m.from + k] = x; });
        this.listener?.onTicks(m.play, m.from, m.inputs);
        break;
      case "results": this.results = m; break;
      case "pong": this.rtt = Math.round(performance.now() - m.at); break;
    }
    this.emit();
  }
}
