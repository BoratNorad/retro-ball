// Franchise mode (M11), Retro Bowl style: a 32-team league of the real NFL clubs, your team (drafted
// or taken over) in one of their places; 17-game seasons, playoffs, contracts and the cap, coaching
// credits, staff, facilities, morale and fans, personalities and choice events, injuries, the
// off-season (awards, aging, progression, retirement, a Triple Draft rookie draft, free agency,
// trades), news, owner job security, stats, records and the Hall of Fame.
//
// A Franchise is plain JSON (save slots); everything is a function of it plus GameData, with every
// random choice from a seeded Rng. Player ratings stay Madden's: progression shifts a player's
// ratings by `delta` and rebuilds his card with the same formulas as the pool; rookies are built
// from real young players' ratings with noise and invented names.
import type { GameData, Player, PlayerCard } from "@tdf/shared";
import { buildCard, Norms, slotOverall } from "./cards.js";
import { teamGrade } from "./grade.js";
import { playGame, type GameResult } from "./game.js";
import { hashString, Rng } from "./rng.js";
import { buildRoster, rosterFromLineup, slotPos, ALL_SLOTS, type OffenseStyle, type Roster, type TeamInfo } from "./roster.js";
import type { Stats } from "./engine/play.js";

export type PlayerPersonality = "Loyal" | "Diva" | "Leader" | "Hothead" | "Steady";
export type StaffKind = "oc" | "dc" | "st" | "trainer";
export type FacilityKind = "stadium" | "training" | "rehab";
type StatLine = Record<string, number>;

export interface FPlayer {
  id: number;
  /** the real player whose ratings (and, for real players, name/bio) this one starts from */
  src: number;
  /** invented rookies */
  name?: string; noise?: number; num?: number;
  delta: number;
  age: number;
  personality: PlayerPersonality;
  salary: number; years: number;
  team: string | null;
  injury: number;
  /** this season / career stat totals (box-score keys) and games */
  season: StatLine; career: StatLine; seasons: number;
  rookieYear?: number;
  retired?: boolean;
}
export interface FTeam extends TeamInfo {
  conf: string; div: string;
  w: number; l: number; t: number; pf: number; pa: number; streak: number;
  morale: number; fans: number; deadCap: number;
  /** the human's depth chart (slot -> player id) and plans; AI teams auto-arrange */
  lineup?: Record<string, number>; kr?: number; pr?: number; style?: OffenseStyle; baseFront?: string;
}
export interface FGame { id: number; week: number; round?: string; home: string; away: string; score?: [number, number]; simmed?: boolean }
export interface FEvent { id: number; kind: "deal" | "hothead" | "leader" | "loyal"; player: number; text: string; choices: { id: string; label: string }[] }
export interface FRecord { value: number; who: string; team: string; year: number }
export interface FDraft { order: string[]; pick: number; pool: number[]; offers: number[]; log: { team: string; player: number; round: number }[] }
export interface FBid { player: number; salary: number; years: number }
export type FPhase = "regular" | "playoffs" | "resign" | "draft" | "freeAgency" | "preseason";
export interface Franchise {
  v: 1;
  name: string; seed: string; year: number; phase: FPhase; week: number;
  user: string;
  teams: FTeam[];
  players: Record<string, FPlayer>;
  games: FGame[];
  credits: number;
  staff: Record<StaffKind, number>;
  facilities: Record<FacilityKind, number>;
  security: number; expectedWins: number; fired: boolean;
  news: { year: number; week: number; text: string; user?: boolean }[];
  events: FEvent[];
  records: { game: Record<string, FRecord>; season: Record<string, FRecord> };
  awards: { year: number; award: string; who: string; team: string }[];
  hof: { name: string; pos: string; years: string; score: number }[];
  champions: { year: number; team: string }[];
  cap: number;
  nextId: number;
  developed: Record<string, number>;
  draft: FDraft | null;
  bids: FBid[];
  quarterMinutes: number;
  injuries: boolean;
}

const C = (d: GameData) => d.franchise;
const RECORD_KEYS = ["passYds", "passTd", "rushYds", "rushTd", "recYds", "recTd", "sacks", "defInts", "tackles"];
const PERSONALITIES: PlayerPersonality[] = ["Steady", "Steady", "Steady", "Loyal", "Diva", "Leader", "Hothead"];

// ---------------------------------------------------------------- players and cards
/** Card-building context: the real players by id and the rating norms the pool was built with. */
export class FranchiseData {
  readonly real = new Map<number, Player>();
  readonly norms: Norms;
  constructor(readonly data: GameData) {
    for (const p of data.players.players) this.real.set(p.id, p);
    this.norms = new Norms(data.players.players);
  }
  /** The player's current ratings (source ratings + rookie noise + progression), 0..99. */
  stats(fp: FPlayer): Stats {
    const src = this.real.get(fp.src)!;
    const out: Stats = {};
    const rng = fp.noise != null ? new Rng(`noise:${fp.noise}`) : null;
    const noise = C(this.data).draft.prospectNoise;
    for (const [k, v] of Object.entries(src.stats)) {
      const n = rng ? rng.int(noise * 2 + 1) - noise : 0;
      out[k] = Math.max(1, Math.min(99, Math.round(v + n + fp.delta)));
    }
    return out;
  }
  /** Overall at his position. */
  ovr(fp: FPlayer): number {
    const src = this.real.get(fp.src)!;
    return Math.max(30, Math.min(99, Math.round(src.ovr + fp.delta + (fp.noise != null ? this.noiseOvr(fp) : 0))));
  }
  private noiseOvr(fp: FPlayer) {
    const rng = new Rng(`noiseovr:${fp.noise}`);
    const noise = C(this.data).draft.prospectNoise;
    return rng.int(noise * 2 + 1) - noise;
  }
  private cards = new Map<string, PlayerCard>();
  card(fp: FPlayer): PlayerCard {
    const key = `${fp.id}:${fp.delta}:${fp.age}:${fp.team}`;
    const hit = this.cards.get(key);
    if (hit) return hit;
    const c = this.build(fp);
    if (this.cards.size > 20000) this.cards.clear();
    this.cards.set(key, c);
    return c;
  }
  private build(fp: FPlayer): PlayerCard {
    const src = this.real.get(fp.src)!;
    const [first, ...rest] = (fp.name ?? `${src.first} ${src.last}`).split(" ");
    const p: Player = { ...src, id: fp.id, first: first!, last: rest.join(" "), age: fp.age, ovr: this.ovr(fp), stats: this.stats(fp),
      team: fp.team ?? "FA", num: fp.num ?? src.num };
    return buildCard(p, this.data, this.norms);
  }
}

/** Salary a player asks for (tenths of $1M), from his overall, position and personality. */
export function askingSalary(fd: FranchiseData, fp: FPlayer): number {
  const S = C(fd.data).salary;
  const card = fd.real.get(fp.src)!;
  const group = fd.data.positions.maddenToGame[card.pos] ? groupKey(fd.data, fd.data.positions.maddenToGame[card.pos]!) : "ST";
  const x = Math.max(0, Math.min(1, (fd.ovr(fp) - S.salaryFloorOvr) / (99 - S.salaryFloorOvr)));
  const base = S.min + (S.max - S.min) * x ** S.salaryExp * (S.posMult[group] ?? 0.6);
  return Math.max(S.min, Math.round(base * (S.personality[fp.personality] ?? 1)));
}
function groupKey(data: GameData, pos: string): string {
  const g: Record<string, string> = { QB: "QB", RB: "RB", FB: "RB", WR: "WR", TE: "TE", LT: "OL", LG: "OL", C: "OL", RG: "OL", RT: "OL", DE: "DL", DT: "DL", NT: "DL",
    OLB: "LB", MLB: "LB", ILB: "LB", CB: "DB", FS: "DB", SS: "DB", K: "ST", P: "ST", LS: "ST" };
  void data;
  return g[pos] ?? "ST";
}
export const money = (tenths: number) => (tenths / 10).toFixed(1);

// ---------------------------------------------------------------- setup
export interface NewFranchiseOpts {
  name: string; seed: string;
  /** the NFL club you take over */
  team: string;
  /** your drafted team (players move to you from their clubs; the club's own players become free agents) */
  drafted?: { info: TeamInfo; starters: Record<string, number>; bench: number[] };
  quarterMinutes: number; injuries: boolean;
}
export function newFranchise(fd: FranchiseData, pool: readonly PlayerCard[], o: NewFranchiseOpts): Franchise {
  const data = fd.data, F = C(data), rng = new Rng(`franchise:${o.seed}`);
  const players: Record<string, FPlayer> = {};
  for (const c of pool) {
    if (!fd.real.has(c.id) || c.ovr <= 0) continue;
    const fp: FPlayer = {
      id: c.id, src: c.id, delta: 0, age: c.age, personality: PERSONALITIES[hashString(`p${c.id}`) % PERSONALITIES.length]!,
      salary: 0, years: 1 + rng.int(F.salary.maxYears), team: c.team, injury: 0, season: {}, career: {}, seasons: Math.max(0, c.age - 22),
    };
    fp.salary = Math.round(askingSalary(fd, fp) * (0.85 + rng.int(31) / 100));
    players[c.id] = fp;
  }
  const teams: FTeam[] = data.teams.teams.map((t) => ({
    abbr: t.abbr, name: t.name, nick: t.nick, c1: t.c1, c2: t.c2, c3: t.c3, conf: (t as { conf?: string }).conf ?? "?", div: (t as { div?: string }).div ?? "?",
    w: 0, l: 0, t: 0, pf: 0, pa: 0, streak: 0, morale: F.morale.start, fans: F.fans.start, deadCap: 0,
  }));
  const user = teams.find((t) => t.abbr === o.team)!;
  if (o.drafted) {
    // the club's own players become free agents; the drafted players join it
    for (const p of Object.values(players)) if (p.team === o.team) p.team = null;
    const ids = [...Object.values(o.drafted.starters), ...o.drafted.bench];
    for (const id of ids) { const p = players[id]; if (p) p.team = o.team; }
    Object.assign(user, { name: o.drafted.info.name, nick: o.drafted.info.nick, c1: o.drafted.info.c1, c2: o.drafted.info.c2, c3: o.drafted.info.c3 });
    user.lineup = { ...o.drafted.starters };
  }
  const f: Franchise = {
    v: 1, name: o.name, seed: o.seed, year: 1, phase: "regular", week: 1, user: o.team, teams, players, games: [],
    credits: F.credits.start, staff: { oc: 0, dc: 0, st: 0, trainer: 0 }, facilities: { stadium: 1, training: 1, rehab: 1 },
    security: F.security.start, expectedWins: 8, fired: false, news: [], events: [], records: { game: {}, season: {} }, awards: [], hof: [], champions: [],
    cap: 0, nextId: 9_000_000, developed: {}, draft: null, bids: [], quarterMinutes: o.quarterMinutes, injuries: o.injuries,
  };
  // AI rosters trimmed to the limit (the extras become free agents)
  for (const t of teams) trimRoster(fd, f, t.abbr);
  // a fixed cap; a club whose stars add up to more opens with its contracts scaled to fit
  f.cap = F.salary.cap;
  for (const t of teams) {
    const pay = payroll(f, t.abbr), target = F.salary.cap * F.salary.openingShare;
    if (pay <= target) continue;
    for (const p of teamPlayers(f, t.abbr)) p.salary = Math.max(F.salary.min, Math.round(p.salary * target / pay));
  }
  f.games = schedule(f, rng);
  f.expectedWins = expectedWins(fd, f);
  news(f, `${user.name} hire a new head coach. The owner expects ${f.expectedWins} wins.`, true);
  return f;
}

/** Keep a team at the roster limit: the lowest-rated surplus go to free agency. */
function trimRoster(fd: FranchiseData, f: Franchise, abbr: string) {
  const F = C(fd.data);
  const mine = teamPlayers(f, abbr).sort((a, b) => fd.ovr(b) - fd.ovr(a));
  const keep = new Set<number>();
  // keep the best natural player at every slot first, then the best of the rest
  const cards = mine.map((p) => ({ p, c: fd.card(p) }));
  for (const slot of ALL_SLOTS) {
    const pos = slotPos(slot);
    const best = cards.filter((x) => !keep.has(x.p.id) && x.c.natural[0] === pos).sort((a, b) => b.c.ovr - a.c.ovr)[0];
    if (best) keep.add(best.p.id);
  }
  for (const x of cards) if (keep.size < F.rosterMax) keep.add(x.p.id);
  for (const p of mine) if (!keep.has(p.id)) p.team = null;
}
export const teamPlayers = (f: Franchise, abbr: string) => Object.values(f.players).filter((p) => p.team === abbr && !p.retired);
export const freeAgents = (f: Franchise) => Object.values(f.players).filter((p) => p.team === null && !p.retired);
export const payroll = (f: Franchise, abbr: string) => teamPlayers(f, abbr).reduce((a, p) => a + p.salary, 0) + (f.teams.find((t) => t.abbr === abbr)?.deadCap ?? 0);
export const capSpace = (f: Franchise, abbr: string) => f.cap - payroll(f, abbr);
export const team = (f: Franchise, abbr: string) => f.teams.find((t) => t.abbr === abbr)!;

function news(f: Franchise, text: string, user = false) {
  f.news.unshift({ year: f.year, week: f.week, text, user });
  if (f.news.length > 200) f.news.length = 200;
}
function headline(f: Franchise, data: GameData, kind: string, vars: Record<string, string | number>, rng: Rng, user = false) {
  const opts = C(data).news[kind] ?? [kind];
  let t = opts[rng.int(opts.length)]!;
  for (const [k, v] of Object.entries(vars)) t = t.split(`{${k}}`).join(String(v));
  news(f, t, user);
}

// ---------------------------------------------------------------- schedule
/** 6 division games (home and away vs each rival) + 11 vs the rest of the league; 17 weeks. */
function schedule(f: Franchise, rng: Rng): FGame[] {
  const games: FGame[] = [];
  let id = f.games.length ? Math.max(...f.games.map((g) => g.id)) + 1 : 1;
  const divs = new Map<string, string[]>();
  for (const t of f.teams) (divs.get(t.div) ?? divs.set(t.div, []).get(t.div)!).push(t.abbr);
  const rounds: [string, string][][] = [[], [], [], [], [], []];
  for (const d of divs.values()) {
    if (d.length !== 4) continue;
    const [a, b, c, e] = d as [string, string, string, string];
    const rr: [string, string][][] = [[[a, b], [c, e]], [[a, c], [b, e]], [[a, e], [b, c]]];
    rr.forEach((pairs, k) => { rounds[k]!.push(...pairs); rounds[k + 3]!.push(...pairs.map(([x, y]) => [y, x] as [string, string])); });
  }
  const played = new Set<string>();
  const key = (a: string, b: string) => [a, b].sort().join("-");
  for (const r of rounds) for (const [a, b] of r) played.add(key(a, b));
  const divOf = new Map(f.teams.map((t) => [t.abbr, t.div]));
  const weeks: [string, string][][] = [...rounds];
  for (let w = 0; w < 11; w++) {
    let pairs: [string, string][] | null = null;
    for (let attempt = 0; attempt < 300 && !pairs; attempt++) {
      const left = f.teams.map((t) => t.abbr);
      for (let i = left.length - 1; i > 0; i--) { const j = rng.int(i + 1); [left[i], left[j]] = [left[j]!, left[i]!]; }
      const out: [string, string][] = [];
      let ok = true;
      while (left.length) {
        const a = left.shift()!;
        const k = left.findIndex((b) => divOf.get(b) !== divOf.get(a) && (!played.has(key(a, b)) || attempt > 200));
        if (k < 0) { ok = false; break; }
        const b = left.splice(k, 1)[0]!;
        out.push(rng.int(2) ? [a, b] : [b, a]);
      }
      if (ok) pairs = out;
    }
    for (const [a, b] of pairs!) played.add(key(a, b));
    weeks.push(pairs!);
  }
  // shuffle the week order
  for (let i = weeks.length - 1; i > 0; i--) { const j = rng.int(i + 1); [weeks[i], weeks[j]] = [weeks[j]!, weeks[i]!]; }
  weeks.forEach((pairs, w) => { for (const [home, away] of pairs) games.push({ id: id++, week: w + 1, home, away }); });
  return games;
}
export const weekGames = (f: Franchise) => f.games.filter((g) => g.week === f.week && (f.phase === "playoffs" ? Boolean(g.round) : !g.round));
export const userGame = (f: Franchise) => weekGames(f).find((g) => g.home === f.user || g.away === f.user) ?? null;
export const regularWeeks = 17;

/** Owner expectation: from the team's grade rank in the league. */
function expectedWins(fd: FranchiseData, f: Franchise): number {
  const grades = f.teams.map((t) => ({ a: t.abbr, g: teamGrade(gameRoster(fd, f, t.abbr).starters, fd.data).overall.score })).sort((x, y) => y.g - x.g);
  const rank = grades.findIndex((x) => x.a === f.user);
  return Math.round(3 + 11 * (1 - rank / Math.max(1, grades.length - 1)));
}

// ---------------------------------------------------------------- game day
/** A team's game roster: healthy players; the human's depth chart where it still holds. */
export function gameRoster(fd: FranchiseData, f: Franchise, abbr: string): Roster {
  const t = team(f, abbr);
  // (a suspension counts as a week out)
  const healthy = teamPlayers(f, abbr).filter((p) => p.injury <= 0);
  const cards = new Map(healthy.map((p) => [p.id, fd.card(p)]));
  const info: TeamInfo = { abbr: t.abbr, name: t.name, nick: t.nick, c1: t.c1, c2: t.c2, c3: t.c3 };
  let r: Roster;
  if (t.lineup) {
    const starters: Record<string, PlayerCard> = {};
    for (const [slot, id] of Object.entries(t.lineup)) { const c = cards.get(id); if (c) starters[slot] = c; }
    // a hole (injury, cut): the best healthy fit from the rest
    const used = new Set(Object.values(starters).map((c) => c.id));
    for (const slot of ALL_SLOTS) {
      if (starters[slot]) continue;
      let best: PlayerCard | null = null, bv = -1;
      for (const c of cards.values()) { if (used.has(c.id)) continue; const v = slotOverall(c, slotPos(slot), fd.data); if (v > bv) { bv = v; best = c; } }
      if (best) { starters[slot] = best; used.add(best.id); }
    }
    r = rosterFromLineup(info, starters, [...cards.values()].filter((c) => !used.has(c.id)), fd.data);
  } else r = buildRoster(info, [...cards.values()], fd.data);
  if (t.style) r.style = t.style;
  if (t.baseFront) r.baseFront = t.baseFront;
  if (t.kr && cards.has(t.kr)) r.kr = t.kr;
  if (t.pr && cards.has(t.pr)) r.pr = t.pr;
  return r;
}

/** Ratings during this franchise's games: progression, + staff for the human's units, + team morale. */
export function franchiseRatings(fd: FranchiseData, f: Franchise): (id: number) => Stats {
  const F = C(fd.data), cache = new Map<number, Stats>();
  const OFF = ["QB", "RB", "WR", "TE", "OL"], DEF = ["DL", "LB", "DB"];
  return (id) => {
    let s = cache.get(id);
    if (s) return s;
    const p = f.players[id];
    if (!p) return {};
    s = fd.stats(p);
    if (p.team) {
      const t = team(f, p.team);
      let add = F.morale.moraleRating * (t.morale - 50) / 50;
      if (p.team === f.user) {
        const g = groupKey(fd.data, fd.data.positions.maddenToGame[fd.real.get(p.src)!.pos] ?? "QB");
        if (OFF.includes(g)) add += f.staff.oc * F.staff.staffRating;
        if (DEF.includes(g)) add += f.staff.dc * F.staff.staffRating;
        if (g === "ST") add += f.staff.st * F.staff.staffRating;
      }
      const a = Math.round(add);
      if (a) s = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.max(1, Math.min(99, v + a))]));
    }
    cache.set(id, s);
    return s;
  };
}

/** A game as a self-contained job (rosters with cards + every player's ratings), so it can run in a
 *  Web Worker; `runGameJob` plays it. */
export interface GameJob { seed: string; quarterSeconds?: number; teams: [Roster, Roster]; ratings: Record<number, Stats> }
/** What recordGame needs from a played game. */
export type GameOutcome = Pick<GameResult, "players"> & { state: { score: [number, number] } };
export function gameJob(fd: FranchiseData, f: Franchise, g: FGame): GameJob {
  const R = franchiseRatings(fd, f);
  const teams: [Roster, Roster] = [gameRoster(fd, f, g.home), gameRoster(fd, f, g.away)];
  const ratings: Record<number, Stats> = {};
  for (const r of teams) for (const c of [...Object.values(r.starters), ...r.bench]) ratings[c.id] = R(c.id);
  return { seed: `${f.seed}:${f.year}:${g.id}`, quarterSeconds: g.home === f.user || g.away === f.user ? f.quarterMinutes * 60 : undefined, teams, ratings };
}
export function runGameJob(data: GameData, j: GameJob): GameOutcome {
  const r = playGame({ data, ratings: (id) => j.ratings[id] ?? {}, teams: j.teams, seed: j.seed, quarterSeconds: j.quarterSeconds });
  return { state: { score: [r.state.score[0], r.state.score[1]] }, players: r.players };
}
/** Sim a game to a final here (tests, the server; the browser uses workers). */
export function simGame(fd: FranchiseData, f: Franchise, g: FGame): GameOutcome { return runGameJob(fd.data, gameJob(fd, f, g)); }

/** Record a finished game: standings, stats, records, morale, fans, credits, injuries, news, security. */
export function recordGame(fd: FranchiseData, f: Franchise, g: FGame, r: GameOutcome, simmed: boolean) {
  if (g.score) return; // already final
  const data = fd.data, F = C(data), rng = new Rng(`${f.seed}:${f.year}:${g.id}:after`);
  const [hs, as] = [r.state.score[0], r.state.score[1]];
  g.score = [hs, as]; g.simmed = simmed;
  const home = team(f, g.home), away = team(f, g.away);
  const userIn = g.home === f.user || g.away === f.user;
  if (!g.round) {
    for (const [t, us, them] of [[home, hs, as], [away, as, hs]] as const) {
      t.pf += us; t.pa += them;
      if (us > them) { t.w++; t.streak = t.streak > 0 ? t.streak + 1 : 1; } else if (us < them) { t.l++; t.streak = t.streak < 0 ? t.streak - 1 : -1; } else t.t++;
    }
  }
  for (const [t, us, them] of [[home, hs, as], [away, as, hs]] as const) {
    const win = us > them, loss = us < them;
    t.morale = clamp(t.morale + (win ? F.morale.win : loss ? F.morale.loss : 0), 0, 100);
    t.fans = clamp(t.fans + (win ? F.fans.win : loss ? F.fans.loss : 0) + (win && g.round ? F.fans.playoff : 0) + (t.abbr === f.user && t.abbr === g.home ? f.facilities.stadium * F.facilities.stadiumFans / 10 : 0), 0, 100);
    if (t.abbr === f.user) {
      f.credits += win ? F.credits.win : loss ? F.credits.loss : F.credits.loss;
      if (win && g.round) f.credits += F.credits.playoffWin;
      if (t.abbr === g.home) f.credits += Math.floor(t.fans / 25) * F.credits.fansPer25;
      f.security = clamp(f.security + (win ? F.security.securityWin : loss ? -F.security.securityLoss : 0), -50, 100);
    }
  }
  // player stats and records
  for (const line of r.players) {
    const p = f.players[line.id];
    if (!p) continue;
    for (const [k, v] of Object.entries(line)) if (typeof v === "number" && k !== "id" && k !== "team") p.season[k] = (p.season[k] ?? 0) + v;
    for (const k of RECORD_KEYS) {
      const v = line[k];
      if (typeof v === "number" && v > (f.records.game[k]?.value ?? 0)) f.records.game[k] = { value: v, who: fd.card(p).name, team: p.team ?? "", year: f.year };
    }
    if (p.team === f.user && ((line.passYds as number) >= 300 || (line.rushYds as number) >= 100 || (line.recYds as number) >= 100)) f.credits += F.credits.milestone;
  }
  for (const abbr of [g.home, g.away]) for (const p of teamPlayers(f, abbr)) if (p.injury <= 0) p.season.games = (p.season.games ?? 0) + 1;
  // injuries (starters who played)
  if (f.injuries) {
    for (const [abbr, side] of [[g.home, 0], [g.away, 1]] as const) {
      const ro = gameRoster(fd, f, abbr);
      for (const c of Object.values(ro.starters)) {
        const p = f.players[c.id]!;
        const rate = F.injuries.injuryPerGame * (abbr === f.user ? 1 - f.staff.trainer * F.staff.trainerInjury : 1);
        if (rng.int(100000) >= rate * 100000) continue;
        const w = F.injuries.injuryWeeks;
        const pick = w[rng.weighted(w.map((x) => x[1]))]![0];
        const weeks = Math.max(1, Math.round(pick * (abbr === f.user ? 1 - f.facilities.rehab * F.facilities.rehabWeeks : 1)));
        p.injury = weeks;
        if (abbr === f.user || fd.ovr(p) >= 85) headline(f, data, "injury", { player: c.name, team: abbr, weeks, s: weeks === 1 ? "" : "s" }, rng, abbr === f.user);
        void side;
      }
    }
  }
  // the headline
  const w = hs >= as ? home : away, l = hs >= as ? away : home, ws = Math.max(hs, as), ls = Math.min(hs, as);
  const star = topPerformer(fd, f, r, w.abbr);
  const kind = ws - ls >= 24 ? "blowout" : w.w + w.l > 3 && w.w / Math.max(1, w.w + w.l) < l.w / Math.max(1, l.w + l.l) - 0.25 ? "upset" : "win";
  if (userIn || kind !== "win" || g.round) headline(f, data, kind, { W: w.name, L: l.name, ws, ls, star }, rng, userIn);
  for (const t of [home, away]) if (Math.abs(t.streak) >= 4 && (t.abbr === f.user || Math.abs(t.streak) >= 6)) headline(f, data, "streak", { team: t.name, n: Math.abs(t.streak) }, rng, t.abbr === f.user);
}
function topPerformer(fd: FranchiseData, f: Franchise, r: GameOutcome, abbr: string): string {
  const W = C(fd.data).awards.mvpWeights;
  let best = "", bv = -1;
  for (const line of r.players) {
    const p = f.players[line.id];
    if (!p || p.team !== abbr) continue;
    const v = Object.entries(W).reduce((a, [k, w]) => a + ((line[k] as number) ?? 0) * w, 0);
    if (v > bv) { bv = v; best = line.name; }
  }
  return best || team(f, abbr).name;
}
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** All of this week's games are in: heal, events, next week (or the playoffs, or the off-season). */
export function finishWeek(fd: FranchiseData, f: Franchise) {
  const data = fd.data, F = C(data), rng = new Rng(`${f.seed}:${f.year}:w${f.week}:events`);
  for (const p of Object.values(f.players)) if (p.injury > 0) p.injury--;
  if (f.phase === "regular") {
    if (rng.int(1000) < F.events.eventChance * 1000) makeEvent(fd, f, rng);
    if (f.week < regularWeeks) { f.week++; return; }
    startPlayoffs(fd, f);
    return;
  }
  // playoffs: the next round, or the champion
  const round = weekGames(f)[0]?.round;
  const rounds = F.playoffs.rounds;
  const k = rounds.indexOf(round ?? "");
  if (k === rounds.length - 1) {
    const g = weekGames(f)[0]!;
    const champ = g.score![0] > g.score![1] ? g.home : g.away;
    f.champions.unshift({ year: f.year, team: champ });
    headline(f, data, "title", { team: team(f, champ).name }, rng, champ === f.user);
    if (champ === f.user) { f.credits += F.credits.title; team(f, champ).fans = clamp(team(f, champ).fans + F.fans.title, 0, 100); }
    endSeason(fd, f);
    return;
  }
  nextPlayoffRound(fd, f, k + 1);
}

// ---------------------------------------------------------------- standings and playoffs
export function standings(f: Franchise, conf?: string): FTeam[] {
  const pct = (t: FTeam) => (t.w + t.t / 2) / Math.max(1, t.w + t.l + t.t);
  return f.teams.filter((t) => !conf || t.conf === conf).slice().sort((a, b) => pct(b) - pct(a) || (b.pf - b.pa) - (a.pf - a.pa) || a.abbr.localeCompare(b.abbr));
}
/** Seeds per conference: division winners 1-4, then wild cards. */
export function seeds(f: Franchise, conf: string, n: number): string[] {
  const all = standings(f, conf);
  const divs = [...new Set(all.map((t) => t.div))];
  const winners = divs.map((d) => all.find((t) => t.div === d)!).sort((a, b) => all.indexOf(a) - all.indexOf(b));
  const rest = all.filter((t) => !winners.includes(t));
  return [...winners, ...rest].slice(0, n).map((t) => t.abbr);
}
function startPlayoffs(fd: FranchiseData, f: Franchise) {
  const F = C(fd.data);
  f.phase = "playoffs";
  f.week = regularWeeks + 1;
  const confs = [...new Set(f.teams.map((t) => t.conf))];
  let id = Math.max(...f.games.map((g) => g.id)) + 1;
  const made = confs.flatMap((c) => seeds(f, c, F.playoffs.perConference));
  news(f, made.includes(f.user) ? `${team(f, f.user).name} are in the playoffs!` : `${team(f, f.user).name} miss the playoffs.`, true);
  for (const c of confs) {
    const s = seeds(f, c, F.playoffs.perConference);
    // 2v7, 3v6, 4v5; the 1 seed has a bye
    for (const [a, b] of [[1, 6], [2, 5], [3, 4]] as const) if (s[a] && s[b]) f.games.push({ id: id++, week: f.week, round: F.playoffs.rounds[0], home: s[a]!, away: s[b]! });
  }
}
function nextPlayoffRound(fd: FranchiseData, f: Franchise, k: number) {
  const F = C(fd.data), round = F.playoffs.rounds[k]!;
  const last = weekGames(f);
  f.week++;
  let id = Math.max(...f.games.map((g) => g.id)) + 1;
  const confs = [...new Set(f.teams.map((t) => t.conf))];
  const winner = (g: FGame) => (g.score![0] > g.score![1] ? g.home : g.away);
  const alive = new Set(last.map(winner));
  if (k === F.playoffs.rounds.length - 1) {
    const champs = confs.map((c) => [...alive].find((a) => team(f, a).conf === c)!).filter(Boolean);
    f.games.push({ id: id++, week: f.week, round, home: champs[0]!, away: champs[1]! });
    return;
  }
  for (const c of confs) {
    const s = seeds(f, c, F.playoffs.perConference);
    // the top seed's bye ends; re-seed: best vs worst
    const left = s.filter((a, i) => (k === 1 && i === 0) || alive.has(a));
    for (let i = 0; i < left.length / 2; i++) f.games.push({ id: id++, week: f.week, round, home: left[i]!, away: left[left.length - 1 - i]! });
  }
}

// ---------------------------------------------------------------- events
function makeEvent(fd: FranchiseData, f: Franchise, rng: Rng) {
  const F = C(fd.data);
  const mine = teamPlayers(f, f.user);
  const pickOf = (pers: PlayerPersonality, cond: (p: FPlayer) => boolean) => { const c = mine.filter((p) => p.personality === pers && cond(p)); return c.length ? c[rng.int(c.length)]! : null; };
  const id = (f.events.at(-1)?.id ?? 0) + 1 + f.year * 1000 + f.week * 10;
  const nm = (p: FPlayer) => fd.card(p).name;
  const opts: (() => FEvent | null)[] = [
    () => { const p = pickOf("Diva", (x) => fd.ovr(x) >= F.events.dealMinOvr && x.years <= 2); return p && { id, kind: "deal", player: p.id, text: `${nm(p)} wants a new deal: ${F.salary.maxYears > 3 ? 4 : 3} years at $${money(Math.round(askingSalary(fd, p) * 1.1))}M a year.`, choices: [{ id: "extend", label: `EXTEND (${F.credits.extendCredits} credits)` }, { id: "refuse", label: "REFUSE (morale drops)" }] }; },
    () => { const p = pickOf("Hothead", () => true); return p && { id, kind: "hothead", player: p.id, text: `${nm(p)} got into a fight at practice.`, choices: [{ id: "suspend", label: "SUSPEND HIM A GAME" }, { id: "ignore", label: "LET IT SLIDE (morale drops)" }] }; },
    () => { const p = pickOf("Leader", () => true); return p && { id, kind: "leader", player: p.id, text: `${nm(p)} called a players-only meeting. The locker room is fired up.`, choices: [{ id: "ok", label: "GOOD" }] }; },
    () => { const p = pickOf("Loyal", (x) => x.salary > 60); return p && { id, kind: "loyal", player: p.id, text: `${nm(p)} offers to take a 15% pay cut to help the cap.`, choices: [{ id: "accept", label: "ACCEPT" }, { id: "decline", label: "DECLINE (morale up)" }] }; },
  ];
  const ev = opts[rng.int(opts.length)]!();
  if (ev) f.events.push(ev);
}
export function resolveEvent(fd: FranchiseData, f: Franchise, eventId: number, choice: string) {
  const F = C(fd.data), ev = f.events.find((e) => e.id === eventId);
  if (!ev) return;
  f.events = f.events.filter((e) => e !== ev);
  const p = f.players[ev.player], t = team(f, f.user), sw = F.events.moraleSwing;
  if (!p) return;
  if (ev.kind === "deal") {
    if (choice === "extend" && f.credits >= F.credits.extendCredits) { f.credits -= F.credits.extendCredits; p.salary = Math.round(askingSalary(fd, p) * 1.1); p.years = 4; t.morale = clamp(t.morale + sw, 0, 100); news(f, `${t.name} give ${fd.card(p).name} a new deal.`, true); }
    else t.morale = clamp(t.morale - sw, 0, 100);
  } else if (ev.kind === "hothead") {
    if (choice === "suspend") { p.injury = Math.max(p.injury, 1); t.morale = clamp(t.morale + sw / 2, 0, 100); }
    else t.morale = clamp(t.morale - sw, 0, 100);
  } else if (ev.kind === "leader") t.morale = clamp(t.morale + sw, 0, 100);
  else if (ev.kind === "loyal") {
    if (choice === "accept") p.salary = Math.round(p.salary * 0.85); else t.morale = clamp(t.morale + 2, 0, 100);
  }
}

// ---------------------------------------------------------------- the human's moves
export function developCost(fd: FranchiseData, p: FPlayer) { const F = C(fd.data).credits; return F.developBase + Math.max(0, Math.floor((fd.ovr(p) - 60) / 8)) * F.developPer8; }
export function develop(fd: FranchiseData, f: Franchise, id: number): string | null {
  const p = f.players[id], F = C(fd.data).credits;
  if (!p || p.team !== f.user) return "not your player";
  if ((f.developed[id] ?? 0) >= F.developMaxPerSeason) return "already developed as far as he can go this season";
  const cost = developCost(fd, p);
  if (f.credits < cost) return `needs ${cost} credits`;
  if (fd.ovr(p) >= 99) return "maxed out";
  f.credits -= cost; p.delta++; f.developed[id] = (f.developed[id] ?? 0) + 1;
  return null;
}
export function extend(fd: FranchiseData, f: Franchise, id: number, years: number): string | null {
  const p = f.players[id], F = C(fd.data);
  if (!p || p.team !== f.user) return "not your player";
  const ask = askingSalary(fd, p);
  if (f.credits < F.credits.extendCredits) return `needs ${F.credits.extendCredits} credits`;
  if (capSpace(f, f.user) + p.salary - ask < 0) return "not enough cap space";
  f.credits -= F.credits.extendCredits;
  p.salary = ask; p.years = Math.max(1, Math.min(F.salary.maxYears, years));
  return null;
}
export function cut(fd: FranchiseData, f: Franchise, id: number): string | null {
  const p = f.players[id], F = C(fd.data);
  if (!p || p.team !== f.user) return "not your player";
  if (teamPlayers(f, f.user).length <= 30) return "the roster can't go below 30";
  const t = team(f, f.user);
  t.deadCap += Math.round(p.salary * F.salary.deadCapShare);
  if (p.personality === "Loyal") t.morale = clamp(t.morale - F.events.moraleSwing / 2, 0, 100);
  p.team = null;
  if (t.lineup) for (const [s, pid] of Object.entries(t.lineup)) if (pid === id) delete t.lineup[s];
  news(f, `${t.name} release ${fd.card(p).name}.`, true);
  return null;
}
export function upgradeStaff(fd: FranchiseData, f: Franchise, k: StaffKind): string | null {
  const F = C(fd.data), lvl = f.staff[k];
  if (lvl >= F.staff.maxLevel) return "already the best there is";
  const cost = F.credits.staffCost[lvl]!;
  if (f.credits < cost) return `needs ${cost} credits`;
  f.credits -= cost; f.staff[k] = lvl + 1;
  return null;
}
export function upgradeFacility(fd: FranchiseData, f: Franchise, k: FacilityKind): string | null {
  const F = C(fd.data), lvl = f.facilities[k];
  if (lvl >= F.facilities.maxLevel) return "maxed out";
  const cost = F.credits.facilityCost[lvl]!;
  if (f.credits < cost) return `needs ${cost} credits`;
  f.credits -= cost; f.facilities[k] = lvl + 1;
  return null;
}
/** Trade value: overall (steeply), youth, contract. */
export function tradeValue(fd: FranchiseData, p: FPlayer): number {
  const o = fd.ovr(p);
  const age = p.age <= 25 ? 1.15 : p.age >= 31 ? 0.75 : 1;
  return Math.max(1, (o - 50) ** 2 * age - p.salary * 0.3);
}
/** Offer players for one of an AI team's players. Returns null when the AI accepts (the trade is done). */
export function proposeTrade(fd: FranchiseData, f: Franchise, give: number[], get: number): string | null {
  const F = C(fd.data), target = f.players[get];
  if (!target || !target.team || target.team === f.user) return "pick a player on another team";
  const gp = give.map((id) => f.players[id]).filter((p): p is FPlayer => Boolean(p && p.team === f.user));
  if (!gp.length) return "offer at least one of your players";
  const vGive = gp.reduce((a, p) => a + tradeValue(fd, p), 0), vGet = tradeValue(fd, target);
  if (vGive < vGet * F.trades.tradeMargin) return `${team(f, target.team).name} say no (they want more value)`;
  const payAfter = payroll(f, f.user) - gp.reduce((a, p) => a + p.salary, 0) + target.salary;
  if (payAfter > f.cap) return "that would put you over the cap";
  const from = target.team;
  for (const p of gp) p.team = from;
  target.team = f.user;
  trimRoster(fd, f, from);
  headline(f, fd.data, "trade", { team: team(f, f.user).name, player: fd.card(target).name, from: team(f, from).name }, new Rng(`${f.seed}:trade:${get}`), true);
  return null;
}
export function setLineup(f: Franchise, r: Roster) {
  const t = team(f, f.user);
  t.lineup = Object.fromEntries(Object.entries(r.starters).map(([k, c]) => [k, c.id]));
  t.kr = r.kr; t.pr = r.pr; t.style = r.style; t.baseFront = r.baseFront;
}

// ---------------------------------------------------------------- the off-season
function endSeason(fd: FranchiseData, f: Franchise) {
  const data = fd.data, F = C(data), rng = new Rng(`${f.seed}:${f.year}:offseason`);
  const ut = team(f, f.user);
  // awards
  const score = (p: FPlayer, w: Record<string, number>) => Object.entries(w).reduce((a, [k, v]) => a + (p.season[k] ?? 0) * v, 0);
  const active = Object.values(f.players).filter((p) => p.team && !p.retired);
  const best = (w: Record<string, number>, filter: (p: FPlayer) => boolean = () => true) => active.filter(filter).sort((a, b) => score(b, w) - score(a, w))[0];
  const award = (name: string, p: FPlayer | undefined) => { if (!p) return; const c = fd.card(p); f.awards.unshift({ year: f.year, award: name, who: c.name, team: p.team ?? "" }); headline(f, data, "award", { player: c.name, team: p.team ?? "", award: name }, rng, p.team === f.user); };
  award("MVP", best(F.awards.mvpWeights));
  award("Defensive Player of the Year", best(F.awards.dpoyWeights));
  award("Rookie of the Year", best({ ...F.awards.mvpWeights, ...F.awards.dpoyWeights }, (p) => p.rookieYear === f.year));
  // season records, career totals
  for (const p of active) {
    for (const k of RECORD_KEYS) { const v = p.season[k] ?? 0; if (v > (f.records.season[k]?.value ?? 0)) f.records.season[k] = { value: v, who: fd.card(p).name, team: p.team ?? "", year: f.year }; }
    for (const [k, v] of Object.entries(p.season)) p.career[k] = (p.career[k] ?? 0) + v;
    if ((p.season.games ?? 0) > 0) p.seasons++;
    p.season = {};
  }
  // the owner's verdict
  const playoffs = f.games.some((g) => g.round && (g.home === f.user || g.away === f.user));
  const champ = f.champions[0]?.year === f.year && f.champions[0].team === f.user;
  f.security = clamp(f.security + (ut.w - f.expectedWins) * F.security.securityPerWin + (playoffs ? F.security.playoffBonus : 0) + (champ ? F.security.titleBonus : 0), -50, 100);
  if (f.security < 0) { f.fired = true; headline(f, data, "fired", { team: ut.name, record: `${ut.w}-${ut.l}` }, rng, true); }
  // aging, progression, retirement
  for (const p of Object.values(f.players)) {
    if (p.retired) continue;
    p.age++;
    const band = F.progression.bands.find((b) => p.age <= b[0]) ?? F.progression.bands[F.progression.bands.length - 1]!;
    let d = band[1] + (rng.int(2001) / 1000 - 1) * band[2];
    if (p.team === f.user) d += f.facilities.training * F.facilities.trainingProg + f.staff.trainer * F.staff.trainerProg;
    p.delta += Math.round(d);
    const o = fd.ovr(p);
    const yearsOver = p.age - F.retirement.retireAge;
    const retire = (yearsOver >= 0 && rng.int(1000) < Math.min(950, (yearsOver + 1) * F.retirement.retireChancePerYear * 1000)) || (p.age >= 30 && o < F.retirement.retireOvr && rng.int(2) === 0);
    if (retire) {
      p.retired = true;
      const c = fd.card(p);
      if (o >= 80 || p.team === f.user) headline(f, data, "retire", { player: c.name, seasons: p.seasons }, rng, p.team === f.user);
      const career = score({ ...p, season: p.career } as FPlayer, F.awards.mvpWeights) + score({ ...p, season: p.career } as FPlayer, F.awards.dpoyWeights);
      if (career >= F.awards.hofCareerScore) f.hof.unshift({ name: c.name, pos: c.pos, years: `${f.year - p.seasons + 1}-${f.year}`, score: Math.round(career) });
      if (p.team) { const t = team(f, p.team); if (t.lineup) for (const [s, pid] of Object.entries(t.lineup)) if (pid === p.id) delete t.lineup[s]; }
      p.team = null;
      continue;
    }
    // contracts run down; AI teams re-sign most of their expiring players, the rest test free agency
    p.years--;
    if (p.years <= 0 && p.team && p.team !== f.user) {
      if (rng.int(100) < 60 && o >= 65) { p.salary = askingSalary(fd, p); p.years = 1 + rng.int(F.salary.maxYears); }
      else p.team = null;
    }
  }
  for (const t of f.teams) t.deadCap = 0;
  f.developed = {};
  f.phase = "resign";
}
/** The human's expiring contracts (re-sign or let go before the draft). */
export const expiring = (f: Franchise) => teamPlayers(f, f.user).filter((p) => p.years <= 0);
export function resign(fd: FranchiseData, f: Franchise, id: number, years: number): string | null {
  const p = f.players[id];
  if (!p || p.years > 0) return "not expiring";
  const ask = askingSalary(fd, p);
  if (capSpace(f, f.user) + p.salary - ask < 0) return "not enough cap space";
  p.salary = ask; p.years = Math.max(1, Math.min(C(fd.data).salary.maxYears, years));
  return null;
}
/** Let the rest of the expiring contracts go and open the rookie draft. */
export function startDraft(fd: FranchiseData, f: Franchise, pool: readonly PlayerCard[]) {
  const F = C(fd.data), rng = new Rng(`${f.seed}:${f.year}:draft`);
  for (const p of expiring(f)) { p.team = null; p.years = 0; }
  // the draft class: real young players' ratings as templates, noise, invented names
  const templates = pool.filter((c) => c.age <= 25 && c.ovr >= 55 && c.ovr <= F.draft.prospectOvrMax && fd.real.has(c.id));
  const n = F.draft.draftRounds * F.draft.prospectsPerRound;
  const ids: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = templates[rng.int(templates.length)]!;
    const id = f.nextId++;
    const fp: FPlayer = {
      id, src: t.id, name: `${F.names.first[rng.int(F.names.first.length)]} ${F.names.last[rng.int(F.names.last.length)]}`, noise: rng.int(1e9),
      num: 1 + rng.int(98), delta: -(3 + rng.int(6)), age: F.draft.prospectAgeMin + rng.int(F.draft.prospectAgeMax - F.draft.prospectAgeMin + 1),
      personality: PERSONALITIES[rng.int(PERSONALITIES.length)]!, salary: 0, years: F.draft.prospectYears, team: null, injury: 0, season: {}, career: {}, seasons: 0, rookieYear: f.year + 1,
    };
    fp.salary = Math.max(F.salary.min, Math.round(askingSalary(fd, fp) * 0.5));
    f.players[id] = fp;
    ids.push(id);
  }
  // worst record picks first
  const order = standings(f).reverse().map((t) => t.abbr);
  f.draft = { order, pick: 0, pool: ids, offers: [], log: [] };
  f.phase = "draft";
  draftAdvance(fd, f);
}
const draftTeam = (d: FDraft) => d.order[d.pick % d.order.length]!;
export const draftRound = (fd: FranchiseData, d: FDraft) => Math.floor(d.pick / d.order.length) + 1;
/** AI teams pick until it's the human's turn (Triple Draft: three offers) or the draft is over. */
export function draftAdvance(fd: FranchiseData, f: Franchise) {
  const F = C(fd.data), d = f.draft!;
  const total = F.draft.draftRounds * d.order.length;
  while (d.pick < total) {
    const t = draftTeam(d);
    const avail = d.pool.filter((id) => !f.players[id]!.team).sort((a, b) => fd.ovr(f.players[b]!) - fd.ovr(f.players[a]!));
    if (!avail.length) break;
    if (t === f.user) {
      // three options from the best dozen available
      const rng = new Rng(`${f.seed}:${f.year}:offer:${d.pick}`);
      const top = avail.slice(0, 12), offers: number[] = [];
      while (offers.length < 3 && top.length) offers.push(top.splice(rng.int(top.length), 1)[0]!);
      d.offers = offers;
      return;
    }
    takeProspect(fd, f, t, avail[0]!);
  }
  d.offers = [];
  endDraft(fd, f);
}
function takeProspect(fd: FranchiseData, f: Franchise, t: string, id: number) {
  const d = f.draft!;
  f.players[id]!.team = t;
  d.log.push({ team: t, player: id, round: draftRound(fd, d) });
  d.pick++;
}
export function draftChoose(fd: FranchiseData, f: Franchise, id: number) {
  const d = f.draft!;
  if (!d.offers.includes(id) || draftTeam(d) !== f.user) return;
  takeProspect(fd, f, f.user, id);
  d.offers = [];
  draftAdvance(fd, f);
}
function endDraft(fd: FranchiseData, f: Franchise) {
  // undrafted prospects join free agency
  for (const id of f.draft!.pool) if (!f.players[id]!.team) f.players[id]!.years = 1;
  f.phase = "freeAgency";
  f.bids = [];
  void fd;
}
export function placeBid(fd: FranchiseData, f: Franchise, b: FBid): string | null {
  const F = C(fd.data), p = f.players[b.player];
  if (!p || p.team !== null || p.retired) return "not a free agent";
  const others = f.bids.filter((x) => x.player !== b.player);
  if (others.length >= F.freeAgency.maxUserBids) return `at most ${F.freeAgency.maxUserBids} offers`;
  const committed = others.reduce((a, x) => a + x.salary, 0);
  if (b.salary + committed > capSpace(f, f.user)) return "not enough cap space for all your offers";
  f.bids = [...others, { ...b, years: Math.max(1, Math.min(F.salary.maxYears, b.years)) }];
  return null;
}
/** Free agents choose between the human's offers and the AI's; AI teams fill their rosters; new season. */
export function endFreeAgency(fd: FranchiseData, f: Franchise): string[] {
  const data = fd.data, F = C(data), rng = new Rng(`${f.seed}:${f.year}:fa`);
  const results: string[] = [];
  const fas = freeAgents(f).sort((a, b) => fd.ovr(b) - fd.ovr(a));
  const appeal = (abbr: string) => 1 + F.freeAgency.teamAppeal * team(f, abbr).fans / 100;
  for (const p of fas) {
    const ask = askingSalary(fd, p);
    const offers: { team: string; salary: number; years: number; v: number }[] = [];
    const mine = f.bids.find((b) => b.player === p.id);
    if (mine && capSpace(f, f.user) >= mine.salary) offers.push({ team: f.user, ...mine, v: mine.salary * appeal(f.user) * (mine.salary >= ask * 0.9 ? 1 : 0.5) });
    // a few AI teams with room and a roster spot
    const ai = f.teams.filter((t) => t.abbr !== f.user && teamPlayers(f, t.abbr).length < F.rosterMax && capSpace(f, t.abbr) >= ask);
    for (let k = 0; k < Math.min(3, ai.length); k++) {
      const t = ai[rng.int(ai.length)]!;
      const sal = Math.round(ask * (F.freeAgency.aiBidMin + (rng.int(1001) / 1000) * (F.freeAgency.aiBidMax - F.freeAgency.aiBidMin)));
      if (capSpace(f, t.abbr) >= sal) offers.push({ team: t.abbr, salary: sal, years: 1 + rng.int(3), v: sal * appeal(t.abbr) });
    }
    if (!offers.length) continue;
    const best = offers.sort((a, b) => b.v - a.v)[0]!;
    p.team = best.team; p.salary = best.salary; p.years = best.years;
    if (best.team === f.user) { results.push(`${fd.card(p).name} signs with you`); headline(f, data, "signing", { team: team(f, f.user).name, player: fd.card(p).name, years: best.years, money: money(best.salary * best.years) }, rng, true); }
    else if (mine) results.push(`${fd.card(p).name} signs with ${team(f, best.team).name}`);
    else if (fd.ovr(p) >= 82) headline(f, data, "signing", { team: team(f, best.team).name, player: fd.card(p).name, years: best.years, money: money(best.salary * best.years) }, rng);
  }
  f.bids = [];
  newSeason(fd, f);
  return results;
}
function newSeason(fd: FranchiseData, f: Franchise) {
  const F = C(fd.data), rng = new Rng(`${f.seed}:${f.year + 1}:season`);
  // facilities need upkeep
  for (const k of Object.keys(f.facilities) as FacilityKind[]) {
    const lvl = f.facilities[k], cost = lvl * F.credits.maintainPerLevel;
    if (lvl <= 0) continue;
    if (f.credits >= cost) f.credits -= cost; else { f.facilities[k] = lvl - 1; news(f, `The ${k} facility fell into disrepair (level ${lvl - 1}).`, true); }
  }
  for (const t of f.teams) {
    Object.assign(t, { w: 0, l: 0, t: 0, pf: 0, pa: 0, streak: 0 });
    if (t.abbr !== f.user) trimRoster(fd, f, t.abbr);
  }
  f.year++;
  f.week = 1;
  f.phase = "regular";
  f.games = schedule({ ...f, games: [] }, rng);
  f.draft = null;
  f.expectedWins = expectedWins(fd, f);
  news(f, `Season ${f.year} kicks off. The owner expects ${f.expectedWins} wins.`, true);
}
/** After being fired: take over another club (keeps the league, resets the job). */
export function takeNewJob(fd: FranchiseData, f: Franchise, abbr: string) {
  const old = team(f, f.user);
  delete old.lineup;
  f.user = abbr;
  f.fired = false;
  f.security = C(fd.data).security.start;
  f.staff = { oc: 0, dc: 0, st: 0, trainer: 0 };
  f.expectedWins = expectedWins(fd, f);
  news(f, `${team(f, abbr).name} hire a new head coach.`, true);
}

// ---------------------------------------------------------------- league stats
export function leaders(fd: FranchiseData, f: Franchise, key: string, n = 10, career = false) {
  return Object.values(f.players).filter((p) => (career ? p.career[key] ?? 0 : p.season[key] ?? 0) > 0)
    .sort((a, b) => (career ? (b.career[key] ?? 0) - (a.career[key] ?? 0) : (b.season[key] ?? 0) - (a.season[key] ?? 0))).slice(0, n)
    .map((p) => ({ id: p.id, name: fd.card(p).name, team: p.team ?? "FA", value: career ? p.career[key] ?? 0 : p.season[key] ?? 0 }));
}
