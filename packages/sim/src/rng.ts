// Seeded PRNG: xoshiro128** seeded via splitmix32. Integer-only (Math.imul, >>>), so every
// JS engine produces the identical sequence — required for replays, rollback and server checks.
// State is four uint32s and can be snapshotted/restored (rollback netcode re-simulates from it).

export type RngState = readonly [number, number, number, number];

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** FNV-1a 32-bit hash of a string, for human-friendly seeds ("daily-2026-11-10"). */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Rng {
  private s0: number; private s1: number; private s2: number; private s3: number;

  constructor(seed: number | string | RngState) {
    if (Array.isArray(seed)) {
      [this.s0, this.s1, this.s2, this.s3] = seed as RngState;
    } else {
      const sm = splitmix32(typeof seed === "string" ? hashString(seed) : (seed as number));
      this.s0 = sm(); this.s1 = sm(); this.s2 = sm(); this.s3 = sm();
      if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1; // all-zero state is invalid
    }
  }

  /** Next uint32. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0; this.s3 ^= this.s1; this.s1 ^= this.s2; this.s0 ^= this.s3;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0; this.s1 >>>= 0;
    return result;
  }

  /** Uniform integer in [0, n) with no modulo bias. n must be in (0, 2^32]. */
  int(n: number): number {
    if (!(n > 0) || n > 0x100000000 || !Number.isInteger(n)) throw new RangeError(`Rng.int: bad n ${n}`);
    const limit = 0x100000000 - (0x100000000 % n);
    let x: number;
    do x = this.nextU32(); while (x >= limit);
    return x % n;
  }

  /** Integer in [lo, hi] inclusive. */
  range(lo: number, hi: number): number { return lo + this.int(hi - lo + 1); }

  /** True with probability num/den, decided with integers only. */
  chance(num: number, den: number): boolean { return this.int(den) < num; }

  /** Float in [0, 1). Fine for presentation; sim logic should prefer int/chance. */
  float(): number { return this.nextU32() / 0x100000000; }

  pick<T>(arr: readonly T[]): T {
    if (!arr.length) throw new RangeError("Rng.pick: empty array");
    return arr[this.int(arr.length)] as T;
  }

  /** Index chosen with integer weights (>= 0). */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) { if (w < 0 || !Number.isInteger(w)) throw new RangeError("weights must be non-negative integers"); total += w; }
    if (total <= 0) throw new RangeError("Rng.weighted: zero total");
    let r = this.int(total);
    for (let i = 0; i < weights.length; i++) { r -= weights[i] as number; if (r < 0) return i; }
    return weights.length - 1;
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
    }
    return arr;
  }

  /** Independent child stream (e.g. one per draft round) without disturbing this one's sequence semantics. */
  fork(label: string): Rng { return new Rng((this.nextU32() ^ hashString(label)) >>> 0); }

  getState(): RngState { return [this.s0, this.s1, this.s2, this.s3]; }
  setState(s: RngState): void { [this.s0, this.s1, this.s2, this.s3] = s; }
}
