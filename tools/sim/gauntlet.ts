// Boss Gauntlet difficulty: how a typical drafted team (need-based AI drafts both sides) does against
// the League Bosses at each strength.   pnpm tsx tools/sim/gauntlet.ts [games per strength = 20]
import { Draft, bossRoster, playGame, teamGrade } from "@tdf/sim";
import { simEnv } from "./setup.js";
const env = await simEnv();
const N = Number(process.argv[2] ?? 20);
const teams = [];
for (let k = 0; k < 6; k++) {
  const d = new Draft(env.data, env.pool, [{ info: { abbr: "YOU", name: "You", nick: "You", c1: "#123", c2: "#fff", c3: "#000" }, ai: "need" }, { info: { abbr: "RIV", name: "Riv", nick: "Riv", c1: "#321", c2: "#fff", c3: "#000" }, ai: "need" }], `g${k}`, {});
  while (!d.done) { d.autoPick(0, "need"); d.autoPick(1, "need"); }
  teams.push(d.toRoster(0));
}
console.log("drafted team grades:", teams.map((t) => teamGrade(t.starters, env.data).overall.score.toFixed(1)).join(" "));
const bosses = env.data.bosses.bosses;
for (const s of [72, 76, 80, 84, 87]) {
  let w = 0, n = 0, bg = 0;
  for (let i = 0; i < N; i++) {
    const b = bosses[i % bosses.length]!, br = bossRoster(b, s, env.data, env.pool, `r${i}`);
    bg += teamGrade(br.starters, env.data).overall.score;
    const r = playGame({ data: env.data, ratings: env.ratings, teams: [teams[i % teams.length]!, br], seed: `gt${s}:${i}`, quarterSeconds: 180 });
    if (r.state.score[0] > r.state.score[1]) w++;
    n++;
  }
  console.log(`strength ${s}: boss grade ${(bg / n).toFixed(1)}, drafted team wins ${(100 * w / n).toFixed(0)}%`);
}
