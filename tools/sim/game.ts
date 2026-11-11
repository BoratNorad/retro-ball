// Play one AI-vs-AI game in the terminal and print the box score.
//   pnpm sim:game                 # BUF vs KC, random seed
//   pnpm sim:game PHI DAL 1234    # teams + seed
//   pnpm sim:game PHI DAL 1234 --pbp   # with play-by-play
import { playGame, type GameResult } from "@tdf/sim";
import { simEnv } from "./setup.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const pbp = process.argv.includes("--pbp");
const [home = "BUF", away = "KC", seedArg] = args;
const seed = seedArg ?? String(Date.now() % 1_000_000);

const env = await simEnv();
const res = playGame({ data: env.data, ratings: env.ratings, teams: [env.roster(home), env.roster(away)], seed });
printGame(res, pbp, env.data.rules.tickHz);

export function printGame(r: GameResult, withPbp: boolean, hz: number) {
  const [a, b] = r.names;
  const clock = (t: number) => { const s = Math.ceil(t / hz); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  if (withPbp) {
    for (const p of r.log) {
      const q = p.q > 4 ? `OT${p.q - 4}` : `Q${p.q}`;
      const dd = p.kind === "play" ? `${p.down}&${p.toGo} @${p.ballOn}` : p.kind;
      console.log(`${q} ${clock(p.clock).padStart(5)} ${r.names[p.off]} ${dd.padEnd(10)} ${p.name.padEnd(18)} ${(p.defense ?? "").padEnd(16)} ${p.result}`);
    }
  }
  const q = Math.max(r.teams[0].byQuarter.length, r.teams[1].byQuarter.length, 4);
  console.log(`\n${"".padEnd(6)}${Array.from({ length: q }, (_, i) => (i < 4 ? `Q${i + 1}` : `OT`).padStart(4)).join("")}   F`);
  for (const [i, name] of [a, b].entries()) {
    const t = r.teams[i as 0 | 1];
    console.log(`${name.padEnd(6)}${Array.from({ length: q }, (_, j) => String(t.byQuarter[j] ?? 0).padStart(4)).join("")}  ${String(t.score).padStart(2)}`);
  }
  const rows: [string, (t: GameResult["teams"][0]) => string][] = [
    ["First downs", (t) => `${t.firstDowns}`],
    ["Total yards", (t) => `${t.totalYds}`],
    ["Passing", (t) => `${t.passComp}/${t.passAtt}, ${t.passYds - t.sackYds} yds, ${t.passTd} TD, ${t.ints} INT`],
    ["Sacked", (t) => `${t.sacksTaken}-${t.sackYds}`],
    ["Rushing", (t) => `${t.rushAtt}-${t.rushYds}, ${t.rushTd} TD`],
    ["Turnovers", (t) => `${t.turnovers}`],
    ["Penalties", (t) => `${t.penalties}-${t.penaltyYds}`],
    ["3rd down", (t) => `${t.thirdConv}/${t.thirdAtt}`],
    ["4th down", (t) => `${t.fourthConv}/${t.fourthAtt}`],
    ["Field goals", (t) => `${t.fgMade}/${t.fgAtt}`],
    ["Punts", (t) => `${t.punts}, ${t.punts ? (t.puntYds / t.punts).toFixed(1) : 0} avg`],
    ["Possession", (t) => clock(t.topTicks)],
    ["Plays", (t) => `${t.plays}`],
  ];
  console.log("");
  console.log("".padEnd(14) + a.padEnd(34) + b);
  for (const [label, f] of rows) console.log(label.padEnd(14) + f(r.teams[0]).padEnd(34) + f(r.teams[1]));
  const top = (k: string, n: number) => r.players.filter((p) => ((p[k] as number) ?? 0) !== 0).sort((x, y) => ((y[k] as number) ?? 0) - ((x[k] as number) ?? 0)).slice(0, n);
  console.log("\nPASSING");
  for (const p of top("passAtt", 4)) console.log(`  ${r.names[p.team]} ${String(p.name).padEnd(22)} ${p.passComp ?? 0}/${p.passAtt} ${p.passYds ?? 0} yds ${p.passTd ?? 0} TD`);
  console.log("RUSHING");
  for (const p of top("rushYds", 4)) console.log(`  ${r.names[p.team]} ${String(p.name).padEnd(22)} ${p.rushAtt ?? 0}-${p.rushYds} ${p.rushTd ?? 0} TD`);
  console.log("RECEIVING");
  for (const p of top("recYds", 5)) console.log(`  ${r.names[p.team]} ${String(p.name).padEnd(22)} ${p.rec ?? 0} rec ${p.recYds} yds ${p.recTd ?? 0} TD (${p.targets ?? 0} tgt)`);
  console.log("DEFENSE");
  for (const p of top("tackles", 4)) console.log(`  ${r.names[p.team]} ${String(p.name).padEnd(22)} ${p.tackles} tkl ${p.sacks ?? 0} sk ${p.defInts ?? 0} int`);
  console.log(`\nseed ${r.seed}  hash ${r.hash}  ${r.log.length} snaps`);
}
