// Single-player modes and ratings (M10): League Boss rosters, the 17-game Boss Gauntlet with
// playoffs, the Daily Draft challenge and Elo for ranked online play. All deterministic from seeds,
// so the same run or the same day produces the same opponents everywhere.
import type { GameData, PlayerCard } from "@tdf/shared";
import { Rng } from "./rng.js";
import { ALL_SLOTS, PACKAGE_SLOTS, rosterFromLineup, slotPos, type Roster } from "./roster.js";

export type Boss = GameData["bosses"]["bosses"][number];

const GROUP_OF: Record<string, string> = {
  QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", LT: "OL", LG: "OL", C: "OL", RG: "OL", RT: "OL",
  DE: "DL", DT: "DL", NT: "DL", OLB: "LB", MLB: "LB", ILB: "LB", CB: "DB", FS: "DB", SS: "DB", K: "ST", P: "ST", LS: "ST",
};
/** Bench spots a boss carries (the sub packages + a backup QB and lineman). */
const BENCH_POS = [...PACKAGE_SLOTS.map((s) => slotPos(s)), "QB", "LG", "DE", "OLB", "WR"];

/** A League Boss's roster at a strength (the starters' target overall), built from real players. */
export function bossRoster(boss: Boss, strength: number, data: GameData, pool: readonly PlayerCard[], seed: string): Roster {
  const G = data.modes.gauntlet;
  const rng = new Rng(`${seed}:${boss.id}:${strength}`);
  const used = new Set<number>();
  const byPos = new Map<string, PlayerCard[]>();
  for (const c of pool) if (c.ovr > 0) { const p = c.natural[0]!; (byPos.get(p) ?? byPos.set(p, []).get(p)!).push(c); }
  const pick = (pos: string, target: number): PlayerCard | null => {
    const cands = (byPos.get(pos) ?? []).filter((c) => !used.has(c.id))
      .sort((a, b) => Math.abs(a.ovr - target) - Math.abs(b.ovr - target) || a.id - b.id).slice(0, G.pickTop);
    if (!cands.length) return null;
    const c = cands[rng.int(cands.length)]!;
    used.add(c.id);
    return c;
  };
  const starters: Record<string, PlayerCard> = {};
  for (const slot of ALL_SLOTS) {
    const pos = slotPos(slot);
    const t = strength + (boss.focus.includes(GROUP_OF[pos] as never) ? G.focusBoost : 0);
    const c = pick(pos, t);
    if (c) starters[slot] = c;
  }
  const bench: PlayerCard[] = [];
  for (const pos of BENCH_POS) { const c = pick(pos, strength - G.benchDrop); if (c) bench.push(c); }
  const r = rosterFromLineup({ abbr: boss.abbr, name: boss.name, nick: boss.nick, c1: boss.c1, c2: boss.c2, c3: boss.c3 }, starters, bench, data);
  return { ...r, style: boss.style, defStyle: boss.defStyle, baseFront: boss.baseFront };
}

// ---------------------------------------------------------------- the Boss Gauntlet
export interface GauntletGame {
  /** 1..weeks for the season, then the playoff rounds */
  week: number;
  round: string | null;
  boss: string;
  strength: number;
  result?: { us: number; them: number; simmed: boolean };
}
export interface GauntletRun {
  kind: "gauntlet" | "daily";
  seed: string;
  /** the season (and later the playoffs, once qualified) */
  games: GauntletGame[];
  /** done: the season is over (no playoffs) or the playoffs are decided */
  done: boolean;
}
function shuffled<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}
/** The 17-week schedule: every boss but the final one, shuffled (never twice in a row), rising strength. */
export function newGauntlet(seed: string, data: GameData): GauntletRun {
  const G = data.modes.gauntlet, rng = new Rng(`gauntlet:${seed}`);
  const pool = data.bosses.bosses.filter((b) => !b.final).map((b) => b.id);
  const order: string[] = [];
  while (order.length < G.weeks) {
    for (const id of shuffled(pool, rng)) { if (order.length < G.weeks && order[order.length - 1] !== id) order.push(id); }
  }
  const games = order.map((boss, k) => ({
    week: k + 1, round: null, boss,
    strength: Math.round(G.strengthStart + ((G.strengthEnd - G.strengthStart) * k) / Math.max(1, G.weeks - 1)),
  }));
  return { kind: "gauntlet", seed, games, done: false };
}
/** The Daily Draft's gauntlet: the same opponents for everyone today. */
export function newDaily(date: string, data: GameData): GauntletRun {
  const D = data.modes.daily, rng = new Rng(`daily:${date}`);
  const ids = shuffled(data.bosses.bosses.filter((b) => !b.final).map((b) => b.id), rng).slice(0, D.dailyGames);
  const games = ids.map((boss, k) => ({
    week: k + 1, round: null, boss,
    strength: Math.round(D.dailyStrengthStart + ((D.dailyStrengthEnd - D.dailyStrengthStart) * k) / Math.max(1, D.dailyGames - 1)),
  }));
  return { kind: "daily", seed: `daily:${date}`, games, done: false };
}
/** Today's Daily Draft seed (UTC date). */
export const dailyDate = (now: Date) => now.toISOString().slice(0, 10);

export function record(run: GauntletRun) {
  let w = 0, l = 0, t = 0, pw = 0, pf = 0, pa = 0;
  for (const g of run.games) {
    if (!g.result) continue;
    pf += g.result.us; pa += g.result.them;
    const win = g.result.us > g.result.them, loss = g.result.us < g.result.them;
    if (g.round) { if (win) pw++; continue; }
    if (win) w++; else if (loss) l++; else t++;
  }
  return { wins: w, losses: l, ties: t, playoffWins: pw, pointsFor: pf, pointsAgainst: pa };
}
/** The next game to play, or null when the run is over. */
export const nextGame = (run: GauntletRun) => run.done ? null : run.games.find((g) => !g.result) ?? null;

/** Record a result; adds the playoff bracket after the season (if qualified) and ends the run. */
export function recordResult(run: GauntletRun, week: number, us: number, them: number, simmed: boolean, data: GameData): GauntletRun {
  const G = data.modes.gauntlet;
  const games = run.games.map((g) => (g.week === week ? { ...g, result: { us, them, simmed } } : g));
  let next: GauntletRun = { ...run, games };
  const g = games.find((x) => x.week === week)!;
  if (run.kind === "daily") return { ...next, done: games.every((x) => x.result) };
  if (g.round) {
    // single elimination: a loss (or a tie) ends it; winning the last round is the title
    const lost = us <= them, last = g.round === G.playoffRounds[G.playoffRounds.length - 1];
    return { ...next, done: lost || last };
  }
  if (week === G.weeks) {
    const r = record(next);
    if (r.wins < G.playoffWins) return { ...next, done: true };
    // the bracket: the strongest bosses, the final boss waiting in the championship
    const rng = new Rng(`playoffs:${run.seed}`);
    const regular = shuffled(data.bosses.bosses.filter((b) => !b.final).map((b) => b.id), rng);
    const final = data.bosses.bosses.find((b) => b.final)?.id ?? regular[0]!;
    const rounds = G.playoffRounds.map((round, k) => ({
      week: G.weeks + k + 1, round, boss: k === G.playoffRounds.length - 1 ? final : regular[k]!,
      strength: Math.round(G.strengthEnd + ((G.playoffStrength - G.strengthEnd) * (k + 1)) / G.playoffRounds.length),
    }));
    next = { ...next, games: [...games, ...rounds] };
  }
  return next;
}
/** Leaderboard score for a finished (or abandoned) run. */
export function runScore(run: GauntletRun, data: GameData): number {
  const r = record(run);
  const diff = r.pointsFor - r.pointsAgainst;
  if (run.kind === "daily") return r.wins * data.modes.daily.winPoints + diff;
  const G = data.modes.gauntlet;
  return r.wins * G.winPoints + r.playoffWins * G.playoffPoints + Math.max(-G.pointDiffCap, Math.min(G.pointDiffCap, diff));
}
/** "17-0", "12-5 · lost in the Conference round", "16-1 · CHAMPIONS" */
export function runSummary(run: GauntletRun, data: GameData): string {
  const r = record(run);
  const base = `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
  if (run.kind === "daily") return base;
  const po = run.games.filter((g) => g.round);
  if (!po.length) return run.done ? `${base} · missed the playoffs` : base;
  const champ = po.every((g) => g.result && g.result.us > g.result.them) && po.length === data.modes.gauntlet.playoffRounds.length;
  if (champ) return `${base} · CHAMPIONS${r.losses === 0 && r.ties === 0 ? " · PERFECT SEASON" : ""}`;
  const lostIn = po.find((g) => g.result && g.result.us <= g.result.them);
  return lostIn ? `${base} · lost in the ${lostIn.round} round` : `${base} · in the playoffs`;
}

// ---------------------------------------------------------------- ranked
/** Elo: the new ratings after A scored `score` (1 win, 0.5 tie, 0 loss) against B. */
export function elo(ra: number, rb: number, score: number, k: number): [number, number] {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const d = Math.round(k * (score - ea));
  return [ra + d, rb - d];
}
/** Ranked seasons are calendar months. */
export const rankedSeason = (now: Date) => now.toISOString().slice(0, 7);
