// HTTP side of the game server (M10): guest accounts, leaderboards, score submission.
import { serverUrl } from "./client.js";

const ACCOUNT_KEY = "tdf.account";
export interface LocalAccount { id: string; secret: string; name: string }

/** http(s)://host:port of the game server (from its WebSocket URL). */
export function apiBase(): string {
  const u = new URL(serverUrl());
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}
export function account(): LocalAccount | null {
  try { const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null"); return a?.id ? a : null; } catch { return null; }
}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(apiBase() + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json() as T & { error?: string };
  if (!r.ok || j.error) throw new Error(j.error ?? `server said ${r.status}`);
  return j;
}
/** The guest account, created (or renamed) on the server with this name. */
export async function ensureAccount(name: string): Promise<LocalAccount> {
  const a = account();
  if (a) {
    if (a.name !== name) { const r = await call<{ name: string }>("/api/rename", { id: a.id, secret: a.secret, name }); a.name = r.name; save(a); }
    return a;
  }
  const n = await call<LocalAccount>("/api/account", { name });
  save(n);
  return n;
}
function save(a: LocalAccount) { try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a)); } catch { /* private mode */ } }

export interface BoardRow { account: string; name: string; score: number; summary: string; at: number }
export interface RankRow { account: string; name: string; rating: number; games: number; wins: number; losses: number; ties: number }
export const fetchBoard = (kind: "daily" | "gauntlet", key: string) => call<{ rows: BoardRow[] }>(`/api/board?kind=${kind}&key=${encodeURIComponent(key)}`);
export const fetchRanked = (season: string) => call<{ rows: RankRow[] }>(`/api/board?kind=ranked&key=${encodeURIComponent(season)}`);
export async function submitScore(kind: "daily" | "gauntlet", key: string, score: number, summary: string, detail: unknown) {
  const a = account();
  if (!a) throw new Error("set a name first");
  return call<{ ok: boolean; best: boolean; rows: BoardRow[] }>("/api/submit", { id: a.id, secret: a.secret, kind, key, score, summary, detail });
}
export async function fetchMe() {
  const a = account();
  if (!a) return null;
  return call<{ name: string; season: string; today: string; ranked: RankRow }>(`/api/me?id=${a.id}&secret=${a.secret}`);
}
