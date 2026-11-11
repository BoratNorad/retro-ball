// Abilities in play (passives always on; one armed active per side per play, paid with momentum;
// signature moves for 88+ players). This module turns a player card into a lookup the play and
// kick engines query at their hook points: `mag(id)` = the ability's effect size at the player's
// tier (0 when he doesn't have it, or it's an active that wasn't armed), `once(id)` for one-shot
// actives ("the next juke ...").
import type { GameData, PlayerCard } from "@tdf/shared";

export const SIGNATURE = "signature";
/** An armed active for one side this play: which player, which ability (or "signature"). */
export interface ArmedActive { player: number; ability: string }
export interface PlayActives { O?: ArmedActive | null; D?: ArmedActive | null }

export interface AbilityKit {
  /** effect size if the player has the passive, or the armed active; else 0 */
  mag(id: string): number;
  /** a one-shot active: returns its size the first time, then 0 */
  once(id: string): number;
  /** the armed signature move's position group (QB, RB, WR, TE, OL, DL, LB, DB, ST), if armed */
  signature: string | null;
  /** rating boosts from the signature move (for the rest of the play) */
  boosts: Record<string, number>;
  /** the armed ability id, if this player has one armed */
  armed: string | null;
  /** names of abilities that fired (for the FX popups) */
  fired: string[];
}

const NONE: AbilityKit = { mag: () => 0, once: () => 0, signature: null, boosts: {}, armed: null, fired: [] };

/** Rating label in signature texts ("+6 Throw Power") -> rating key. */
function ratingKey(data: GameData, label: string): string | null {
  const want = label.toLowerCase().replace(/[^a-z]/g, "");
  for (const g of data.statGroups.groups) for (const { key } of g.stats) {
    if (key.toLowerCase() === want) return key;
  }
  const alias: Record<string, string> = { throwontherun: "throwOnTheRun", bcvision: "bCVision", catchintraffic: "catchInTraffic" };
  return alias[want] ?? null;
}

/** The signature-move group for a card (K/P -> ST, CB/S -> DB). */
export function signatureGroup(c: PlayerCard): string {
  return c.group === "K" || c.group === "P" ? "ST" : ["CB", "S", "DB"].includes(c.group) ? "DB" : c.group;
}

/** Build a player's ability kit. `armed` = the ability this player has armed for this play (if any). */
export function abilityKit(c: PlayerCard, data: GameData, armed: string | null, enabled = true): AbilityKit {
  if (!enabled) return NONE;
  const defs = new Map(data.abilities.abilities.map((a) => [a.id, a]));
  const have = new Map<string, number>();
  for (const a of c.abilities) {
    const d = defs.get(a.id);
    if (!d) continue;
    if (d.kind === "A" && a.id !== armed) continue;
    have.set(a.id, d.tiers[Math.max(0, Math.min(d.tiers.length - 1, a.tier - 1))] ?? 0);
  }
  const used = new Set<string>();
  const fired: string[] = [];
  let signature: string | null = null;
  const boosts: Record<string, number> = {};
  if (armed === SIGNATURE && c.signature) {
    signature = signatureGroup(c);
    for (const m of c.signature.text.matchAll(/\+(\d+) ([A-Z][A-Za-z ]+?)(?=,| and |\.|$)/g)) {
      const k = ratingKey(data, m[2]!.trim());
      if (k) boosts[k] = Number(m[1]);
    }
    fired.push(c.signature.name);
  }
  const name = (id: string) => defs.get(id)?.name ?? id;
  return {
    mag: (id) => have.get(id) ?? 0,
    once: (id) => {
      const v = have.get(id) ?? 0;
      if (!v || used.has(id)) return 0;
      used.add(id);
      fired.push(name(id));
      return v;
    },
    signature, boosts, armed, fired,
  };
}

/** Actives a player can arm (his active abilities, plus his signature move). Cost in bars. */
export interface ActiveOption { id: string; name: string; cost: number; text: string; role: string }
export function activesOf(c: PlayerCard, data: GameData): ActiveOption[] {
  const defs = new Map(data.abilities.abilities.map((a) => [a.id, a]));
  const out = c.abilities.filter((a) => defs.get(a.id)?.kind === "A").map((a) => {
    const d = defs.get(a.id)!;
    return { id: a.id, name: d.name, cost: d.cost, text: a.text, role: d.role };
  });
  if (c.signature) out.push({ id: SIGNATURE, name: c.signature.name, cost: data.abilities.signatures.cost, text: c.signature.text,
    role: data.abilities.signatures.byGroup[signatureGroup(c)]?.role ?? "" });
  return out;
}
