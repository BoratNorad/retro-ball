import { describe, expect, it } from "vitest";
import { hashString, Rng } from "../src/rng.js";

describe("Rng (xoshiro128**)", () => {
  it("matches the reference xoshiro128** output for state [1,2,3,4]", () => {
    const r = new Rng([1, 2, 3, 4]);
    // reference values from the published C implementation
    expect([r.nextU32(), r.nextU32(), r.nextU32(), r.nextU32()]).toEqual([11520, 0, 5927040, 70819200]);
  });

  it("is deterministic for a seed and differs across seeds", () => {
    const seq = (s: string) => { const r = new Rng(s); return Array.from({ length: 20 }, () => r.nextU32()); };
    expect(seq("daily-2026-11-10")).toEqual(seq("daily-2026-11-10"));
    expect(seq("a")).not.toEqual(seq("b"));
  });

  it("snapshots and restores state exactly (needed for rollback)", () => {
    const r = new Rng(42);
    for (let i = 0; i < 100; i++) r.nextU32();
    const snap = r.getState();
    const a = Array.from({ length: 50 }, () => r.int(1000));
    r.setState(snap);
    const b = Array.from({ length: 50 }, () => r.int(1000));
    expect(b).toEqual(a);
    expect(new Rng(snap).int(1000)).toBe(a[0]);
  });

  it("int(n) is unbiased enough and in range", () => {
    const r = new Rng(7);
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 100_000; i++) { const k = r.int(10); counts[k] = (counts[k] ?? 0) + 1; }
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
    expect(() => r.int(0)).toThrow();
  });

  it("weighted, chance, shuffle and fork behave", () => {
    const r = new Rng("w");
    const hits = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) { const k = r.weighted([1, 2, 7]); hits[k] = (hits[k] ?? 0) + 1; }
    expect(hits[2]! / 30_000).toBeGreaterThan(0.67);
    expect(hits[2]! / 30_000).toBeLessThan(0.73);
    let yes = 0;
    for (let i = 0; i < 10_000; i++) if (r.chance(1, 4)) yes++;
    expect(Math.abs(yes - 2500)).toBeLessThan(200);
    const arr = Array.from({ length: 20 }, (_, i) => i);
    expect(new Rng(1).shuffle([...arr])).toEqual(new Rng(1).shuffle([...arr]));
    expect([...new Rng(1).shuffle([...arr])].sort((a, b) => a - b)).toEqual(arr);
    expect(new Rng(5).fork("round-1").nextU32()).toBe(new Rng(5).fork("round-1").nextU32());
  });

  it("hashString is stable (FNV-1a)", () => {
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
  });
});
