// Calibrate the kicking physics: FG make % by distance, punt gross / hang, kickoff depth.
//   pnpm tsx tools/sim/kicks.ts
import { Fx, kickChance, predictFlight, aiKick, Rng } from "@tdf/sim";
import { simEnv } from "./setup.js";
const env = await simEnv();
const W = Fx.fx(env.data.tuning.field.width);
const calm = { x: 0, y: 0 };
const ks = env.data.teams.teams.map((t) => env.roster(t.abbr).starters.K!).map((k) => env.ratings(k.id));
const ps = env.data.teams.teams.map((t) => env.roster(t.abbr).starters.P!).map((k) => env.ratings(k.id));
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log("K power avg", avg(ks.map((k) => k.kickPower ?? 0)).toFixed(1), "acc", avg(ks.map((k) => k.kickAccuracy ?? 0)).toFixed(1));
for (const d of [20, 30, 35, 40, 45, 50, 55, 60]) {
  const ballOn = Fx.fx(110 + env.data.rules.spots.fgSnapDepth - d);
  const row = ks.map((k) => kickChance(env.data, k.kickPower ?? 70, k.kickAccuracy ?? 70, "fieldGoal", ballOn, calm, false));
  const windy = ks.slice(0, 8).map((k) => kickChance(env.data, k.kickPower ?? 70, k.kickAccuracy ?? 70, "fieldGoal", ballOn, { x: Fx.fx(15), y: Fx.fx(-10) }, false));
  console.log(`FG ${d}: ${(avg(row) / 10).toFixed(1)}%   min ${Math.min(...row) / 10} max ${Math.max(...row) / 10}   windy ${(avg(windy) / 10).toFixed(1)}%`);
}
console.log("PAT", (avg(ks.map((k) => kickChance(env.data, k.kickPower ?? 70, k.kickAccuracy ?? 70, "pat", Fx.fx(98), calm, false))) / 10).toFixed(1));
const rng = new Rng("k");
for (const [kind, list] of [["punt", ps], ["kickoff", ks], ["squib", ks], ["onside", ks]] as const) {
  const res = list.map((p) => { const c = aiKick(env.data, kind, p.kickPower ?? 70, { x: W / 2, y: Fx.fx(30) }, calm, rng); return predictFlight(env.data, kind, p.kickPower ?? 70, { x: W / 2, y: Fx.fx(30) }, c.aim, c.power, 0, calm); });
  console.log(`${kind}: air ${avg(res.map((r) => (r.land.y - Fx.fx(30)) / 65536)).toFixed(1)} yds  hang ${avg(res.map((r) => r.hang)).toFixed(2)} s`);
}
