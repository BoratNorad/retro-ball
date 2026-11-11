// Dataset balance report (Milestone 1 "done when"): rebuilds pool.json, then for every draft slot
// counts creatures viable there (effective overall >= threshold) by rarity, and prints type, body,
// rarity and ability distributions. Exits non-zero if any slot lacks enough viable options.
import { slotOverall } from "@tdf/sim";
import { readShared, nodeGameData } from "./node-data.js";
import { main as buildPool } from "./build_pool.js";
import { PoolFileSchema, type PlayerCard } from "@tdf/shared";

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padR = (s: string | number, n: number) => String(s).padEnd(n);

function bar(n: number, max: number, width = 24) {
  return "█".repeat(Math.round((n / Math.max(1, max)) * width));
}

export async function report(): Promise<boolean> {
  await buildPool();
  const data = await nodeGameData();
  const pool = PoolFileSchema.parse(readShared("data/pool.json")).players as PlayerCard[];
  const tiers = data.tiers.tiers.map((t) => t.id);
  const v = data.draft.viability;
  const slots = [...new Set([...data.draft.quick.slots, "NT", "ILB", "FB", "KR"])];
  let ok = true;

  console.log(`\n=== VIABLE OPTIONS PER SLOT (effective overall >= ${v.minOverallAtSlot}) ===`);
  console.log(padR("slot", 5) + tiers.map((t) => pad(t, 8)).join("") + pad("total", 8) + pad("pb+", 7) + pad("best", 6) + "  natural-pos share");
  for (const slot of slots) {
    const viable = pool.filter((c) => slotOverall(c, slot, data) >= v.minOverallAtSlot);
    const byTier = tiers.map((t) => viable.filter((c) => c.tier === t).length);
    const epicPlus = viable.filter((c) => ["ELITE", "PRO_BOWL"].includes(c.tier)).length;
    const best = Math.max(0, ...pool.map((c) => slotOverall(c, slot, data)));
    const natural = viable.filter((c) => c.natural.includes(slot)).length;
    const isDraftSlot = data.draft.quick.slots.includes(slot);
    const fail = isDraftSlot && (viable.length < v.minViablePerSlot || epicPlus < v.minEpicPlusPerSlot);
    if (fail) ok = false;
    console.log(padR(slot, 5) + byTier.map((n) => pad(n, 8)).join("") + pad(viable.length, 8) + pad(epicPlus, 7) + pad(best, 6) +
      `  ${Math.round((natural / Math.max(1, viable.length)) * 100)}%` + (fail ? "   <-- NOT ENOUGH" : isDraftSlot ? "" : "   (not a quick-draft slot)"));
  }

  const count = <K extends string>(f: (c: PlayerCard) => K | K[]) => {
    const m = new Map<string, number>();
    for (const c of pool) for (const k of ([] as K[]).concat(f(c))) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const show = (title: string, rows: [string, number][]) => {
    console.log(`\n=== ${title} ===`);
    const max = Math.max(...rows.map((r) => r[1]));
    for (const [k, n] of rows) console.log(padR(k, 16) + pad(n, 5) + "  " + bar(n, max));
  };
  show("TALENT TIER", count((c) => c.tier));
  show("MADDEN ARCHETYPE (top 15)", count((c) => c.arch || "(none)").slice(0, 15));
  show("ABILITIES (top 15)", count((c) => c.abilities.map((a) => a.id)).slice(0, 15));
  console.log(`\nsignatures: ${pool.filter((c) => c.signature).length}  players: ${pool.length}`);

  console.log(ok ? "\nBALANCE CHECK: PASS" : "\nBALANCE CHECK: FAIL");
  return ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ok = await report();
  process.exit(ok ? 0 : 1);
}
