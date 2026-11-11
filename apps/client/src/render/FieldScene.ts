// Top-down "Bowl" camera: field, players, ball, lines, throw guide and touch/mouse input.
// The player's team always attacks up the screen; when the AI has the ball it drives down.
import Phaser from "phaser";
import type { ActorView, PlaySnapshot } from "@tdf/sim";
import type { Controller } from "../game/controller.js";
import { playerCanvas, SPRITE_W, type TeamColors } from "./sprites.js";

const FIELD_W = 53.333;
const MARGIN = 3;          // yards of sideline area each side
const Y2PX = (s: number) => s; // readability

export class FieldScene extends Phaser.Scene {
  ctl!: Controller;
  S = 8;                   // pixels per yard
  private field!: Phaser.GameObjects.Graphics;
  private lines!: Phaser.GameObjects.Graphics;
  private guide!: Phaser.GameObjects.Graphics;
  private marks!: Phaser.GameObjects.Graphics;
  private sprites: Phaser.GameObjects.Image[] = [];
  private ball!: Phaser.GameObjects.Ellipse;
  private ballShadow!: Phaser.GameObjects.Ellipse;
  private texKeys = new Set<string>();
  private yardText: Phaser.GameObjects.Text[] = [];
  private drag: { x: number; y: number } | null = null;
  private aim: { x: number; y: number; power: number } | null = null;
  /** kick flick in progress (screen points) */
  private flick: { x: number; y: number }[] = [];
  private camY = 0;
  /** ability popups ("ANKLE BREAKER!") over the player who used it */
  private fxText: Phaser.GameObjects.Text[] = [];

  constructor() { super("field"); }

  init(data: { ctl: Controller }) { this.ctl = data.ctl; }

  create() {
    this.field = this.add.graphics().setDepth(0);
    this.lines = this.add.graphics().setDepth(1);
    this.marks = this.add.graphics().setDepth(2);
    this.guide = this.add.graphics().setDepth(50);
    this.ballShadow = this.add.ellipse(0, 0, 6, 3, 0x000000, 0.35).setDepth(29);
    this.ball = this.add.ellipse(0, 0, 7, 5, 0x8a4b22).setStrokeStyle(1, 0x14141c).setDepth(60);
    for (let i = 0; i < 22; i++) this.sprites.push(this.add.image(0, 0, "__DEFAULT").setDepth(30).setVisible(false));
    this.layout();
    this.scale.on("resize", () => this.layout());
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on("pointerupoutside", (p: Phaser.Input.Pointer) => this.onUp(p));
  }

  // ---------------------------------------------------------------- coordinates
  /** user-frame yards -> world pixels */
  private wx(ux: number) { return (ux + MARGIN) * this.S; }
  private wy(uy: number) { return (110 + MARGIN - uy) * this.S; }
  /** world pixels -> user-frame yards */
  private ux(px: number) { return px / this.S - MARGIN; }
  private uy(py: number) { return 110 + MARGIN - py / this.S; }
  /** snapshot (offense frame, Fx) -> user frame yards */
  private toUser(x: number, y: number, flip: boolean) {
    const X = x / 65536, Y = y / 65536;
    return flip ? { x: FIELD_W - X, y: 100 - Y } : { x: X, y: Y };
  }

  private layout() {
    const w = this.scale.width;
    this.S = Math.max(5, w / (FIELD_W + MARGIN * 2));
    this.cameras.main.setBounds(0, 0, w, (120 + MARGIN * 2) * this.S);
    this.drawField();
  }

  private drawField() {
    const g = this.field, S = this.S;
    g.clear();
    for (const t of this.yardText) t.destroy();
    this.yardText = [];
    const home = this.ctl.team(this.ctl.userSide), away = this.ctl.team(this.ctl.userSide === 0 ? 1 : 0);
    g.fillStyle(0x245f2a).fillRect(0, 0, this.scale.width, (120 + MARGIN * 2) * S);
    // 5-yard turf stripes
    for (let y = 0; y < 100; y += 5) {
      g.fillStyle((y / 5) % 2 ? 0x2f7d32 : 0x2b7330).fillRect(this.wx(0), this.wy(y + 5), FIELD_W * S, 5 * S);
    }
    // end zones: the top one is the opponent's (you attack up), the bottom one is yours
    g.fillStyle(Phaser.Display.Color.HexStringToColor(away.c1).color).fillRect(this.wx(0), this.wy(110), FIELD_W * S, 10 * S);
    g.fillStyle(Phaser.Display.Color.HexStringToColor(home.c1).color).fillRect(this.wx(0), this.wy(0), FIELD_W * S, 10 * S);
    g.lineStyle(Math.max(1, S * 0.2), 0xffffff, 0.9);
    g.strokeRect(this.wx(0), this.wy(110), FIELD_W * S, 120 * S);
    for (let y = 0; y <= 100; y += 5) {
      g.lineStyle(Math.max(1, S * (y % 10 === 0 ? 0.18 : 0.12)), 0xffffff, y % 10 === 0 ? 0.85 : 0.55);
      g.lineBetween(this.wx(0), this.wy(y), this.wx(FIELD_W), this.wy(y));
    }
    // hash marks every yard
    const hashL = FIELD_W / 2 - 3.1, hashR = FIELD_W / 2 + 3.1;
    g.lineStyle(Math.max(1, S * 0.1), 0xffffff, 0.6);
    for (let y = 1; y < 100; y++) {
      for (const hx of [hashL, hashR, 1, FIELD_W - 1]) g.lineBetween(this.wx(hx - 0.5), this.wy(y), this.wx(hx + 0.5), this.wy(y));
    }
    // yard numbers
    const fs = Math.round(S * 1.9);
    for (let y = 10; y <= 90; y += 10) {
      const n = String(y <= 50 ? y : 100 - y);
      for (const [x, ang] of [[7, -90], [FIELD_W - 7, 90]] as const) {
        const t = this.add.text(this.wx(x), this.wy(y), n, { fontFamily: "Press Start 2P, monospace", fontSize: `${fs}px`, color: "#ffffff" })
          .setOrigin(0.5).setAngle(ang).setAlpha(0.75).setDepth(1);
        this.yardText.push(t);
      }
    }
    // goal posts on both end lines (seen from above: crossbar and the uprights' shadows)
    for (const y of [110, -10]) {
      const half = 3.08, cx = FIELD_W / 2;
      g.lineStyle(Math.max(2, S * 0.3), 0xffe14a, 1).lineBetween(this.wx(cx - half), this.wy(y), this.wx(cx + half), this.wy(y));
      const up = y > 50 ? -1 : 1;
      g.lineStyle(Math.max(2, S * 0.22), 0xffe14a, 0.9);
      g.lineBetween(this.wx(cx - half), this.wy(y), this.wx(cx - half), this.wy(y) + up * 6 * S * 0.45);
      g.lineBetween(this.wx(cx + half), this.wy(y), this.wx(cx + half), this.wy(y) + up * 6 * S * 0.45);
    }
    for (const [y, team] of [[105, away], [-5, home]] as const) {
      const t = this.add.text(this.wx(FIELD_W / 2), this.wy(y), team.nick.toUpperCase(), {
        fontFamily: "Press Start 2P, monospace", fontSize: `${Math.round(S * 2.6)}px`,
        color: Phaser.Display.Color.HexStringToColor(team.c2).rgba,
      }).setOrigin(0.5).setAlpha(0.95).setDepth(1).setStroke("#14141c", Math.max(2, S * 0.3));
      this.yardText.push(t);
    }
  }

  // ---------------------------------------------------------------- textures
  private tex(team: TeamColors, num: number | null, facing: "back" | "front", frame: 0 | 1): string {
    const key = `p_${team.abbr}_${team.c1}_${num}_${facing}_${frame}`;
    if (!this.texKeys.has(key)) {
      this.textures.addCanvas(key, playerCanvas(team, num, facing, frame));
      this.texKeys.add(key);
    }
    return key;
  }

  // ---------------------------------------------------------------- input
  private userControlling(): "throw" | "run" | "defend" | "kick" | null {
    const c = this.ctl;
    if (c.ui.mode === "kick" && c.live?.kick?.userKick) return "kick";
    if (c.ui.mode !== "live" || !c.live || !c.cur) return null;
    if (c.live.kick) {
      if (c.live.kick.userReturn && c.cur.userCarrier) return "run";
      if ((c.cur.kick?.userPlayer ?? -1) >= 0 && c.cur.kick?.phase === "loose") return "defend";
      return null;
    }
    if (c.live.userDefense) return c.cur.userDefender >= 0 ? "defend" : null;
    if (!c.live.userOffense) return null;
    if (c.cur.qbCanThrow) return "throw";
    if (c.cur.userCarrier) return "run";
    return null;
  }
  private onDown(p: Phaser.Input.Pointer) {
    if (this.ctl.ui.mode === "presnap") { this.ctl.snapBall(); return; }
    const mode = this.userControlling();
    if (mode === "kick") { this.flick = [{ x: p.x, y: p.y }]; return; }
    if (mode === "throw") { this.drag = { x: p.x, y: p.y }; this.aim = null; }
    else if (mode === "run" || mode === "defend") this.steerTo(p);
  }
  private onMove(p: Phaser.Input.Pointer) {
    if (!p.isDown) return;
    const mode = this.userControlling();
    if (mode === "kick") { if (this.flick.length) this.flick.push({ x: p.x, y: p.y }); return; }
    if (mode === "throw" && this.drag && this.ctl.cur) {
      // slingshot: pull back from where you touched; the ball goes the other way
      const dx = this.drag.x - p.x, dy = this.drag.y - p.y;
      const lenPx = Math.hypot(dx, dy);
      const qb = this.qbUser();
      if (!qb) return;
      const k = 2.1;
      this.aim = {
        x: Math.max(-1, Math.min(FIELD_W + 1, qb.x + (dx / this.S) * k)),
        y: qb.y - (dy / this.S) * k,
        power: Math.min(1, lenPx / (Math.min(this.scale.width, this.scale.height) * 0.42)),
      };
    } else if (mode === "run" || mode === "defend") this.steerTo(p);
    else if (this.drag) { this.drag = null; this.aim = null; }
  }
  private onUp(_p: Phaser.Input.Pointer) {
    if (this.userControlling() === "kick" && this.flick.length >= 2) {
      const k = this.flickToKick();
      this.flick = [];
      if (k) this.ctl.kickBall(k.aim, k.power, k.curve);
      return;
    }
    this.flick = [];
    if (this.drag && this.aim && this.userControlling() === "throw") {
      const a = this.aim;
      // user offense: the user frame is the offense frame
      this.ctl.input.throwAt = { x: Math.round(a.x * 65536), y: Math.round(a.y * 65536), power: a.power };
    }
    this.drag = null; this.aim = null;
    const m = this.userControlling();
    if (m === "run" || m === "defend") this.ctl.input.move = null;
  }
  /** Flick -> aim (radians from straight up the screen, + = right), power (length), curve (bend of the path). */
  private flickToKick(): { aim: number; power: number; curve: number } | null {
    const a = this.flick[0]!, b = this.flick[this.flick.length - 1]!;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (dy > -20 || len < 30) return null;
    const aim = Math.max(-0.6, Math.min(0.6, Math.atan2(dx, -dy)));
    const power = Math.max(0.05, Math.min(1, len / (this.scale.height * 0.45)));
    const mid = this.flick[Math.floor(this.flick.length / 2)]!;
    // signed distance of the middle of the swipe from the straight line, relative to its length
    const bend = ((mid.x - a.x) * dy - (mid.y - a.y) * dx) / (len * len);
    const curve = Math.max(-1, Math.min(1, -bend * 6));
    return { aim, power, curve };
  }
  private steerTo(p: Phaser.Input.Pointer) {
    const c = this.ctl.cur!;
    const kickScramble = Boolean(this.ctl.live?.kick && (c.kick?.userPlayer ?? -1) >= 0 && c.kick?.phase === "loose");
    const defend = Boolean(this.ctl.live?.userDefense) || kickScramble || Boolean(this.ctl.live?.kick?.userReturn);
    const me = c.actors[kickScramble ? c.kick!.userPlayer : this.ctl.live?.userDefense ? c.userDefender : c.carrier];
    if (!me) return;
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    const tx = this.ux(wp.x), ty = this.uy(wp.y);
    // move is in your (screen) frame; the controller turns it around when the AI has the ball
    const pos = this.toUser(me.x, me.y, defend && this.ctl.flipped());
    const dx = tx - pos.x, dy = ty - pos.y;
    if (Math.hypot(dx, dy) < 0.6) return;
    this.ctl.input.move = { x: Math.round(dx * 65536), y: Math.round(dy * 65536) };
  }
  private qbUser() {
    const c = this.ctl.cur!;
    const qb = c.actors.find((a) => a.side === "O" && a.role === "QB");
    return qb ? this.toUser(qb.x, qb.y, false) : null;
  }

  // ---------------------------------------------------------------- render loop
  override update(_t: number, dt: number) {
    const ctl = this.ctl;
    ctl.frame(dt);
    const cur = ctl.cur, prev = ctl.prev ?? cur;
    const flip = ctl.flipped();
    this.marks.clear();
    this.guide.clear();
    if (!cur || !prev || (!ctl.live && ctl.ui.mode !== "result")) {
      this.hideActors();
      this.drawStateLines(flip);
      const los = ctl.state.ballOn / 65536;
      this.follow(flip ? 100 - los : los);
      return;
    }
    this.ball.setVisible(true);
    const alpha = ctl.ui.mode === "live" ? Math.min(1, ctl.acc / (1000 / 30)) : 1;
    this.drawLines(cur, flip);
    const offTeam = ctl.team(ctl.live ? ctl.live.offSide : ctl.state.possession);
    const defTeam = ctl.team(ctl.live ? (ctl.live.offSide === 0 ? 1 : 0) : (ctl.state.possession === 0 ? 1 : 0));
    const order = cur.actors.map((a, i) => ({ a, i })).sort((p, q) => {
      const pu = this.toUser(p.a.x, p.a.y, flip).y, qu = this.toUser(q.a.x, q.a.y, flip).y;
      return qu - pu;
    });
    const scale = (2.3 * this.S) / SPRITE_W;
    order.forEach(({ a, i }, depthIdx) => {
      const pa = prev.actors[i] ?? a;
      const x = pa.x + (a.x - pa.x) * alpha, y = pa.y + (a.y - pa.y) * alpha;
      const u = this.toUser(x, y, flip);
      const team = a.side === "O" ? offTeam : defTeam;
      const facing: "back" | "front" = (a.side === "O") !== flip ? "back" : "front";
      const moving = Math.hypot(a.vx, a.vy) > 0.8 * 65536;
      const frame = (moving && Math.floor(this.time.now / 140) % 2 === 1 ? 1 : 0) as 0 | 1;
      const spr = this.sprites[i]!;
      spr.setTexture(this.tex(team, a.num, facing, frame)).setScale(scale).setVisible(true).setDepth(30 + depthIdx * 0.01);
      spr.setPosition(this.wx(u.x), this.wy(u.y) - 9 * scale);
      spr.setAngle(a.down ? (a.side === "O" ? 90 : -90) : 0);
      // highlight: the player you control
      if ((ctl.live?.userOffense && ((cur.qbCanThrow && a.role === "QB" && a.side === "O") || (cur.userCarrier && i === cur.carrier))) ||
          (ctl.live?.userDefense && i === cur.userDefender)) {
        this.marks.lineStyle(Math.max(2, this.S * 0.25), 0xffd23e, 1).strokeEllipse(this.wx(u.x), this.wy(u.y) + 1, 2.8 * this.S, 1.4 * this.S);
      }
    });
    this.drawFx(cur, prev, flip, alpha);
    if (ctl.ui.mode === "presnap") this.drawPresnap(cur, flip);
    if (ctl.ui.mode === "kick" && cur.kick) this.drawKickGuide(cur, flip);
    if (ctl.live?.kick && cur.kick && cur.kick.userPlayer >= 0 && cur.kick.phase === "loose") {
      const a = cur.actors[cur.kick.userPlayer]!, u = this.toUser(a.x, a.y, flip);
      this.marks.lineStyle(Math.max(2, this.S * 0.25), 0xffd23e, 1).strokeEllipse(this.wx(u.x), this.wy(u.y) + 1, 2.8 * this.S, 1.4 * this.S);
    }
    // ball
    const b = cur.ball, pb = prev.ball;
    const bx = pb.x + (b.x - pb.x) * alpha, by = pb.y + (b.y - pb.y) * alpha, bh = (pb.h + (b.h - pb.h) * alpha) / 65536;
    const ub = this.toUser(bx, by, flip);
    const lift = Math.min(bh, 30) * 0.45;
    const grow = 1 + Math.min(bh, 30) / 25;
    this.ball.setPosition(this.wx(ub.x) + (b.state === "air" ? 0 : 0.6 * this.S), this.wy(ub.y) - lift * this.S - (b.state === "air" ? 0 : 0.8 * this.S));
    this.ball.setSize(0.9 * this.S, 0.6 * this.S).setDisplaySize(0.9 * this.S * grow, 0.6 * this.S * grow);
    this.ballShadow.setPosition(this.wx(ub.x), this.wy(ub.y) + 0.2 * this.S).setDisplaySize(0.8 * this.S, 0.4 * this.S).setVisible(b.state === "air" || b.state === "loose");
    // throw guide
    if (this.aim && this.userControlling() === "throw") {
      const qb = this.qbUser()!;
      const g = this.guide;
      const steps = 14;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const x = qb.x + (this.aim.x - qb.x) * t, y = qb.y + (this.aim.y - qb.y) * t;
        const apex = 6 * (1 - this.aim.power) + 1.6 * this.aim.power;
        const h = 4 * apex * t * (1 - t);
        g.fillStyle(0xffffff, 0.85).fillCircle(this.wx(x), this.wy(y) - h * this.S * 0.7, Math.max(1.5, this.S * 0.18));
      }
      g.lineStyle(Math.max(2, this.S * 0.22), this.aim.power > 0.6 ? 0xff5a4e : 0xffd23e, 1).strokeCircle(this.wx(this.aim.x), this.wy(this.aim.y), this.S * 1.2);
    }
    // camera: keep the ball a little below centre when you attack up, above when the AI attacks down
    const target = b.state === "air" ? this.toUser(b.x, b.y, flip).y : ub.y;
    this.follow(target);
  }

  /** Ability popups: rise and fade over ~1.5 s above the player. */
  private drawFx(cur: PlaySnapshot, prev: PlaySnapshot, flip: boolean, alpha: number) {
    const life = 45;
    const show = (cur.fx ?? []).filter((f) => cur.tick - f.tick < life).slice(-4);
    while (this.fxText.length < show.length) {
      this.fxText.push(this.add.text(0, 0, "", { fontFamily: "Press Start 2P, monospace", fontSize: "10px", color: "#ffd23e", stroke: "#14141c", strokeThickness: 3 })
        .setOrigin(0.5, 1).setDepth(70));
    }
    this.fxText.forEach((t, k) => {
      const f = show[k];
      if (!f) { t.setVisible(false); return; }
      const a = cur.actors[f.i], pa = prev.actors[f.i] ?? a;
      if (!a || !pa) { t.setVisible(false); return; }
      const age = (cur.tick - f.tick) / life;
      const u = this.toUser(pa.x + (a.x - pa.x) * alpha, pa.y + (a.y - pa.y) * alpha, flip);
      t.setText(f.text).setFontSize(Math.max(8, Math.round(this.S * 0.9))).setVisible(true)
        .setPosition(this.wx(u.x), this.wy(u.y) - (3.2 + age * 2.5) * this.S - k * this.S * 1.1).setAlpha(1 - age * age);
    });
  }

  /** Kick aiming: the accuracy cone from the kick spot (it widens under pressure and for weaker kickers)
   *  and, while you flick, the aim line. */
  private drawKickGuide(cur: PlaySnapshot, flip: boolean) {
    const g = this.guide, S = this.S, k = cur.kick!;
    const sp = this.toUser(k.spot.x, k.spot.y, flip);
    const cone = k.cone / 65536;
    let aim = 0, power = 0.7;
    const fk = this.flick.length >= 2 ? this.flickToKick() : null;
    if (fk) { aim = fk.aim; power = fk.power; }
    const reach = (k.kind === "punt" || k.kind === "kickoff" ? 55 : k.kind === "squib" ? 25 : k.kind === "onside" ? 12 : 60) * (0.45 + 0.55 * power);
    const P = (ang: number, d: number) => ({ x: this.wx(sp.x + Math.sin(ang) * d), y: this.wy(sp.y + Math.cos(ang) * d) });
    const o = { x: this.wx(sp.x), y: this.wy(sp.y) };
    g.fillStyle(0xffd23e, 0.18);
    const l = P(aim - cone, reach), r = P(aim + cone, reach);
    g.fillTriangle(o.x, o.y, l.x, l.y, r.x, r.y);
    g.lineStyle(Math.max(2, S * 0.2), fk ? 0xff5a4e : 0xffd23e, 0.9);
    const e = P(aim, reach);
    g.lineBetween(o.x, o.y, e.x, e.y);
    // wind arrow next to the kick spot
    const w = k.wind, wl = Math.hypot(w.x, w.y) / 65536;
    if (wl > 0) {
      const ws = this.toUser(k.spot.x + w.x / 4, k.spot.y + w.y / 4, false);
      const wsx = flip ? -(w.x / 65536) : w.x / 65536, wsy = flip ? -(w.y / 65536) : w.y / 65536;
      void ws;
      g.lineStyle(Math.max(2, S * 0.18), 0x9ad8ff, 0.9).lineBetween(o.x + 3 * S, o.y, o.x + 3 * S + wsx * S * 0.4, o.y - wsy * S * 0.4);
    }
  }

  /** Pre-snap overlay: your routes (offense) or your assignments (defense). Never the opponent's. */
  private drawPresnap(cur: PlaySnapshot, flip: boolean) {
    const g = this.guide, S = this.S, live = this.ctl.live!;
    const P = (x: number, y: number) => { const u = this.toUser(x, y, flip); return { x: this.wx(u.x), y: this.wy(u.y) }; };
    if (live.userOffense) {
      for (const r of cur.routes) {
        const a = cur.actors[r.i]!;
        const hot = Boolean(this.ctl.preOff.hot?.[a.role]);
        g.lineStyle(Math.max(2, S * 0.22), hot ? 0xff5a4e : 0xffd23e, 0.85);
        let p0 = P(a.x, a.y);
        for (const pt of r.pts) { const p1 = P(pt.x, pt.y); g.lineBetween(p0.x, p0.y, p1.x, p1.y); p0 = p1; }
        g.fillStyle(hot ? 0xff5a4e : 0xffd23e, 1).fillCircle(p0.x, p0.y, S * 0.35);
      }
      return;
    }
    const qb = cur.actors.find((a) => a.side === "O" && a.role === "QB")!;
    for (const as of cur.assign) {
      const a = cur.actors[as.i]!;
      const p0 = P(a.x, a.y);
      if (as.task === "zone" && as.at && as.r) {
        const c = P(as.at.x, as.at.y);
        g.lineStyle(Math.max(1, S * 0.15), 0x4fa8ff, 0.7).strokeCircle(c.x, c.y, (as.r / 65536) * S * 0.55);
        g.lineStyle(Math.max(1, S * 0.12), 0x4fa8ff, 0.5).lineBetween(p0.x, p0.y, c.x, c.y);
      } else if (as.task === "man" && as.target != null) {
        const t = cur.actors[as.target]!, p1 = P(t.x, t.y);
        g.lineStyle(Math.max(1, S * 0.15), 0xff5a4e, 0.8).lineBetween(p0.x, p0.y, p1.x, p1.y);
      } else if (as.task === "rush" || as.task === "spy") {
        const p1 = P(qb.x, qb.y);
        const k = as.task === "spy" ? 0.5 : 0.35;
        g.lineStyle(Math.max(1, S * 0.18), as.task === "spy" ? 0xb07cff : 0xffd23e, 0.8).lineBetween(p0.x, p0.y, p0.x + (p1.x - p0.x) * k, p0.y + (p1.y - p0.y) * k);
      }
    }
  }

  private follow(targetUy: number) {
    const cam = this.cameras.main;
    const goal = this.wy(targetUy) - cam.height * (this.ctl.flipped() ? 0.4 : 0.62);
    this.camY += (goal - this.camY) * 0.12;
    cam.setScroll(0, this.camY);
  }

  private hideActors() {
    for (const s of this.sprites) s.setVisible(false);
    for (const t of this.fxText) t.setVisible(false);
    this.ball.setVisible(false); this.ballShadow.setVisible(false);
  }

  /** LOS and first-down line between plays (from the game state). */
  private drawStateLines(_flip: boolean) {
    const s = this.ctl.state;
    if (s.phase !== "play") return;
    const userOff = s.possession === this.ctl.userSide;
    const los = s.ballOn / 65536, fd = (s.ballOn + s.toGo) / 65536;
    const conv = (y: number) => (userOff ? y : 100 - y);
    this.lines.clear();
    this.lines.lineStyle(Math.max(2, this.S * 0.3), 0x4fa8ff, 0.9).lineBetween(this.wx(0), this.wy(conv(los)), this.wx(FIELD_W), this.wy(conv(los)));
    if (fd < 100) this.lines.lineStyle(Math.max(2, this.S * 0.3), 0xffd23e, 0.9).lineBetween(this.wx(0), this.wy(conv(fd)), this.wx(FIELD_W), this.wy(conv(fd)));
  }

  private drawLines(cur: PlaySnapshot, flip: boolean) {
    const s = this.ctl.live?.ctx.at ?? this.ctl.state;
    this.lines.clear();
    const los = cur.los / 65536;
    const fd = (s.ballOn + s.toGo) / 65536;
    const conv = (y: number) => (flip ? 100 - y : y);
    this.lines.lineStyle(Math.max(2, this.S * 0.3), 0x4fa8ff, 0.9).lineBetween(this.wx(0), this.wy(conv(los)), this.wx(FIELD_W), this.wy(conv(los)));
    if (fd < 100 && s.phase === "play") this.lines.lineStyle(Math.max(2, this.S * 0.3), 0xffd23e, 0.9).lineBetween(this.wx(0), this.wy(conv(fd)), this.wx(FIELD_W), this.wy(conv(fd)));
  }
}

export type { ActorView };
void Y2PX;
