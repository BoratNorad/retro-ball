// Turn imported real players into draftable "creatures": overall at every game position,
// natural positions, types, rarity, body archetype, six base stats and abilities.
//
// This runs at BUILD time (tools/report/build_pool.ts) and its output, data/pool.json, is what
// the client, server and sim read. It uses ordinary float maths; determinism here only needs to
// hold for one machine producing one file, and the file's hash is checked in tests.
import type { AbilityDef, Creature, GameData, Player } from "@tdf/shared";
import { hashString } from "./rng.js";

type Stats = Record<string, number>;
const r = (s: Stats, k: string) => s[k] ?? 0;
const round = (n: number) => Math.round(n);
const clamp99 = (n: number) => Math.max(0, Math.min(99, n));

// ---------------------------------------------------------------- overall at a position
export function overallAt(stats: Stats, pos: string, data: GameData): number {
  const def = data.positionWeights.positions[pos];
  if (!def) throw new Error(`no weights for position ${pos}`);
  let s = 0;
  for (const [k, w] of Object.entries(def.weights)) s += w * r(stats, k);
  return round(clamp99(def.intercept + def.scale * s));
}

export function gamePositions(data: GameData): string[] {
  return data.positions.positions.map((p) => p.id);
}

/** Overall at every game position (+ KR role), and the natural positions (best ones, near the top). */
export function positionProfile(p: Player, data: GameData) {
  const at: Record<string, number> = {};
  for (const pos of [...gamePositions(data), "KR"]) at[pos] = overallAt(p.stats, pos, data);
  const home = data.positions.maddenToGame[p.pos] ?? p.pos;
  // a player's real position always counts as natural, with his real Madden overall there
  at[home] = p.ovr; // his real position always uses his real Madden overall
  const { max, withinPoints } = data.positions.naturalPositions;
  const ranked = gamePositions(data).filter((q) => q !== home).sort((a, b) => (at[b] ?? 0) - (at[a] ?? 0));
  const natural = [home];
  for (const q of ranked) {
    if (natural.length >= max) break;
    if ((at[q] ?? 0) >= (at[home] ?? 0) - withinPoints && groupOf(q, data) !== "ST") natural.push(q);
  }
  return { home, at, natural };
}

export function groupOf(pos: string, data: GameData): string {
  return data.positions.positions.find((p) => p.id === pos)?.group ?? "ST";
}

/** Points lost when a creature starts at `slot`. 0 at a natural position. */
export function outOfPositionPenalty(natural: readonly string[], slot: string, data: GameData): number {
  if (natural.includes(slot)) return 0;
  const cfg = data.positions.outOfPosition;
  const sg = groupOf(slot, data);
  const groups = natural.map((n) => groupOf(n, data));
  if (groups.includes(sg)) return cfg.sameGroup;
  const adj = data.positions.adjacentGroups.some(([a, b]) => groups.some((g) => (g === a && sg === b) || (g === b && sg === a)));
  return adj ? cfg.adjacentGroup : cfg.otherGroup;
}

/** Effective overall of a creature placed at a slot (overall there minus any out-of-position penalty). */
export function slotOverall(c: Pick<Creature, "overallAt" | "natural">, slot: string, data: GameData): number {
  return Math.max(0, (c.overallAt[slot] ?? 0) - outOfPositionPenalty(c.natural, slot, data));
}

// ---------------------------------------------------------------- per-position norms (z-scores)
type Norm = { mean: number; sd: number };
export class Norms {
  private cache = new Map<string, Norm>();
  constructor(private players: readonly Player[]) {}
  /** mean/sd of f(player) across everyone at the same Madden position */
  get(pos: string, key: string, f: (p: Player) => number): Norm {
    const k = pos + "|" + key;
    let n = this.cache.get(k);
    if (!n) {
      const xs = this.players.filter((p) => p.pos === pos).map(f);
      const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length));
      n = { mean, sd: Math.max(sd, 3) };
      this.cache.set(k, n);
    }
    return n;
  }
  z(p: Player, key: string, f: (p: Player) => number) {
    const n = this.get(p.pos, key, f);
    return (f(p) - n.mean) / n.sd;
  }
}
const weighted = (s: Stats, w: Record<string, number>) => {
  let a = 0, t = 0;
  for (const [k, v] of Object.entries(w)) { a += r(s, k) * v; t += v; }
  return a / t;
};

// ---------------------------------------------------------------- types
export function assignTypes(p: Player, data: GameData, norms: Norms): string[] {
  const group = data.positions.positions.find((q) => q.id === (data.positions.maddenToGame[p.pos] ?? p.pos))?.group ?? "ST";
  const scored = data.types.types
    .filter((t) => t.eligible.includes(group))
    .map((t) => ({ id: t.id, z: norms.z(p, "type:" + t.id, (q) => weighted(q.stats, t.traits)) + weighted(p.stats, t.traits) / 1000 }))
    .sort((a, b) => b.z - a.z);
  const out = [scored[0]?.id ?? "MIND"];
  const second = scored[1];
  if (second && second.z >= data.types.secondaryMinZ) out.push(second.id);
  return out;
}

/** Type advantage on a one-on-one: +modifier if the attacker has an edge, -modifier if the defender does, else 0. */
export function typeModifier(attacker: readonly string[], defender: readonly string[], data: GameData): number {
  const chart = typeChart(data);
  const edge = attacker.some((a) => defender.some((d) => chart.get(a)?.has(d)));
  const against = defender.some((d) => attacker.some((a) => chart.get(d)?.has(a)));
  return edge === against ? 0 : edge ? data.types.modifier : -data.types.modifier;
}

let chartCache: { data: GameData; chart: Map<string, Set<string>> } | null = null;
/** Ring chart: type i is strong vs i+1 and i+3 (mod n). Each type: 2 strengths, 2 weaknesses. */
export function typeChart(data: GameData): Map<string, Set<string>> {
  if (chartCache?.data === data) return chartCache.chart;
  const ids = data.types.types.map((t) => t.id);
  const n = ids.length;
  const chart = new Map<string, Set<string>>();
  ids.forEach((id, i) => chart.set(id, new Set([ids[(i + 1) % n] as string, ids[(i + 3) % n] as string])));
  chartCache = { data, chart };
  return chart;
}

// ---------------------------------------------------------------- rarity, body, base stats
export function rarityOf(ovr: number, data: GameData): string {
  const tiers = [...data.rarity.tiers].sort((a, b) => b.min - a.min);
  return (tiers.find((t) => ovr >= t.min) ?? tiers[tiers.length - 1])!.id;
}

export function bodyOf(htIn: number, wt: number, data: GameData): string {
  const bmi = (703 * wt) / (htIn * htIn);
  for (const rule of data.body.rules) {
    if (rule.minWt != null && wt < rule.minWt) continue;
    if (rule.maxWt != null && wt > rule.maxWt) continue;
    if (rule.minHt != null && htIn < rule.minHt) continue;
    if (rule.maxHt != null && htIn > rule.maxHt) continue;
    if (rule.minBmi != null && bmi < rule.minBmi) continue;
    if (rule.maxBmi != null && bmi > rule.maxBmi) continue;
    return rule.id;
  }
  return data.body.rules[data.body.rules.length - 1]!.id;
}

export function baseStats(stats: Stats, data: GameData): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, def] of Object.entries(data.baseStats.stats)) {
    const vals = def.ratings.map((k) => r(stats, k)).sort((a, b) => b - a).slice(0, def.top);
    out[id] = round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return out;
}

// ---------------------------------------------------------------- abilities (carried over from Gridiron Dex)
const tierOf = (s: number) => (s >= 89 ? 3 : s >= 78 ? 2 : 1);
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace(/\.0$/, ""));

export function assignAbilities(p: Player, data: GameData, norms: Norms, rarity: string) {
  const group = p.group;
  const pool = data.abilities.abilities
    .filter((a) => a.groups.includes(group) && (!a.positions || a.positions.includes(p.pos)))
    .map((a) => {
      const s = weighted(p.stats, a.weights);
      return { a, s, z: norms.z(p, "ab:" + a.id, (q) => weighted(q.stats, a.weights)) + s / 400 };
    })
    .sort((x, y) => y.z - x.z);
  const passives = pool.filter((x) => x.a.kind === "P");
  const actives = pool.filter((x) => x.a.kind === "A");
  const inst = (x: { a: AbilityDef; s: number }) => {
    const tier = tierOf(x.s);
    return { id: x.a.id, tier, text: x.a.desc.replace("{a}", fmt(x.a.tiers[tier - 1] as number)) };
  };
  const out = [] as { id: string; tier: number; text: string }[];
  if (passives[0]) out.push(inst(passives[0]));
  // Rare+ creatures also get a second passive (spec: "Rare+ creatures can have a second ability")
  const rank = (id: string) => data.rarity.tiers.findIndex((t) => t.id === id);
  if (passives[1] && rank(rarity) <= rank(data.rarity.secondAbilityMinTier) && passives[1].z > 0) out.push(inst(passives[1]));
  if (actives[0]) out.push(inst(actives[0]));
  if (actives[1] && p.ovr >= 72 && actives[1].s >= 70 && actives[1].z > 0) out.push(inst(actives[1]));
  return out;
}

export function signatureOf(p: Player, data: GameData) {
  const sig = data.abilities.signatures;
  const sg = sig.byGroup[p.group];
  if (!sg || p.ovr < sig.minOvr) return null;
  const relevant = new Set(data.abilities.abilities.filter((a) => a.groups.includes(p.group)).flatMap((a) => Object.keys(a.weights)));
  const best = Object.keys(p.stats).filter((k) => relevant.has(k) && !["stamina", "injury", "toughness"].includes(k))
    .sort((a, b) => r(p.stats, b) - r(p.stats, a)).slice(0, 2);
  const boost = 3 + Math.floor((p.ovr - sig.minOvr) / 3);
  const noun = sg.nouns[hashString(String(p.id)) % sg.nouns.length] as string;
  const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  return {
    name: `${p.last} ${noun}`,
    text: `Signature move. For the rest of the play: +${boost} ${label(best[0] ?? "awareness")}, +${boost} ${label(best[1] ?? "speed")}, and ${sg.special}.`,
  };
}

// ---------------------------------------------------------------- the pool
export function buildCreature(p: Player, data: GameData, norms: Norms): Creature {
  const { home, at, natural } = positionProfile(p, data);
  const rarity = rarityOf(p.ovr, data);
  return {
    id: p.id,
    name: `${p.first} ${p.last}`,
    team: p.team,
    num: p.num,
    maddenPos: p.pos,
    pos: home,
    group: groupOf(home, data),
    ovr: p.ovr,
    rarity,
    types: assignTypes(p, data, norms),
    body: bodyOf(p.htIn, p.wt, data),
    base: baseStats(p.stats, data),
    overallAt: at,
    natural,
    abilities: assignAbilities(p, data, norms, rarity),
    signature: signatureOf(p, data),
  };
}

export function buildPool(data: GameData): Creature[] {
  const norms = new Norms(data.players.players);
  return data.players.players.map((p) => buildCreature(p, data, norms));
}

/** Stable content hash of the pool (FNV over the JSON), checked by tests to catch accidental drift. */
export function poolHash(creatures: readonly Creature[]): string {
  return hashString(JSON.stringify(creatures)).toString(16).padStart(8, "0");
}
