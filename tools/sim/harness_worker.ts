// Worker for harness.ts: plays games [from, to) and prints aggregated JSON on stdout.
import { playGame, Rng, slotOverall, slotPos, type Roster } from "@tdf/sim";
import { simEnv } from "./setup.js";

const [fromS, toS, seed] = process.argv.slice(2);
const from = Number(fromS), to = Number(toS);
const env = await simEnv();
const abbrs = env.data.teams.teams.map((t) => t.abbr);
const agg: Record<string, number> = {};
const add = (k: string, v: number) => { agg[k] = (agg[k] ?? 0) + v; };
const byRarity: Record<string, number> = {};
const byType: Record<string, [number, number]> = {};
const scores: number[] = [];
const epicPlus = (r: Roster) => Object.values(r.starters).filter((c) => c.rarity === "MYTHIC" || c.rarity === "EPIC").length;
const teamOvr = (r: Roster) => Object.entries(r.starters).reduce((s, [slot, c]) => s + slotOverall(c, slotPos(slot), env.data), 0);
const typeCount = (r: Roster) => {
  const m: Record<string, number> = {};
  for (const c of Object.values(r.starters)) m[c.types[0]!] = (m[c.types[0]!] ?? 0) + 1;
  return m;
};

for (let g = from; g < to; g++) {
  const pick = new Rng(`${seed}-match-${g}`);
  const i = pick.int(32);
  let j = pick.int(31); if (j >= i) j++;
  const home = env.roster(abbrs[i]!), away = env.roster(abbrs[j]!);
  const r = playGame({ data: env.data, ratings: env.ratings, teams: [home, away], seed: `${seed}-${g}` });
  add("games", 1);
  if (r.state.quarter > 4) add("ot", 1);
  for (const t of r.teams) {
    for (const [k, v] of Object.entries(t)) if (typeof v === "number") add(k, v);
    for (const [b, [m, n]] of Object.entries(t.fgByDist)) { const key = b === "<30" ? "lt30" : b; add(`fg_${key}_made`, m); add(`fg_${key}_att`, n); }
    scores.push(t.score);
  }
  const winner = r.state.score[0] > r.state.score[1] ? 0 : r.state.score[1] > r.state.score[0] ? 1 : -1;
  if (winner < 0) continue;
  const rs = [home, away];
  const ep = rs.map(epicPlus);
  if (ep[0] !== ep[1]) { byRarity.moreGames = (byRarity.moreGames ?? 0) + 1; if (ep[winner]! > ep[1 - winner]!) byRarity.moreWins = (byRarity.moreWins ?? 0) + 1; }
  const ov = rs.map(teamOvr);
  if (ov[0] !== ov[1]) { byRarity.gradeGames = (byRarity.gradeGames ?? 0) + 1; if (ov[winner]! > ov[1 - winner]!) byRarity.gradeWins = (byRarity.gradeWins ?? 0) + 1; }
  const tc = rs.map(typeCount);
  for (const t of env.data.types.types) {
    const d = (tc[0]![t.id] ?? 0) - (tc[1]![t.id] ?? 0);
    if (Math.abs(d) < 2) continue;
    const more = d > 0 ? 0 : 1;
    const e = (byType[t.id] ??= [0, 0]);
    e[1]++; if (more === winner) e[0]++;
  }
}
process.stdout.write(JSON.stringify({ agg, byRarity, byType, scores }));
