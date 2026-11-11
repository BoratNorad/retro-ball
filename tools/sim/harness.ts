// Balance harness: run N AI-vs-AI games across CPU cores and compare to the targets in CLAUDE.md.
//   pnpm sim:harness                 # 1000 games
//   pnpm sim:harness --games 10000   # the full run from the spec
//   pnpm sim:harness --games 400 --seed tune1
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const arg = (k: string, d: string) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1]! : d; };
const GAMES = Number(arg("games", "1000"));
const SEED = arg("seed", "harness");
const WORKERS = Math.max(1, Math.min(cpus().length, Number(arg("workers", String(cpus().length)))));
const here = dirname(fileURLToPath(import.meta.url));

type Agg = Record<string, number>;
async function runWorkers(): Promise<{ agg: Agg; byRarity: Agg; byType: Record<string, [number, number]>; scores: number[]; ms: number }> {
  const t0 = Date.now();
  const per = Math.ceil(GAMES / WORKERS);
  const parts = await Promise.all(Array.from({ length: WORKERS }, (_, w) => new Promise<string>((res, rej) => {
    const from = w * per, to = Math.min(GAMES, from + per);
    const p = spawn(process.execPath, [...process.execArgv, join(here, "harness_worker.ts"), String(from), String(to), SEED], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? res(out) : rej(new Error(`worker ${w} exited ${code}`))));
  })));
  const agg: Agg = {}, byRarity: Agg = {}, byType: Record<string, [number, number]> = {};
  const scores: number[] = [];
  for (const raw of parts) {
    const r = JSON.parse(raw);
    for (const [k, v] of Object.entries(r.agg as Agg)) agg[k] = (agg[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.byRarity as Agg)) byRarity[k] = (byRarity[k] ?? 0) + v;
    for (const [k, [w, n]] of Object.entries(r.byType as Record<string, [number, number]>)) { const t = (byType[k] ??= [0, 0]); t[0] += w; t[1] += n; }
    scores.push(...r.scores);
  }
  return { agg, byRarity, byType, scores, ms: Date.now() - t0 };
}

const { agg: a, byRarity, byType, scores, ms } = await runWorkers();
const teamGames = a.games! * 2;
const per = (k: string) => (a[k] ?? 0) / teamGames;
const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);
const dropbacks = (a.passAtt ?? 0) + (a.sacksTaken ?? 0);
const fg = (b: string) => pct(a[`fg_${b}_made`] ?? 0, a[`fg_${b}_att`] ?? 0);

type Row = [string, number, number | null, number | null, string?];
const rows: Row[] = [
  ["points / team / game", per("score"), 20, 31],
  ["offensive plays / team", per("plays"), 55, 75],
  ["pass share of plays %", pct(dropbacks, dropbacks + (a.rushAtt ?? 0)), 50, 66],
  ["completion %", pct(a.passComp ?? 0, a.passAtt ?? 0), 60, 70],
  ["yards / pass attempt", (a.passYds ?? 0) / Math.max(1, a.passAtt ?? 0), 6.0, 8.0],
  ["yards / rush", (a.rushYds ?? 0) / Math.max(1, a.rushAtt ?? 0), 3.8, 5.0],
  ["sack rate % of dropbacks", pct(a.sacksTaken ?? 0, dropbacks), 5, 9],
  ["turnovers / team / game", per("turnovers"), 1.0, 2.0],
  ["interceptions / team", per("ints"), 0.5, 1.2],
  ["penalties / team / game", per("penalties"), 4, 8],
  ["3rd-down conversion %", pct(a.thirdConv ?? 0, a.thirdAtt ?? 0), 35, 45],
  ["punts / team / game", per("punts"), 3, 6],
  ["FG % <40 yds", pct((a.fg_lt30_made ?? 0) + (a["fg_30-39_made"] ?? 0), (a.fg_lt30_att ?? 0) + (a["fg_30-39_att"] ?? 0)), 85, 100],
  ["FG % 40-49", fg("40-49"), 70, 90],
  ["FG % 50+", fg("50+"), 55, 75],
  ["FG attempts / team", per("fgAtt"), 1.2, 2.5],
  ["overtime games %", pct(a.ot ?? 0, a.games ?? 0), 3, 9],
  ["total yards / team", per("totalYds"), 300, 400],
];
console.log(`\n${a.games} games in ${(ms / 1000).toFixed(1)}s on ${WORKERS} workers (${(ms / a.games!).toFixed(0)} ms/game per core x${WORKERS})\n`);
let out = 0;
for (const [label, v, lo, hi] of rows) {
  const bad = (lo != null && v < lo) || (hi != null && v > hi);
  if (bad) out++;
  console.log(`${label.padEnd(28)} ${v.toFixed(1).padStart(7)}   target ${lo ?? "-"}–${hi ?? "-"}  ${bad ? "<-- OUT" : "ok"}`);
}
scores.sort((x, y) => x - y);
console.log(`\nscore spread: p10 ${scores[Math.floor(scores.length * 0.1)]}  median ${scores[Math.floor(scores.length / 2)]}  p90 ${scores[Math.floor(scores.length * 0.9)]}  max ${scores[scores.length - 1]}`);
console.log(`\nwin % by rarity edge (team with more Epic+ starters): ${pct(byRarity.moreWins ?? 0, byRarity.moreGames ?? 0).toFixed(1)}% of ${byRarity.moreGames ?? 0} games`);
console.log(`win % by starters' grade edge (higher team OVR wins):    ${pct(byRarity.gradeWins ?? 0, byRarity.gradeGames ?? 0).toFixed(1)}%`);
console.log("\nwin % when a team has 2+ more starters of a type than its opponent:");
for (const [t, [w, n]] of Object.entries(byType).sort()) console.log(`  ${t.padEnd(7)} ${pct(w, n).toFixed(1).padStart(5)}%  (${n} games)`);
console.log("\nper play call (all downs, in games):");
const names = [...new Set(Object.keys(a).filter((k) => k.startsWith("play:")).map((k) => k.split(":")[1]!))];
for (const nm of names.sort((x, y) => (a[`play:${y}:n`] ?? 0) - (a[`play:${x}:n`] ?? 0)))
  console.log(`  ${nm.padEnd(16)} ${String(a[`play:${nm}:n`]).padStart(6)} calls  ${((a[`play:${nm}:yds`] ?? 0) / (a[`play:${nm}:n`] ?? 1)).toFixed(1).padStart(5)} yds/play`);
console.log(`\n${out} metric(s) outside target`);
