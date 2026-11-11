// Debug: run one play type many times and summarise outcomes.
//   pnpm tsx tools/sim/probe.ts inside_zone cover3 200   (FORM=... FRONT=nickel PERS=11)
import { Rng, simulatePlay, Fx } from "@tdf/sim";
import { simEnv } from "./setup.js";
const [playId = "inside_zone", callId = "cover3", nS = "200"] = process.argv.slice(2);
const env = await simEnv();
const play = env.data.offense.plays.find((p) => p.id === playId)!;
const call = env.data.defense.calls.find((c) => c.id === callId)!;
const teams = env.data.teams.teams.map((t) => t.abbr);
const n = Number(nS);
const c: Record<string, number> = {};
const inc = (k: string, v = 1) => (c[k] = (c[k] ?? 0) + v);
const gains: number[] = [];
for (let i = 0; i < n; i++) {
  const rng = new Rng("probe" + i);
  const o = env.roster(teams[i % 32]!), d = env.roster(teams[(i * 7 + 3) % 32]!);
  const r = simulatePlay({ data: env.data, ratings: env.ratings, offense: o, defense: d, offSide: 0, ballOn: Fx.fromInt(30), ballX: Fx.fx(26.67), toGo: Fx.fromInt(10), play, call, flip: i % 2 === 1, rng, formation: process.env.FORM, front: process.env.FRONT, personnel: process.env.PERS });
  const g = r.outcome.incomplete ? 0 : (r.outcome.endY - Fx.fromInt(30)) / 65536;
  gains.push(g); inc("yds", g);
  const L = r.log.join(" | ");
  const air = /\((-?\d+) air yds/.exec(L);
  if (L.includes("throws it away")) inc("throwAway");
  else if (air) { inc("throws"); inc("airYds", Number(air[1])); }
  if (L.includes("caught by")) { inc("comp"); inc("yac", g - Number(air?.[1] ?? 0)); }
  if (L.includes("SACK")) inc("sack");
  if (L.includes("scrambles")) inc("scramble");
  if (L.includes("INTERCEPTED")) inc("int");
  if (r.outcome.incomplete && !L.includes("throws it away")) inc("incomplete");
  inc("secs", r.outcome.elapsedTicks / 30);
  inc("tries", r.debug!.tries); inc("missed", r.debug!.missed);
}
gains.sort((a, b) => a - b);
const f = (x: number) => x.toFixed(1);
const k = (x: string) => c[x] ?? 0;
console.log(`${playId} vs ${callId} (${n}): ${f(k("yds") / n)} yds/play  median ${f(gains[n >> 1]!)}  20+ ${gains.filter((g) => g >= 20).length}  play ${f(k("secs") / n)}s`);
if (play.kind !== "run") console.log(`  comp ${k("comp")}/${k("throws")} (${f(100 * k("comp") / Math.max(1, k("throws")))}%)  air ${f(k("airYds") / Math.max(1, k("throws")))}  yac ${f(k("yac") / Math.max(1, k("comp")))}  inc ${k("incomplete")}  away ${k("throwAway")}  int ${k("int")}  sack ${k("sack")}  scramble ${k("scramble")}`);
console.log(`  tackle tries/play ${f(k("tries") / n)}  missed ${f(100 * k("missed") / Math.max(1, k("tries")))}%`);
