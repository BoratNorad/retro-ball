// Worker for harness.ts: plays games [from, to) and prints aggregated JSON on stdout.
import { buildRoster, playGame, Rng, slotOverall, slotPos, teamGrade, ALL_SLOTS, type Roster } from "@tdf/sim";
import { simEnv } from "./setup.js";

const [fromS, toS, seed] = process.argv.slice(2);
const from = Number(fromS), to = Number(toS);
const env = await simEnv();
const abbrs = env.data.teams.teams.map((t) => t.abbr);
const agg: Record<string, number> = {};
const add = (k: string, v: number) => { agg[k] = (agg[k] ?? 0) + v; };
const byRarity: Record<string, number> = {};
const scores: number[] = [];
const fitRows: { d: Record<string, number>; margin: number }[] = [];
const epicPlus = (r: Roster) => Object.values(r.starters).filter((c) => c.tier === "ELITE" || c.tier === "PRO_BOWL").length;
const teamOvr = (r: Roster) => Object.entries(r.starters).reduce((s, [slot, c]) => s + slotOverall(c, slotPos(slot), env.data), 0);
for (let g = from; g < to; g++) {
  const pick = new Rng(`${seed}-match-${g}`);
  const i = pick.int(32);
  let j = pick.int(31); if (j >= i) j++;
  // RANDOM_ROSTERS=1: draft-like random teams (each slot from a random handful of natural players)
  // so every position's talent varies independently - needed to measure what wins
  const randomRoster = (k: number): Roster => {
    const t = env.data.teams.teams[k]!;
    const picks = new Set<typeof env.pool[number]>();
    for (const slot of ALL_SLOTS) {
      const pos = slotPos(slot);
      const cands = env.pool.filter((c) => c.natural[0] === pos && !picks.has(c));
      for (let n = 0; n < 2 && cands.length; n++) picks.add(cands.splice(pick.int(cands.length), 1)[0]!);
    }
    return buildRoster({ abbr: t.abbr, name: t.name, nick: t.nick, c1: t.c1, c2: t.c2, c3: t.c3 }, [...picks], env.data);
  };
  const home = process.env.RANDOM_ROSTERS ? randomRoster(i) : env.roster(abbrs[i]!);
  const away = process.env.RANDOM_ROSTERS ? randomRoster(j) : env.roster(abbrs[j]!);
  const r = playGame({ data: env.data, ratings: env.ratings, teams: [home, away], seed: `${seed}-${g}`, abilities: process.env.ABILITIES !== "0" });
  add("games", 1);
  for (const pl of r.log) if (pl.kind === "play" && pl.name && !["Punt", "Kneel", "Spike", "—"].includes(pl.name) && !pl.name.includes("field goal")) {
    add(`play:${pl.name}:n`, 1); add(`play:${pl.name}:yds`, pl.yards);
  }
  if (r.state.quarter > 4) add("ot", 1);
  for (const t of r.teams) {
    for (const [k, v] of Object.entries(t)) if (typeof v === "number") add(k, v);
    for (const [b, [m, n]] of Object.entries(t.fgByDist)) { const key = b === "<30" ? "lt30" : b; add(`fg_${key}_made`, m); add(`fg_${key}_att`, n); }
    scores.push(t.score);
  }
  const winner = r.state.score[0] > r.state.score[1] ? 0 : r.state.score[1] > r.state.score[0] ? 1 : -1;
  if (process.env.FIT_OUT) {
    // per-position talent differences (home - away) and the result, for fitting grade weights
    const posOvr = (ro: Roster) => {
      const m: Record<string, number[]> = {};
      for (const [slot, c] of Object.entries(ro.starters)) (m[slotPos(slot)] ??= []).push(slotOverall(c, slotPos(slot), env.data));
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.reduce((x, y) => x + y, 0) / v.length]));
    };
    const h = posOvr(home), a2 = posOvr(away);
    fitRows.push({ d: Object.fromEntries(Object.keys(h).map((k) => [k, Math.round((h[k]! - a2[k]!) * 10) / 10])), margin: r.state.score[0] - r.state.score[1] });
  }
  if (winner < 0) continue;
  const rs = [home, away];
  const ep = rs.map(epicPlus);
  if (ep[0] !== ep[1]) { byRarity.moreGames = (byRarity.moreGames ?? 0) + 1; if (ep[winner]! > ep[1 - winner]!) byRarity.moreWins = (byRarity.moreWins ?? 0) + 1; }
  const ov = rs.map(teamOvr);
  if (ov[0] !== ov[1]) { byRarity.gradeGames = (byRarity.gradeGames ?? 0) + 1; if (ov[winner]! > ov[1 - winner]!) byRarity.gradeWins = (byRarity.gradeWins ?? 0) + 1; }
  // win % by size of the talent gap (average starter overall, 25 starters)
  const gap = Math.abs(ov[0]! - ov[1]!) / 25;
  const bucket = gap < 1 ? "0-1" : gap < 2 ? "1-2" : gap < 3 ? "2-3" : gap < 5 ? "3-5" : "5+";
  byRarity[`gap_${bucket}_n`] = (byRarity[`gap_${bucket}_n`] ?? 0) + 1;
  // same, using the position-weighted team grade the draft UI shows
  const gr = rs.map((r) => teamGrade(r.starters, env.data).overall.score);
  const ggap = Math.abs(gr[0]! - gr[1]!);
  const gb = ggap < 1 ? "0-1" : ggap < 2 ? "1-2" : ggap < 3 ? "2-3" : ggap < 5 ? "3-5" : "5+";
  byRarity[`ggap_${gb}_n`] = (byRarity[`ggap_${gb}_n`] ?? 0) + 1;
  if (gr[winner]! > gr[1 - winner]!) byRarity[`ggap_${gb}_w`] = (byRarity[`ggap_${gb}_w`] ?? 0) + 1;
  if (ov[winner]! > ov[1 - winner]!) byRarity[`gap_${bucket}_w`] = (byRarity[`gap_${bucket}_w`] ?? 0) + 1;
}
if (process.env.FIT_OUT) (await import("node:fs")).appendFileSync(process.env.FIT_OUT, fitRows.map((x) => JSON.stringify(x)).join("\n") + "\n");
process.stdout.write(JSON.stringify({ agg, byRarity, scores }));
