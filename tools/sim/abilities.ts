// Ability effect probe: for every active ability (and each group's signature move) find a real
// starter who has it, run the same seeded plays with it armed and unarmed, and print the average
// yards gained (from the armed player's side's point of view).
//   pnpm tsx tools/sim/abilities.ts            (all)     ONLY=battering_ram,sig:RB  N=70
import { Rng, simulatePlay, Fx, abilityKit, activesOf, SIGNATURE, type Roster } from "@tdf/sim";
import type { PlayerCard } from "@tdf/shared";
import { simEnv } from "./setup.js";

const env = await simEnv();
const { data } = env;
const teams = data.teams.teams.map((t) => t.abbr);
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const N = Number(process.env.N ?? 70);
const OFF_GROUPS = ["QB", "RB", "WR", "TE", "OL"];
const ids = [...data.abilities.abilities.filter((a) => a.kind === "A").map((a) => a.id),
  ...["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB"].map((g) => `sig:${g}`)];

for (const id of ids) {
  if (only.length && !only.includes(id)) continue;
  let found: { abbr: string; c: PlayerCard; side: "O" | "D" } | null = null;
  for (const abbr of teams) {
    for (const c of Object.values(env.roster(abbr).starters)) {
      const has = id.startsWith("sig:") ? Boolean(c.signature) && abilityKit(c, data, SIGNATURE).signature === id.slice(4) : activesOf(c, data).some((o) => o.id === id);
      if (has) { found = { abbr, c, side: OFF_GROUPS.includes(c.group) ? "O" : "D" }; break; }
    }
    if (found) break;
  }
  if (!found) { console.log(`${id.padEnd(14)} nobody has it`); continue; }
  const ab = id.startsWith("sig:") ? SIGNATURE : id;
  const role = activesOf(found.c, data).find((o) => o.id === ab)?.role ?? "";
  const plays = found.side === "O" && role === "rb" ? ["inside_zone", "outside_zone", "power"] : ["curl_flat", "slants", "four_verts", "inside_zone", "power"];
  const opp = found.abbr === "KC" ? "BUF" : "KC";
  const offense: Roster = env.roster(found.side === "O" ? found.abbr : opp), defense: Roster = env.roster(found.side === "D" ? found.abbr : opp);
  let a = 0, b = 0, n = 0, used = 0;
  for (let i = 0; i < N; i++) for (const p of plays) for (const call of ["cover1", "cover3", "cover2"]) {
    const run = (armed: boolean) => simulatePlay({
      data, ratings: env.ratings, offense, defense, offSide: 0, ballOn: Fx.fromInt(30), ballX: Fx.fx(26.67), toGo: Fx.fromInt(10),
      play: data.offense.plays.find((x) => x.id === p)!, call: data.defense.calls.find((x) => x.id === call)!, flip: false, rng: new Rng(`${i}${p}${call}`),
      actives: armed ? { [found!.side]: { player: found!.c.id, ability: ab } } : undefined,
    });
    const x = run(false), y = run(true);
    a += (x.outcome.endY - Fx.fromInt(30)) / 65536; b += (y.outcome.endY - Fx.fromInt(30)) / 65536; n++;
    if (y.activesUsed?.[found.side]) used++;
  }
  const d = (b - a) / n * (found.side === "O" ? 1 : -1);
  console.log(`${id.padEnd(14)} ${found.side} ${found.c.name.padEnd(22)} unarmed ${(a / n).toFixed(2)}  armed ${(b / n).toFixed(2)}  gain for his side ${d >= 0 ? "+" : ""}${d.toFixed(2)} yds/play  (on field ${used}/${n})`);
}
