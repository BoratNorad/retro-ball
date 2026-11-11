// Debug: yards per attempt for every pass play x defensive call (N reps each).
import { Rng, simulatePlay, Fx } from "@tdf/sim";
import { simEnv } from "./setup.js";
const n = Number(process.argv[2] ?? 60);
const env = await simEnv();
const teams = env.data.teams.teams.map((t) => t.abbr);
const plays = env.data.offense.plays.filter((p) => p.kind === (process.env.KIND ?? "pass"));
const calls = env.data.defense.calls;
console.log("ypa (comp%)".padEnd(12) + calls.map((c) => c.id.padStart(13)).join(""));
for (const play of plays) {
  let row = play.id.padEnd(12);
  for (const call of calls) {
    let yds = 0, comp = 0, att = 0;
    for (let i = 0; i < n; i++) {
      const r = simulatePlay({ data: env.data, ratings: env.ratings, offense: env.roster(teams[i % 32]!), defense: env.roster(teams[(i * 7 + 3) % 32]!),
        offSide: 0, ballOn: Fx.fromInt(30), ballX: Fx.fx(26.67), toGo: Fx.fromInt(10), play, call, flip: i % 2 === 1, rng: new Rng(`m${play.id}${call.id}${i}`) });
      yds += r.outcome.incomplete ? 0 : (r.outcome.endY - Fx.fromInt(30)) / 65536;
      const L = r.log.join(" ");
      if (L.includes("throws")) att++;
      if (L.includes("caught by")) comp++;
    }
    row += `${(yds / n).toFixed(1).padStart(6)} (${String(Math.round(100 * comp / Math.max(1, att))).padStart(3)}%)`;
  }
  console.log(row);
}
