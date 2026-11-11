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
  private camY = 0;

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
  private userControlling(): "throw" | "run" | "defend" | null {
    const c = this.ctl;
    if (c.ui.mode !== "live" || !c.live || !c.cur) return null;
    if (c.live.userDefense) return c.cur.userDefender >= 0 ? "defend" : null;
    if (!c.live.userOffense) return null;
    if (c.cur.qbCanThrow) return "throw";
    if (c.cur.userCarrier) return "run";
    return null;
  }
  private onDown(p: Phaser.Input.Pointer) {
    if (this.ctl.ui.mode === "presnap") { this.ctl.snapBall(); return; }
    const mode = this.userControlling();
    if (mode === "throw") { this.drag = { x: p.x, y: p.y }; this.aim = null; }
    else if (mode === "run" || mode === "defend") this.steerTo(p);
  }
  private onMove(p: Phaser.Input.Pointer) {
    if (!p.isDown) return;
    const mode = this.userControlling();
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
    if (this.drag && this.aim && this.userControlling() === "throw") {
      const a = this.aim;
      // user offense: the user frame is the offense frame
      this.ctl.input.throwAt = { x: Math.round(a.x * 65536), y: Math.round(a.y * 65536), power: a.power };
    }
    this.drag = null; this.aim = null;
    const m = this.userControlling();
    if (m === "run" || m === "defend") this.ctl.input.move = null;
  }
  private steerTo(p: Phaser.Input.Pointer) {
    const c = this.ctl.cur!;
    const defend = Boolean(this.ctl.live?.userDefense);
    const me = c.actors[defend ? c.userDefender : c.carrier];
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
    // ball
    const b = cur.ball, pb = prev.ball;
    const bx = pb.x + (b.x - pb.x) * alpha, by = pb.y + (b.y - pb.y) * alpha, bh = (pb.h + (b.h - pb.h) * alpha) / 65536;
    const ub = this.toUser(bx, by, flip);
    this.ball.setPosition(this.wx(ub.x) + (b.state === "air" ? 0 : 0.6 * this.S), this.wy(ub.y) - bh * this.S * 0.7 - (b.state === "air" ? 0 : 0.8 * this.S));
    this.ball.setSize(0.9 * this.S, 0.6 * this.S).setDisplaySize(0.9 * this.S, 0.6 * this.S);
    this.ballShadow.setPosition(this.wx(ub.x), this.wy(ub.y) + 0.2 * this.S).setDisplaySize(0.8 * this.S, 0.4 * this.S).setVisible(b.state === "air");
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

  private follow(targetUy: number) {
    const cam = this.cameras.main;
    const goal = this.wy(targetUy) - cam.height * (this.ctl.flipped() ? 0.4 : 0.62);
    this.camY += (goal - this.camY) * 0.12;
    cam.setScroll(0, this.camY);
  }

  private hideActors() { for (const s of this.sprites) s.setVisible(false); this.ball.setVisible(false); this.ballShadow.setVisible(false); }

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
