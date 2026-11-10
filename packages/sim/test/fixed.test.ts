import { describe, expect, it } from "vitest";
import * as F from "../src/fixed.js";

const near = (a: number, b: number, eps: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("Q16.16 fixed point", () => {
  it("mul / div / idiv are exact integer ops", () => {
    expect(F.mul(F.fx(1.5), F.fx(2))).toBe(F.fx(3));
    expect(F.mul(F.fx(-1.5), F.fx(2))).toBe(F.fx(-3));
    expect(F.div(F.fx(3), F.fx(2))).toBe(F.fx(1.5));
    expect(F.idiv(7, 2)).toBe(3);
    expect(F.idiv(-7, 2)).toBe(-4);
    expect(F.idiv(7, -2)).toBe(-4);
    expect(() => F.div(1, 0)).toThrow();
    for (const [a, b] of [[123.25, 0.5], [-87.1, 3.3], [100, 100]] as const) near(F.toFloat(F.mul(F.fx(a), F.fx(b))), a * b, 1e-3);
  });

  it("isqrt is exact", () => {
    for (let n = 0; n < 5000; n++) {
      const r = F.isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true);
    }
    expect(F.isqrt(2 ** 52)).toBe(2 ** 26);
    near(F.toFloat(F.sqrt(F.fx(2))), Math.SQRT2, 1e-4);
  });

  it("CORDIC sin/cos/atan2 are accurate to ~2e-4", () => {
    for (let deg = -720; deg <= 720; deg += 7) {
      const a = (deg * Math.PI) / 180;
      const [c, s] = F.cosSin(F.fx(a));
      near(F.toFloat(c), Math.cos(a), 3e-4);
      near(F.toFloat(s), Math.sin(a), 3e-4);
    }
    for (let deg = -179; deg <= 180; deg += 11) {
      const a = (deg * Math.PI) / 180;
      const got = F.toFloat(F.atan2(F.fx(Math.sin(a) * 37), F.fx(Math.cos(a) * 37)));
      near(Math.abs(got - a) > Math.PI ? 2 * Math.PI - Math.abs(got - a) : Math.abs(got - a), 0, 3e-4);
    }
    expect(F.atan2(0, 0)).toBe(0);
  });

  it("vector helpers", () => {
    const v = F.v2(F.fx(3), F.fx(4));
    expect(F.vlen(v)).toBe(F.fx(5));
    near(F.toFloat(F.vlen(F.vnorm(v))), 1, 1e-4);
    const u = F.vfromAngle(F.HALF_PI, F.fx(10));
    near(F.toFloat(u.x), 0, 3e-3);
    near(F.toFloat(u.y), 10, 3e-3);
  });

  it("results are pure integers (no float leaks)", () => {
    const xs = [F.mul(12345, 67891), F.div(F.fx(1), F.fx(3)), F.sin(F.fx(1)), F.atan2(F.fx(1), F.fx(2)), F.sqrt(F.fx(7))];
    for (const x of xs) expect(Number.isInteger(x)).toBe(true);
  });
});
