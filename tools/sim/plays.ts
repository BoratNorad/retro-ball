// Debug: every play (each formation) against AI-chosen fronts and calls, N reps: yards/play,
// success rate (>= 40% of 10 yards on 1st-and-10), explosive (20+), sacks, INTs, completion %.
//   pnpm tsx tools/sim/plays.ts 80   (ONLY=regex on play id, BY=formation for one row per formation)
import { Rng, simulatePlay, Fx, chooseDefense, newGame } from "@tdf/sim";
import { simEnv } from "./setup.js";
const n = Number(process.argv[2] ?? 60);
const env = await simEnv();
const teams = env.data.teams.teams.map((t) => t.abbr);
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const s0 = { ...newGame(env.data.rules, 0), phase: "play" as const, down: 1, toGo: Fx.fromInt(10), ballOn: Fx.fromInt(30) };
console.log("play".padEnd(30) + "  yds  succ  20+  comp  sack  int");
const rows: [string, number][] = [];
for (const play of env.data.offense.plays) {
  if (only && !only.test(play.id)) continue;
  const forms = process.env.BY === "formation" ? play.formations.map((f) => [f]) : [play.formations];
  for (const fl of forms) {
    let yds = 0, succ = 0, big = 0, att = 0, comp = 0, sack = 0, int = 0;
    for (let i = 0; i < n; i++) {
      const formation = fl[i % fl.length]!;
      const fo = env.data.formations.offense.find((f) => f.id === formation)!;
      const personnel = fo.personnel[i % fo.personnel.length]!;
      const rng = new Rng(`p${play.id}${formation}${i}`);
      const dc = chooseDefense(s0, env.data, rng, personnel);
      const r = simulatePlay({ data: env.data, ratings: env.ratings, offense: env.roster(teams[i % 32]!), defense: env.roster(teams[(i * 7 + 3) % 32]!),
        offSide: 0, ballOn: Fx.fromInt(30), ballX: Fx.fx(26.67), toGo: Fx.fromInt(10), play, formation, personnel, call: dc.call, front: dc.front, flip: i % 2 === 1, rng });
      const g = r.outcome.turnover ? -10 : r.outcome.incomplete ? 0 : (r.outcome.endY - Fx.fromInt(30)) / 65536;
      yds += g; if (g >= 4) succ++; if (g >= 20) big++;
      const L = r.log.join(" ");
      if (/throws \(|throws to/.test(L)) att++;
      if (L.includes("caught by")) comp++;
      if (L.includes("SACK")) sack++;
      if (L.includes("INTERCEPTED")) int++;
    }
    const name = (play.id + (fl.length === 1 ? ` @${fl[0]}` : "")).padEnd(30);
    const pc = (x: number) => `${Math.round(100 * x / n)}%`.padStart(5);
    rows.push([`${name}${(yds / n).toFixed(1).padStart(5)}${pc(succ)}${pc(big)}${att ? `${Math.round(100 * comp / att)}%`.padStart(6) : "     -"}${pc(sack)}${pc(int)}`, yds / n]);
  }
}
for (const [r] of rows) console.log(r);
