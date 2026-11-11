// Individual dominance check: per-game sacks and tackles of the top players across random matchups.
//   pnpm tsx tools/sim/stars.ts [games=60]
import { playGame } from "@tdf/sim";
import { simEnv } from "./setup.js";
const env = await simEnv();
const N = Number(process.argv[2] ?? 60), teams = env.data.teams.teams.map((t) => t.abbr);
const sk = new Map<string, number>(), tk = new Map<string, number>(), gp = new Map<string, number>();
let teamSacks = 0, maxGameSacks = 0, maxGameTk = 0;
for (let i = 0; i < N; i++) {
  const a = teams[i % 32]!, b = teams[(i * 7 + 5) % 32]!;
  const r = playGame({ data: env.data, ratings: env.ratings, teams: [env.roster(a), env.roster(b)], seed: "st" + i });
  teamSacks += r.teams[0].sacks + r.teams[1].sacks;
  for (const p of r.players) {
    const s = (p.sacks as number) ?? 0, t = (p.tackles as number) ?? 0;
    sk.set(p.name, (sk.get(p.name) ?? 0) + s); tk.set(p.name, (tk.get(p.name) ?? 0) + t); gp.set(p.name, (gp.get(p.name) ?? 0) + 1);
    maxGameSacks = Math.max(maxGameSacks, s); maxGameTk = Math.max(maxGameTk, t);
  }
}
const top = (m: Map<string, number>) => [...m.entries()].map(([k, v]) => [k, v / (gp.get(k) ?? 1)] as const).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ");
console.log(`team sacks/game ${(teamSacks / N / 2).toFixed(2)} · most in one game: ${maxGameSacks} sacks, ${maxGameTk} tackles`);
console.log(`sacks per game played: ${top(sk)}`);
console.log(`tackles per game played: ${top(tk)}`);
