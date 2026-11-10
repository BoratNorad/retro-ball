// Q16.16 fixed-point maths. The play engine stores positions, velocities and angles as integers
// (value * 65536) and only uses +, -, integer division and shifts, so results are bit-identical
// in every JS engine. This is what makes seeded replays, server verification and rollback
// re-simulation exact. Trig uses integer CORDIC; sqrt is an exact integer square root.
//
// Range: keep |values| < 2^26 (~1e6 in real units). Field coordinates in yards (<= ~130) and
// speeds (yards/sec) are far inside that, so a*b never exceeds 2^53 and stays exact in a double.

export type Fx = number; // an integer: real value * 65536

export const FX_SHIFT = 16;
export const ONE: Fx = 1 << FX_SHIFT;           // 65536
export const HALF: Fx = ONE >> 1;
export const PI: Fx = 205887;
export const HALF_PI: Fx = 102944;
export const TWO_PI: Fx = 411775;

const LIMIT = 2 ** 53;

/** Real number -> Fx. Use for constants and config values (done once, at load). */
export const fx = (n: number): Fx => Math.round(n * ONE);
/** Fx -> real number, for rendering only. Never feed back into the sim. */
export const toFloat = (a: Fx): number => a / ONE;
/** Integer -> Fx. */
export const fromInt = (n: number): Fx => n * ONE;
/** Fx -> integer, rounding toward -infinity. */
export const floorInt = (a: Fx): number => Math.floor(a / ONE);

/** Exact floor division of two safe integers. */
export function idiv(n: number, d: number): number {
  if (d === 0) throw new RangeError("fixed: division by zero");
  const r = n % d;                      // exact for safe integers
  let q = (n - r) / d;                  // exact: n - r is a multiple of d
  if (r !== 0 && (r < 0) !== (d < 0)) q -= 1; // floor, not truncate
  return q;
}

export function mul(a: Fx, b: Fx): Fx {
  const p = a * b;
  if (p >= LIMIT || p <= -LIMIT) throw new RangeError("fixed: mul overflow");
  return Math.floor(p / ONE);           // dividing by a power of two is exact
}

export function div(a: Fx, b: Fx): Fx {
  return idiv(a * ONE, b);
}

/** Exact integer square root: largest r with r*r <= n (n >= 0, safe integer). */
export function isqrt(n: number): number {
  if (n < 0) throw new RangeError("isqrt of negative");
  if (n < 2) return n;
  let r = Math.floor(Math.sqrt(n));     // float guess, then corrected to the exact answer
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

export const sqrt = (a: Fx): Fx => isqrt(a * ONE);
export const abs = (a: Fx): Fx => (a < 0 ? -a : a);
export const min = (a: Fx, b: Fx): Fx => (a < b ? a : b);
export const max = (a: Fx, b: Fx): Fx => (a > b ? a : b);
export const clamp = (a: Fx, lo: Fx, hi: Fx): Fx => (a < lo ? lo : a > hi ? hi : a);
/** a + (b - a) * t, with t in Fx (0..ONE). */
export const lerp = (a: Fx, b: Fx, t: Fx): Fx => a + mul(b - a, t);

// ---------------------------------------------------------------- CORDIC trig
// atan(2^-i) in Q16 radians, and the CORDIC gain K = prod 1/sqrt(1+2^-2i) in Q16.
const ATAN = [51472, 30386, 16055, 8150, 4091, 2047, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2];
const K = 39797;
const ITER = 16;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: Fx): Fx {
  let r = a % TWO_PI;
  if (r <= -PI) r += TWO_PI;
  else if (r > PI) r -= TWO_PI;
  return r;
}

/** [cos, sin] of an angle in Q16 radians. Max error ~2e-4. */
export function cosSin(angle: Fx): [Fx, Fx] {
  let a = wrapAngle(angle);
  let flip = false;                     // CORDIC converges for |a| <= ~1.74 rad; fold the rest
  if (a > HALF_PI) { a -= PI; flip = true; } else if (a < -HALF_PI) { a += PI; flip = true; }
  let x = K, y = 0, z = a;
  for (let i = 0; i < ITER; i++) {
    const dx = x >> i, dy = y >> i;     // values stay < 2^31, so >> is a valid integer shift
    if (z >= 0) { x -= dy; y += dx; z -= ATAN[i] as number; }
    else { x += dy; y -= dx; z += ATAN[i] as number; }
  }
  return flip ? [-x, -y] : [x, y];
}
export const cos = (a: Fx): Fx => cosSin(a)[0];
export const sin = (a: Fx): Fx => cosSin(a)[1];

/** atan2(y, x) in Q16 radians, range (-PI, PI]. Inputs any Fx (scaled down internally). */
export function atan2(y: Fx, x: Fx): Fx {
  if (x === 0 && y === 0) return 0;
  // scale into a range where the CORDIC shifts are safe 32-bit operations
  while (abs(x) >= 1 << 28 || abs(y) >= 1 << 28) { x = idiv(x, 2); y = idiv(y, 2); }
  let offset = 0;
  if (x < 0) { offset = y >= 0 ? PI : -PI; x = -x; y = -y; }
  let z = 0;
  for (let i = 0; i < ITER; i++) {
    const dx = x >> i, dy = y >> i;
    if (y > 0) { x += dy; y -= dx; z += ATAN[i] as number; }
    else { x -= dy; y += dx; z -= ATAN[i] as number; }
  }
  return wrapAngle(z + offset);
}

// ---------------------------------------------------------------- 2D vectors
export interface V2 { x: Fx; y: Fx }
export const v2 = (x: Fx, y: Fx): V2 => ({ x, y });
export const vadd = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vsub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vscale = (a: V2, s: Fx): V2 => ({ x: mul(a.x, s), y: mul(a.y, s) });
export const vdot = (a: V2, b: V2): Fx => mul(a.x, b.x) + mul(a.y, b.y);
export const vlen = (a: V2): Fx => isqrt(a.x * a.x + a.y * a.y); // exact: sqrt(x^2+y^2) in Fx
export const vdist = (a: V2, b: V2): Fx => vlen(vsub(a, b));
/** Unit vector (length ONE) in the direction of a; zero vector stays zero. */
export function vnorm(a: V2): V2 {
  const l = vlen(a);
  return l === 0 ? { x: 0, y: 0 } : { x: div(a.x, l), y: div(a.y, l) };
}
export const vangle = (a: V2): Fx => atan2(a.y, a.x);
export function vfromAngle(angle: Fx, len: Fx = ONE): V2 {
  const [c, s] = cosSin(angle);
  return { x: mul(c, len), y: mul(s, len) };
}
