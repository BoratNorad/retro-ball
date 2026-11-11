// Camera projections (M9). Everything the renderer draws goes through a View: user-frame yards
// (x across the field 0..53.3, y along it, your team attacking toward +y) -> screen pixels, plus the
// inverse for touch input. Bowl = top-down, you attack up the screen. Pro = the All-22 broadcast view
// from the near sideline, you attack to the right, the far sideline smaller (a simple perspective).
import type { GameData } from "@tdf/shared";

export const FIELD_W = 53.333;
export const MARGIN = 3; // yards of sideline area

export interface ScreenPt { x: number; y: number; /** pixels per yard here */ s: number }
export interface View {
  readonly kind: "bowl" | "pro";
  /** pixels per yard at the middle of the field (sizes of lines, text) */
  readonly S: number;
  /** vertical squash of field distances (1 top-down) */
  readonly squash: number;
  /** user-frame yards (+ height in yards) -> screen */
  p(x: number, y: number, h?: number): ScreenPt;
  /** screen -> user-frame yards (on the ground) */
  inv(px: number, py: number): { x: number; y: number };
  /** the screen direction of "downfield" (toward +y) for kick flicks */
  readonly fwd: { x: number; y: number };
  /** ease the camera toward a focus point (user-frame yards) */
  follow(fx: number, fy: number, opts: { attackingUp: boolean; zoom: boolean }): void;
  /** snap the camera (no easing), e.g. after a camera switch */
  jump(fx: number, fy: number, attackingUp: boolean): void;
}

export class BowlView implements View {
  readonly kind = "bowl" as const;
  S = 8;
  readonly squash = 1;
  readonly fwd = { x: 0, y: -1 };
  private camY = 50;
  constructor(private w: number, private h: number, private cfg: GameData["presentation"]) { this.resize(w, h); }
  resize(w: number, h: number) { this.w = w; this.h = h; this.S = Math.max(5, w / (FIELD_W + MARGIN * 2)); }
  private anchor = 0.62;
  p(x: number, y: number, hgt = 0): ScreenPt {
    return { x: (x + MARGIN) * this.S, y: (this.camY - y) * this.S + this.h * this.anchor - hgt * this.S * 0.45, s: this.S };
  }
  inv(px: number, py: number) { return { x: px / this.S - MARGIN, y: this.camY - (py - this.h * this.anchor) / this.S }; }
  follow(_fx: number, fy: number, o: { attackingUp: boolean }) {
    const a = o.attackingUp ? this.cfg.bowl.anchorUp : this.cfg.bowl.anchorDown;
    this.anchor += (a - this.anchor) * this.cfg.bowl.follow;
    this.camY += (fy - this.camY) * this.cfg.bowl.follow;
  }
  jump(_fx: number, fy: number, up: boolean) { this.camY = fy; this.anchor = up ? this.cfg.bowl.anchorUp : this.cfg.bowl.anchorDown; }
}

/**
 * Sideline perspective: depth t = 0 at the far sideline (x = 0, your left when you attack) .. 1 at the
 * near one. Scale k(t) = S0 * z * (far + (1 - far) t); screen y integrates k * tilt over the depth, so
 * yard lines converge toward the far side and the inverse is a quadratic.
 */
export class ProView implements View {
  readonly kind = "pro" as const;
  S = 10;
  readonly fwd = { x: 1, y: 0 };
  private S0 = 10;
  private camA = 50;
  private camT = 0.5;
  private zoom = 1;
  constructor(private w: number, private h: number, private cfg: GameData["presentation"]) { this.resize(w, h); }
  get squash() { return this.cfg.pro.tilt; }
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    const P = this.cfg.pro;
    const depthPx = FIELD_W * P.tilt * (P.farScale + (1 - P.farScale) / 2);
    // fit the width (visible yards) but keep the whole field depth on a short screen
    this.S0 = Math.min(w / P.visibleYards, (h * 0.82) / depthPx);
    this.S = this.S0 * this.zoom * (P.farScale + 1) / 2;
  }
  private k(t: number) { const P = this.cfg.pro; return this.S0 * this.zoom * (P.farScale + (1 - P.farScale) * t); }
  /** screen y of depth t, before the vertical camera offset */
  private yOf(t: number) {
    const P = this.cfg.pro, f = P.farScale;
    return FIELD_W * P.tilt * this.S0 * this.zoom * (f * t + (1 - f) * t * t / 2);
  }
  /** the field's focus sits a little above the middle: the call sheets cover the bottom of the screen */
  private top() { return this.h * this.cfg.pro.centerY - this.yOf(this.camT); }
  p(x: number, y: number, hgt = 0): ScreenPt {
    const t = x / FIELD_W, k = this.k(t);
    return { x: this.w / 2 + (y - this.camA) * k, y: this.top() + this.yOf(t) - hgt * k * this.cfg.pro.heightLift, s: k };
  }
  inv(px: number, py: number) {
    const P = this.cfg.pro, f = P.farScale;
    const v = (py - this.top()) / (FIELD_W * P.tilt * this.S0 * this.zoom);
    const A = (1 - f) / 2, B = f;
    const t = A > 1e-6 ? (-B + Math.sqrt(Math.max(0, B * B + 4 * A * v))) / (2 * A) : v / B;
    return { x: t * FIELD_W, y: this.camA + (px - this.w / 2) / this.k(t) };
  }
  follow(fx: number, fy: number, o: { zoom: boolean }) {
    const P = this.cfg.pro;
    const z = o.zoom ? P.carrierZoom : 1;
    this.zoom += (z - this.zoom) * P.zoomEase;
    this.S = this.S0 * this.zoom * (P.farScale + 1) / 2;
    this.camA += (fy - this.camA) * P.follow;
    // zoomed in: follow the carrier across the field too; otherwise keep the whole width in view
    const tGoal = this.zoom > 1.02 ? Math.max(0, Math.min(1, fx / FIELD_W)) : 0.5;
    this.camT += (tGoal - this.camT) * P.follow;
  }
  jump(_fx: number, fy: number) { this.camA = fy; this.camT = 0.5; this.zoom = 1; }
}
