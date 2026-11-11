// Persistence (M10): guest accounts, ranked ratings per season, ranked match history and the
// Daily Draft / Boss Gauntlet leaderboards, in SQLite (Node's built-in node:sqlite). On Render the
// file lives on the persistent disk (DATA_DIR); tests use an in-memory database.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DB } from "node:sqlite";
// loaded at run time: bundlers (vitest) don't know the node:sqlite built-in yet
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DB };

export interface Account { id: string; name: string }
export interface RatingRow { account: string; name: string; season: string; rating: number; games: number; wins: number; losses: number; ties: number }
export interface BoardRow { account: string; name: string; score: number; summary: string; detail: string; at: number }

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Display names: 2-16 letters, digits, spaces, _ or -. */
export function cleanName(n: unknown): string | null {
  if (typeof n !== "string") return null;
  const s = n.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return s.length >= 2 ? s : null;
}

export class Store {
  private db: DB;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, secret TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ratings (account TEXT NOT NULL, season TEXT NOT NULL, rating INTEGER NOT NULL, games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, ties INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, season));
      CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
        score_a INTEGER NOT NULL, score_b INTEGER NOT NULL, forfeit INTEGER, delta INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS boards (kind TEXT NOT NULL, key TEXT NOT NULL, account TEXT NOT NULL, score INTEGER NOT NULL, summary TEXT NOT NULL,
        detail TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, key, account));
    `);
  }
  close() { this.db.close(); }

  // ---------------------------------------------------------------- accounts
  createAccount(name: string): { id: string; secret: string; name: string } {
    const id = randomUUID(), secret = randomBytes(24).toString("hex");
    this.db.prepare("INSERT INTO accounts (id, secret, name, created) VALUES (?, ?, ?, ?)").run(id, hash(secret), name, Date.now());
    return { id, secret, name };
  }
  /** The account if the secret matches. */
  auth(id: unknown, secret: unknown): Account | null {
    if (typeof id !== "string" || typeof secret !== "string") return null;
    const r = this.db.prepare("SELECT id, name, secret FROM accounts WHERE id = ?").get(id) as { id: string; name: string; secret: string } | undefined;
    return r && r.secret === hash(secret) ? { id: r.id, name: r.name } : null;
  }
  rename(id: string, name: string) { this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id); }

  // ---------------------------------------------------------------- ranked
  rating(account: string, season: string, start: number): RatingRow {
    const r = this.db.prepare(`SELECT r.account, a.name, r.season, r.rating, r.games, r.wins, r.losses, r.ties FROM ratings r JOIN accounts a ON a.id = r.account
      WHERE r.account = ? AND r.season = ?`).get(account, season) as RatingRow | undefined;
    if (r) return r;
    const name = (this.db.prepare("SELECT name FROM accounts WHERE id = ?").get(account) as { name: string } | undefined)?.name ?? "?";
    return { account, name, season, rating: start, games: 0, wins: 0, losses: 0, ties: 0 };
  }
  /** Store a ranked result: both new ratings and the match. */
  recordRanked(season: string, a: RatingRow, b: RatingRow, scoreA: number, scoreB: number, forfeit: 0 | 1 | null, newA: number, newB: number) {
    const up = this.db.prepare(`INSERT INTO ratings (account, season, rating, games, wins, losses, ties) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (account, season) DO UPDATE SET rating = excluded.rating, games = games + 1, wins = wins + excluded.wins,
      losses = losses + excluded.losses, ties = ties + excluded.ties`);
    // A's result: 1 win, 0.5 tie, 0 loss (a forfeit decides it whatever the score)
    const ra = forfeit === 0 ? 0 : forfeit === 1 ? 1 : scoreA > scoreB ? 1 : scoreA < scoreB ? 0 : 0.5;
    const wlt = (r: number) => [r === 1 ? 1 : 0, r === 0 ? 1 : 0, r === 0.5 ? 1 : 0] as const;
    up.run(a.account, season, newA, ...wlt(ra));
    up.run(b.account, season, newB, ...wlt(1 - ra));
    this.db.prepare("INSERT INTO matches (season, a, b, score_a, score_b, forfeit, delta, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(season, a.account, b.account, scoreA, scoreB, forfeit, newA - a.rating, Date.now());
  }
  rankedBoard(season: string, limit = 50): RatingRow[] {
    return this.db.prepare(`SELECT r.account, a.name, r.season, r.rating, r.games, r.wins, r.losses, r.ties FROM ratings r JOIN accounts a ON a.id = r.account
      WHERE r.season = ? ORDER BY r.rating DESC, r.games DESC LIMIT ?`).all(season, limit) as unknown as RatingRow[];
  }

  // ---------------------------------------------------------------- daily / gauntlet boards
  /** Keep each account's best score per board. Returns true if this is a new best. */
  submit(kind: string, key: string, account: string, score: number, summary: string, detail: string): boolean {
    const cur = this.db.prepare("SELECT score FROM boards WHERE kind = ? AND key = ? AND account = ?").get(kind, key, account) as { score: number } | undefined;
    if (cur && cur.score >= score) return false;
    this.db.prepare(`INSERT INTO boards (kind, key, account, score, summary, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, key, account) DO UPDATE SET score = excluded.score, summary = excluded.summary, detail = excluded.detail, at = excluded.at`)
      .run(kind, key, account, score, summary, detail, Date.now());
    return true;
  }
  board(kind: string, key: string, limit = 50): BoardRow[] {
    return this.db.prepare(`SELECT b.account, a.name, b.score, b.summary, b.detail, b.at FROM boards b JOIN accounts a ON a.id = b.account
      WHERE b.kind = ? AND b.key = ? ORDER BY b.score DESC, b.at ASC LIMIT ?`).all(kind, key, limit) as unknown as BoardRow[];
  }
}
