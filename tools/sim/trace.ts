// Debug: run one play with recording and print positions over time.
//   pnpm tsx tools/sim/trace.ts four_verts cover3 [seed]   (FORM=gun_trips FRONT=nickel PERS=11)
import { Rng, simulatePlay, Fx } from "@tdf/sim";
import { simEnv } from "./setup.js";

const [playId = "four_verts", callId = "cover3", seed = "1"] = process.argv.slice(2);
const env = await simEnv();
if (process.env.DEBUG_ROLE) (globalThis as { __TDF_DEBUG_ROLE?: string }).__TDF_DEBUG_ROLE = process.env.DEBUG_ROLE;
const play = env.data.offense.plays.find((p) => p.id === playId)!;
const call = env.data.defense.calls.find((c) => c.id === callId)!;
const r = simulatePlay({
  data: env.data, ratings: env.ratings, offense: env.roster("BUF"), defense: env.roster("KC"), offSide: 0,
  ballOn: Fx.fromInt(30), ballX: Fx.fx(26.67), toGo: Fx.fromInt(10), play, call, flip: false, rng: new Rng(seed), record: true,
  formation: process.env.FORM, front: process.env.FRONT, personnel: process.env.PERS,
});
const front = env.data.formations.defense.find((f) => f.id === (process.env.FRONT ?? "base43"))!;
const roles = [...["QB", "LT", "LG", "C", "RG", "RT", "X", "Y", "Z", "H", "RB"].map((r) => "O:" + r), ...Object.keys(front.roles).map((r) => "D:" + r)];
const f = (n: number) => (n / 65536).toFixed(1).padStart(5);
for (const fr of r.frames!) {
  if (fr.t % (Number(process.env.EVERY) || 6) !== 0) continue;
  const parts: string[] = [];
  const only = process.env.ROLES ? new RegExp(process.env.ROLES) : /O:[XYZH]|QB|RB|CB|FS|SS|LB|NB|E$/;
  roles.forEach((role, i) => { if (only.test(role)) parts.push(`${role.slice(2)}(${f(fr.p[2 * i]!)},${f(fr.p[2 * i + 1]!)})`); });
  console.log(`t=${(fr.t / 30).toFixed(1)} ball(${f(fr.ball[0])},${f(fr.ball[1])}${fr.ball[2] ? " air" : ""}) ` + parts.join(" "));
}
console.log(r.log.join("\n"));
console.log(JSON.stringify({ ...r.outcome, endY: r.outcome.endY / 65536 }));
