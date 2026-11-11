// The field: players, ball, lines, throw guide, touch/mouse input, replays and game-feel effects.
// Two cameras (M9) behind one projection (view.ts): Bowl = top-down, you attack up the screen; Pro =
// the All-22 broadcast view from the sideline, you attack to the right. The player's team always
// attacks the same way on screen; when the other team has the ball the picture is turned around.
import Phaser from "phaser";
import type { ActorView, PlaySnapshot } from "@tdf/sim";
import type { Controller } from "../game/controller.js";
import { audio, type Sfx } from "../audio/audio.js";
import { crowdCanvas, playerCanvas, SPRITE_H, SPRITE_W, type Facing, type TeamColors } from "./sprites.js";
import { BowlView, FIELD_W, MARGIN, ProView, type View } from "./view.js";

const PIXEL_FONT = '"Press Start 2P", monospace';
const hex = (c: string) => Phaser.Display.Color.HexStringToColor(c).color;

interface Confetti { x: number; y: number; vx: number; vy: number; c: number; r: number; life: number }

export class FieldScene extends Phaser.Scene {
  ctl!: Controller;
  private bowl!: BowlView;
  private pro!: ProView;
  private view!: View;
  private field!: Phaser.GameObjects.Graphics;
  private stands!: Phaser.GameObjects.TileSprite;
  private lines!: Phaser.GameObjects.Graphics;
  private guide!: Phaser.GameObjects.Graphics;
  private marks!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private sprites: Phaser.GameObjects.Image[] = [];
  private ball!: Phaser.GameObjects.Ellipse;
  private ballShadow!: Phaser.GameObjects.Ellipse;
  private texKeys = new Set<string>();
  private yardText: Phaser.GameObjects.Text[] = [];
  private zoneText: Phaser.GameObjects.Text[] = [];
  private drag: { x: number; y: number } | null = null;
  private aim: { x: number; y: number; power: number } | null = null;
  /** kick flick in progress (screen points) */
  private flick: { x: number; y: number }[] = [];
  /** ability popups ("ANKLE BREAKER!") over the player who used it */
  private fxText: Phaser.GameObjects.Text[] = [];
  private callout!: Phaser.GameObjects.Text;
  private confetti: Confetti[] = [];
  // juice / sound bookkeeping
  private seenLog = 0;
  private seenSim: unknown = null;
  private lastMode = "";
  private lastBig: string | null = null;
  private slowUntil = 0;
  private lastKickPhase = "";
  private whistled = false;

  constructor() { super("field"); }
  init(data: { ctl: Controller }) { this.ctl = data.ctl; }

  create() {
    if (import.meta.env?.DEV) (globalThis as { __scene?: FieldScene }).__scene = this;
    const cfg = this.ctl.cd.data.presentation;
    this.bowl = new BowlView(this.scale.width, this.scale.height, cfg);
    this.pro = new ProView(this.scale.width, this.scale.height, cfg);
    this.view = this.bowl;
    this.field = this.add.graphics().setDepth(0);
    const t0 = this.ctl.team(0), t1 = this.ctl.team(1);
    this.textures.addCanvas("crowd", crowdCanvas([t0.c1, t0.c2, t1.c1, t1.c2, "#d9d9d9", "#3a3a3a"]));
    this.stands = this.add.tileSprite(0, 0, 10, 10, "crowd").setOrigin(0, 0).setDepth(0.5).setVisible(false);
    this.lines = this.add.graphics().setDepth(1);
    this.marks = this.add.graphics().setDepth(2);
    this.guide = this.add.graphics().setDepth(50);
    this.fxG = this.add.graphics().setDepth(80);
    this.ballShadow = this.add.ellipse(0, 0, 6, 3, 0x000000, 0.35).setDepth(29);
    this.ball = this.add.ellipse(0, 0, 7, 5, 0x8a4b22).setStrokeStyle(1, 0x14141c).setDepth(60);
    for (let i = 0; i < 22; i++) this.sprites.push(this.add.image(0, 0, "__DEFAULT").setDepth(30).setVisible(false));
    for (let k = 0; k < 18; k++) this.yardText.push(this.add.text(0, 0, "", { fontFamily: PIXEL_FONT, fontSize: "32px", color: "#ffffff" }).setOrigin(0.5).setAlpha(0.75).setDepth(1));
    for (let k = 0; k < 2; k++) this.zoneText.push(this.add.text(0, 0, "", { fontFamily: PIXEL_FONT, fontSize: "40px", color: "#ffffff", stroke: "#14141c", strokeThickness: 6 }).setOrigin(0.5).setDepth(1));
    this.callout = this.add.text(0, 0, "", { fontFamily: PIXEL_FONT, fontSize: "40px", color: "#ffd23e", stroke: "#14141c", strokeThickness: 8 }).setOrigin(0.5).setDepth(90).setVisible(false);
    this.scale.on("resize", () => { this.bowl.resize(this.scale.width, this.scale.height); this.pro.resize(this.scale.width, this.scale.height); });
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => { audio.unlock(); this.onDown(p); });
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on("pointerupoutside", (p: Phaser.Input.Pointer) => this.onUp(p));
  }

  /** snapshot (offense frame, Fx) -> user frame yards */
  private toUser(x: number, y: number, flip: boolean) {
    const X = x / 65536, Y = y / 65536;
    return flip ? { x: FIELD_W - X, y: 100 - Y } : { x: X, y: Y };
  }
  private P(x: number, y: number, h = 0) { return this.view.p(x, y, h); }

  // ---------------------------------------------------------------- field
  private quad(g: Phaser.GameObjects.Graphics, x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1) {
    const a = this.P(x0, y0), b = this.P(x1, y0), c = this.P(x1, y1), d = this.P(x0, y1);
    g.fillStyle(color, alpha).fillPoints([a, b, c, d], true);
  }
  private line(g: Phaser.GameObjects.Graphics, x0: number, y0: number, x1: number, y1: number, h0 = 0, h1 = h0) {
    const a = this.P(x0, y0, h0), b = this.P(x1, y1, h1);
    g.lineBetween(a.x, a.y, b.x, b.y);
  }
  private drawField(flip: boolean) {
    const g = this.field, S = this.view.S, pro = this.view.kind === "pro";
    g.clear();
    const me = this.ctl.team(this.ctl.userSide), them = this.ctl.team(this.ctl.userSide === 0 ? 1 : 0);
    void flip;
    g.fillStyle(0x1d4f23).fillRect(0, 0, this.scale.width, this.scale.height);
    this.quad(g, -MARGIN, -10 - MARGIN, FIELD_W + MARGIN, 110 + MARGIN, 0x245f2a);
    for (let y = 0; y < 100; y += 5) this.quad(g, 0, y, FIELD_W, y + 5, (y / 5) % 2 ? 0x2f7d32 : 0x2b7330);
    // end zones: the far one is the opponent's (you attack toward it), the near one yours
    this.quad(g, 0, 100, FIELD_W, 110, hex(them.c1));
    this.quad(g, 0, -10, FIELD_W, 0, hex(me.c1));
    g.lineStyle(Math.max(1, S * 0.2), 0xffffff, 0.9);
    for (const [x0, y0, x1, y1] of [[0, -10, FIELD_W, -10], [0, 110, FIELD_W, 110], [0, -10, 0, 110], [FIELD_W, -10, FIELD_W, 110]] as const) this.line(g, x0, y0, x1, y1);
    for (let y = 0; y <= 100; y += 5) {
      g.lineStyle(Math.max(1, S * (y % 10 === 0 ? 0.18 : 0.12)), 0xffffff, y % 10 === 0 ? 0.85 : 0.55);
      this.line(g, 0, y, FIELD_W, y);
    }
    // hash marks every yard (only what's on screen)
    const hashL = FIELD_W / 2 - 3.1, hashR = FIELD_W / 2 + 3.1;
    g.lineStyle(Math.max(1, S * 0.1), 0xffffff, 0.6);
    for (let y = 1; y < 100; y++) {
      if (y % 5 === 0) continue;
      const c = this.P(FIELD_W / 2, y);
      if (c.x < -40 || c.x > this.scale.width + 40 || c.y < -40 || c.y > this.scale.height + 40) continue;
      for (const hx of [hashL, hashR, 1, FIELD_W - 1]) {
        if (pro) this.line(g, hx, y - 0.5, hx, y + 0.5); else this.line(g, hx - 0.5, y, hx + 0.5, y);
      }
    }
    // yard numbers
    let k = 0;
    for (let y = 10; y <= 90; y += 10) {
      const n = String(y <= 50 ? y : 100 - y);
      for (const x of [7, FIELD_W - 7]) {
        const t = this.yardText[k++]!;
        const p = this.P(x, y);
        t.setText(n).setPosition(p.x, p.y).setScale((p.s * 1.9) / 32).setAngle(pro ? 0 : x < FIELD_W / 2 ? -90 : 90).setVisible(true);
      }
    }
    // goal posts: crossbar 10 ft up, uprights above it
    for (const y of [110, -10]) {
      const half = 3.08, cx = FIELD_W / 2;
      g.lineStyle(Math.max(2, S * 0.22), 0xffe14a, 1);
      this.line(g, cx, y, cx, y, 0, 3.33);
      this.line(g, cx - half, y, cx + half, y, 3.33, 3.33);
      this.line(g, cx - half, y, cx - half, y, 3.33, 10);
      this.line(g, cx + half, y, cx + half, y, 3.33, 10);
    }
    // the stands behind the far sideline (Pro camera)
    if (pro) {
      const far = this.P(-MARGIN, 50), farY = Math.max(0, far.y);
      const z = Math.max(1, Math.round(far.s / 6));
      this.stands.setVisible(farY > 2).setPosition(0, 0).setSize(this.scale.width, farY).setTileScale(z, z)
        .setTilePosition(-(this.P(-MARGIN, 0).x) / z, 0);
    } else this.stands.setVisible(false);
    [[105, them], [-5, me]].forEach(([y, team], i) => {
      const tm = team as TeamColors & { nick: string };
      const t = this.zoneText[i]!, p = this.P(FIELD_W / 2, y as number);
      t.setText(tm.nick.toUpperCase()).setColor(Phaser.Display.Color.HexStringToColor(tm.c2).rgba).setPosition(p.x, p.y)
        .setScale((p.s * 2.6) / 40).setAngle(pro ? (y === 105 ? 90 : -90) : 0).setVisible(true);
    });
  }

  // ---------------------------------------------------------------- textures
  private tex(team: TeamColors, num: number | null, facing: Facing, frame: 0 | 1): string {
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
    if (c.replay) return null;
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
    if (this.ctl.replay) return;
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
      const q = this.P(qb.x, qb.y);
      const t = this.view.inv(q.x + dx * k, q.y + dy * k);
      this.aim = { x: Math.max(-1, Math.min(FIELD_W + 1, t.x)), y: t.y, power: Math.min(1, lenPx / (Math.min(this.scale.width, this.scale.height) * 0.42)) };
    } else if (mode === "run" || mode === "defend") this.steerTo(p);
    else if (this.drag) { this.drag = null; this.aim = null; }
  }
  private onUp(_p: Phaser.Input.Pointer) {
    if (this.userControlling() === "kick" && this.flick.length >= 2) {
      const k = this.flickToKick();
      this.flick = [];
      if (k) { this.ctl.kickBall(k.aim, k.power, k.curve); }
      return;
    }
    this.flick = [];
    if (this.drag && this.aim && this.userControlling() === "throw") {
      const a = this.aim;
      // user offense: the user frame is the offense frame
      this.ctl.input.throwAt = { x: Math.round(a.x * 65536), y: Math.round(a.y * 65536), power: a.power };
      audio.play("throw");
    }
    this.drag = null; this.aim = null;
    const m = this.userControlling();
    if (m === "run" || m === "defend") this.ctl.input.move = null;
  }
  /** Flick -> aim (radians from straight downfield, + = right), power (length), curve (bend of the path). */
  private flickToKick(): { aim: number; power: number; curve: number } | null {
    const fw = this.view.fwd, rt = { x: -fw.y, y: fw.x };
    const toFL = (q: { x: number; y: number }) => ({ f: q.x * fw.x + q.y * fw.y, l: q.x * rt.x + q.y * rt.y });
    const a = this.flick[0]!, b = this.flick[this.flick.length - 1]!, mid = this.flick[Math.floor(this.flick.length / 2)]!;
    const d = toFL({ x: b.x - a.x, y: b.y - a.y }), m = toFL({ x: mid.x - a.x, y: mid.y - a.y });
    const len = Math.hypot(d.f, d.l);
    if (d.f < 20 || len < 30) return null;
    const aim = Math.max(-0.6, Math.min(0.6, Math.atan2(d.l, d.f)));
    const span = this.view.kind === "pro" ? this.scale.width : this.scale.height;
    const power = Math.max(0.05, Math.min(1, len / (span * 0.45)));
    // signed distance of the middle of the swipe from the straight line, relative to its length
    const bend = (m.f * d.l - m.l * d.f) / (len * len);
    const curve = Math.max(-1, Math.min(1, -bend * 6));
    return { aim, power, curve };
  }
  private steerTo(p: Phaser.Input.Pointer) {
    const c = this.ctl.cur!;
    const kickScramble = Boolean(this.ctl.live?.kick && (c.kick?.userPlayer ?? -1) >= 0 && c.kick?.phase === "loose");
    const defend = Boolean(this.ctl.live?.userDefense) || kickScramble || Boolean(this.ctl.live?.kick?.userReturn);
    const me = c.actors[kickScramble ? c.kick!.userPlayer : this.ctl.live?.userDefense ? c.userDefender : c.carrier];
    if (!me) return;
    const t = this.view.inv(p.x, p.y);
    // move is in your (screen) frame; the controller turns it around when the other team has the ball
    const pos = this.toUser(me.x, me.y, defend && this.ctl.flipped());
    const dx = t.x - pos.x, dy = t.y - pos.y;
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
    const J = ctl.cd.data.presentation.juice;
    const calm = Boolean(ctl.settings.reducedMotion);
    // slow motion on a clutch catch (offline only: online play runs on the server's clock)
    const slow = !ctl.ui.online && !calm && this.time.now < this.slowUntil ? J.slowmoScale : 1;
    ctl.frame(dt * slow);
    ctl.replayFrame(dt);
    const kind = ctl.cameraFor(this.scale.width, this.scale.height);
    const next = kind === "pro" ? this.pro : this.bowl;
    if (next !== this.view) { this.view = next; const s = ctl.state; const los = s.ballOn / 65536; this.view.jump(FIELD_W / 2, ctl.flipped() ? 100 - los : los, !ctl.flipped()); }

    // what to draw: a replay, the live play, or the result frame
    const rp = ctl.replay;
    let cur: PlaySnapshot | null, prev: PlaySnapshot | null, flip: boolean, offSide: 0 | 1, alpha: number;
    if (rp) {
      const i = Math.floor(rp.pos);
      cur = rp.frames[Math.min(rp.frames.length - 1, i + 1)] ?? null; prev = rp.frames[i] ?? cur;
      alpha = rp.pos - i; flip = rp.rec.flip; offSide = rp.rec.offSide as 0 | 1;
    } else {
      cur = ctl.cur; prev = ctl.prev ?? cur; flip = ctl.flipped();
      offSide = (ctl.live ? ctl.live.offSide : ctl.state.possession) as 0 | 1;
      alpha = ctl.ui.mode === "live" ? Math.min(1, ctl.acc / (1000 / 30)) : 1;
    }
    this.marks.clear();
    this.guide.clear();
    this.drawField(flip);
    if (!rp) this.sounds(cur);
    this.drawConfetti(dt);
    if (!cur || !prev || (!rp && !ctl.live && ctl.ui.mode !== "result")) {
      this.hideActors();
      this.drawStateLines();
      const los = ctl.state.ballOn / 65536;
      this.view.follow(FIELD_W / 2, flip ? 100 - los : los, { attackingUp: !flip, zoom: false });
      return;
    }
    this.ball.setVisible(true);
    this.drawLines(cur, flip);
    const offTeam = ctl.team(offSide);
    const defTeam = ctl.team(offSide === 0 ? 1 : 0);
    const pro = this.view.kind === "pro";
    const pts = cur.actors.map((a, i) => {
      const pa = prev!.actors[i] ?? a;
      const u = this.toUser(pa.x + (a.x - pa.x) * alpha, pa.y + (a.y - pa.y) * alpha, flip);
      return { a, i, u, p: this.P(u.x, u.y) };
    });
    pts.sort((p, q) => p.p.y - q.p.y);
    const size = pro ? ctl.cd.data.presentation.pro.playerSize : 2.3;
    pts.forEach(({ a, i, u, p }, depthIdx) => {
      const scale = (size * p.s) / SPRITE_W;
      const team = a.side === "O" ? offTeam : defTeam;
      const attackingUp = (a.side === "O") !== flip;
      const facing: Facing = pro ? "side" : attackingUp ? "back" : "front";
      const moving = Math.hypot(a.vx, a.vy) > 0.8 * 65536;
      const frame = (moving && Math.floor(this.time.now / 140) % 2 === 1 ? 1 : 0) as 0 | 1;
      const spr = this.sprites[i]!;
      spr.setTexture(this.tex(team, a.num, facing, frame)).setScale(scale).setVisible(true).setDepth(30 + depthIdx * 0.01)
        .setFlipX(pro && !attackingUp);
      spr.setPosition(p.x, p.y - (SPRITE_H / 2.4) * scale);
      spr.setAngle(a.down ? (a.side === "O" ? 90 : -90) : 0);
      // highlight: the player you control
      if (!rp && ((ctl.live?.userOffense && ((cur!.qbCanThrow && a.role === "QB" && a.side === "O") || (cur!.userCarrier && i === cur!.carrier))) ||
          (ctl.live?.userDefense && i === cur!.userDefender))) {
        this.marks.lineStyle(Math.max(2, p.s * 0.25), 0xffd23e, 1).strokeEllipse(p.x, p.y + 1, 2.8 * p.s, 1.4 * p.s * (pro ? 0.8 : 1));
      }
      void u;
    });
    this.drawFx(cur, prev, flip, alpha);
    if (!rp && ctl.ui.mode === "presnap") this.drawPresnap(cur, flip);
    if (!rp && ctl.ui.mode === "kick" && cur.kick) this.drawKickGuide(cur, flip);
    if (!rp && ctl.live?.kick && cur.kick && cur.kick.userPlayer >= 0 && cur.kick.phase === "loose") {
      const a = cur.actors[cur.kick.userPlayer]!, u = this.toUser(a.x, a.y, flip), p = this.P(u.x, u.y);
      this.marks.lineStyle(Math.max(2, p.s * 0.25), 0xffd23e, 1).strokeEllipse(p.x, p.y + 1, 2.8 * p.s, 1.4 * p.s);
    }
    // ball
    const b = cur.ball, pb = prev.ball;
    const bx = pb.x + (b.x - pb.x) * alpha, by = pb.y + (b.y - pb.y) * alpha, bh = (pb.h + (b.h - pb.h) * alpha) / 65536;
    const ub = this.toUser(bx, by, flip);
    const air = b.state === "air";
    const lift = Math.min(bh, 30);
    const gp = this.P(ub.x, ub.y), bp = this.P(ub.x, ub.y, air ? lift : 1.2);
    const grow = 1 + (pro ? 0 : Math.min(bh, 30) / 25);
    this.ball.setPosition(bp.x + (air ? 0 : 0.6 * bp.s), bp.y).setSize(0.9 * bp.s, 0.6 * bp.s).setDisplaySize(0.9 * bp.s * grow, 0.6 * bp.s * grow);
    this.ballShadow.setPosition(gp.x, gp.y + 0.2 * gp.s).setDisplaySize(0.8 * gp.s, 0.4 * gp.s).setVisible(air || b.state === "loose");
    // throw guide
    if (this.aim && this.userControlling() === "throw") {
      const qb = this.qbUser()!;
      const g = this.guide;
      const steps = 14;
      for (let k = 1; k <= (this.ctl.aimGuide ? steps : 0); k++) {
        const t = k / steps;
        const x = qb.x + (this.aim.x - qb.x) * t, y = qb.y + (this.aim.y - qb.y) * t;
        const apex = 6 * (1 - this.aim.power) + 1.6 * this.aim.power;
        const p = this.P(x, y, 4 * apex * t * (1 - t) * 1.5);
        g.fillStyle(0xffffff, 0.85).fillCircle(p.x, p.y, Math.max(1.5, p.s * 0.18));
      }
      const e = this.P(this.aim.x, this.aim.y);
      g.lineStyle(Math.max(2, e.s * 0.22), this.aim.power > 0.6 ? 0xff5a4e : 0xffd23e, 1).strokeEllipse(e.x, e.y, e.s * 2.4, e.s * 2.4 * this.view.squash);
    }
    // camera: follow the ball (in the air: where it's going); Pro zooms in on a ball carrier after a catch or on a return
    const carrier = cur.carrier >= 0 ? cur.actors[cur.carrier] : null;
    const caught = cur.log.some((l) => l.startsWith("caught by") || l.includes("INTERCEPTED")) || Boolean(cur.kick && carrier && carrier.side === "D");
    const tgt = air ? this.toUser(b.x, b.y, flip) : ub;
    this.view.follow(tgt.x, tgt.y, { attackingUp: !flip, zoom: Boolean(carrier && caught && !cur.done) });
  }

  // ---------------------------------------------------------------- juice and sound
  private sounds(cur: PlaySnapshot | null) {
    const ctl = this.ctl, J = ctl.cd.data.presentation.juice, calm = Boolean(ctl.settings.reducedMotion);
    const mode = ctl.ui.mode;
    if (mode !== this.lastMode) {
      if (mode === "live" && (this.lastMode === "presnap" || this.lastMode === "kick" || !ctl.live?.kick)) audio.play(ctl.live?.kick ? "kick" : "snap");
      this.lastMode = mode;
    }
    const big = ctl.ui.bigToast;
    if (big !== this.lastBig) {
      this.lastBig = big;
      if (big === "TOUCHDOWN!") { audio.play("touchdown"); audio.swell(1.2); if (!calm) this.burstConfetti(J.confetti); }
      else if (big === "IT'S GOOD!") { audio.play("fieldGoal"); audio.swell(0.6); }
      else if (big === "NO GOOD") audio.play("miss");
      else if (big === "TAKEAWAY!") { audio.swell(1); }
      else if (big === "SAFETY!") audio.swell(0.8);
    }
    if (!cur || !ctl.live) return;
    if (ctl.live.sim !== this.seenSim) { this.seenSim = ctl.live.sim; this.seenLog = 0; this.whistled = false; this.lastKickPhase = ""; }
    if (cur.log.length < this.seenLog) this.seenLog = 0;
    const kp = cur.kick?.phase ?? "";
    if (kp !== this.lastKickPhase) { if (kp === "flight" && this.lastKickPhase && this.lastKickPhase !== "setup") audio.play("kick"); this.lastKickPhase = kp; }
    for (let k = this.seenLog; k < cur.log.length; k++) {
      const l = cur.log[k]!;
      let s: Sfx | null = null;
      if (l.startsWith("SACK")) { s = "bigHit"; this.shake(J.shakeSackMs, J.shakeSack); this.pop("SACK!", "#ff7a6b"); this.buzz(60); }
      else if (l.startsWith("INTERCEPTED")) { s = "pick"; this.shake(J.shakeTurnoverMs, J.shakeTurnover); this.pop("PICK!", "#7fd6ff"); this.buzz(80); }
      else if (l.startsWith("FUMBLE")) { s = "fumble"; this.shake(J.shakeTurnoverMs, J.shakeTurnover); this.pop("FUMBLE!", "#ffd23e"); this.buzz(80); }
      else if (l.includes(" tackled by ")) { s = "hit"; this.shake(J.shakeHitMs, J.shakeHit); this.buzz(25); }
      else if (l.startsWith("caught by")) {
        s = "catch";
        const air = this.airYards(cur);
        const st = ctl.state;
        const clutch = air >= J.clutchAirYards || (st.quarter >= 4 && st.clock / ctl.session.rules.tickHz <= 120) || st.down >= 3;
        if (clutch && !calm && !ctl.ui.online) { this.slowUntil = this.time.now + J.slowmoMs; if (air >= J.clutchAirYards) this.pop("WHAT A CATCH!", "#9be07f"); }
      } else if (l.includes(" throws")) s = "throw";
      else if (l.includes("kicks off") || l.includes("punts")) s = "kick";
      if (s) audio.play(s);
    }
    this.seenLog = cur.log.length;
    if (cur.done && !this.whistled) { this.whistled = true; audio.play("whistle"); }
  }
  private airYards(cur: PlaySnapshot): number {
    for (let k = cur.log.length - 1; k >= 0; k--) { const m = /\((-?\d+) air yds/.exec(cur.log[k]!); if (m) return Number(m[1]); }
    return 0;
  }
  private shake(ms: number, amt: number) { if (!this.ctl.settings.reducedMotion) this.cameras.main.shake(ms, amt); }
  private buzz(ms: number) { if (this.ctl.settings.haptics && navigator.vibrate) navigator.vibrate(ms); }
  /** Chunky on-field callout ("PICK!") that pops in and fades. */
  private pop(text: string, color: string) {
    const ms = this.ctl.cd.data.presentation.juice.popupMs;
    const c = this.callout;
    c.setText(text).setColor(color).setPosition(this.scale.width / 2, this.scale.height * 0.3).setVisible(true).setAlpha(1);
    const s = Math.min(1.4, this.scale.width / (text.length * 40 + 60));
    if (this.ctl.settings.reducedMotion) { c.setScale(s); this.time.delayedCall(ms, () => c.setVisible(false)); return; }
    c.setScale(0.2);
    this.tweens.killTweensOf(c);
    this.tweens.add({ targets: c, scale: s, duration: 180, ease: "Back.Out" });
    this.tweens.add({ targets: c, alpha: 0, delay: ms * 0.7, duration: ms * 0.3, onComplete: () => c.setVisible(false) });
  }
  private burstConfetti(n: number) {
    const cols = [this.ctl.team(this.ctl.state.possession).c1, this.ctl.team(this.ctl.state.possession).c2, "#ffd23e", "#ffffff"].map(hex);
    for (let k = 0; k < n; k++) {
      this.confetti.push({ x: this.scale.width * Math.random(), y: -20 - Math.random() * this.scale.height * 0.3, vx: (Math.random() - 0.5) * 60,
        vy: 60 + Math.random() * 120, c: cols[k % cols.length]!, r: Math.random() * Math.PI, life: 3 + Math.random() * 2 });
    }
  }
  private drawConfetti(dt: number) {
    const g = this.fxG;
    g.clear();
    if (!this.confetti.length) return;
    const s = dt / 1000;
    this.confetti = this.confetti.filter((p) => (p.life -= s) > 0 && p.y < this.scale.height + 20);
    for (const p of this.confetti) {
      p.x += (p.vx + Math.sin(p.r + p.life * 3) * 30) * s; p.y += p.vy * s; p.r += s * 4;
      const w = 6 * Math.abs(Math.cos(p.r)) + 1;
      g.fillStyle(p.c, 1).fillRect(p.x - w / 2, p.y - 3, w, 6);
    }
  }

  /** Ability popups: rise and fade over ~1.5 s above the player. */
  private drawFx(cur: PlaySnapshot, prev: PlaySnapshot, flip: boolean, alpha: number) {
    const life = 45;
    const show = (cur.fx ?? []).filter((f) => cur.tick - f.tick < life).slice(-4);
    while (this.fxText.length < show.length) {
      this.fxText.push(this.add.text(0, 0, "", { fontFamily: PIXEL_FONT, fontSize: "20px", color: "#ffd23e", stroke: "#14141c", strokeThickness: 5 })
        .setOrigin(0.5, 1).setDepth(70));
    }
    this.fxText.forEach((t, k) => {
      const f = show[k];
      if (!f) { t.setVisible(false); return; }
      const a = cur.actors[f.i], pa = prev.actors[f.i] ?? a;
      if (!a || !pa) { t.setVisible(false); return; }
      const age = (cur.tick - f.tick) / life;
      const u = this.toUser(pa.x + (a.x - pa.x) * alpha, pa.y + (a.y - pa.y) * alpha, flip);
      const p = this.P(u.x, u.y, 3.2 + age * 2.5 + k * 1.1);
      t.setText(f.text).setScale(Math.max(0.4, (p.s * 0.9) / 20)).setVisible(true).setPosition(p.x, p.y).setAlpha(1 - age * age);
    });
  }

  /** Kick aiming: the accuracy cone from the kick spot (it widens under pressure and for weaker kickers)
   *  and, while you flick, the aim line. */
  private drawKickGuide(cur: PlaySnapshot, flip: boolean) {
    const g = this.guide, k = cur.kick!;
    const sp = this.toUser(k.spot.x, k.spot.y, flip);
    const cone = k.cone / 65536;
    let aim = 0, power = 0.7;
    const fk = this.flick.length >= 2 ? this.flickToKick() : null;
    if (fk) { aim = fk.aim; power = fk.power; }
    const reach = (k.kind === "punt" || k.kind === "kickoff" ? 55 : k.kind === "squib" ? 25 : k.kind === "onside" ? 12 : 60) * (0.45 + 0.55 * power);
    const Pt = (ang: number, d: number) => this.P(sp.x + Math.sin(ang) * d, sp.y + Math.cos(ang) * d);
    const o = this.P(sp.x, sp.y);
    g.fillStyle(0xffd23e, 0.18);
    const l = Pt(aim - cone, reach), r = Pt(aim + cone, reach);
    g.fillTriangle(o.x, o.y, l.x, l.y, r.x, r.y);
    g.lineStyle(Math.max(2, o.s * 0.2), fk ? 0xff5a4e : 0xffd23e, 0.9);
    const e = Pt(aim, reach);
    g.lineBetween(o.x, o.y, e.x, e.y);
    // wind arrow next to the kick spot (in your frame)
    const w = k.wind, wl = Math.hypot(w.x, w.y) / 65536;
    if (wl > 0) {
      const wx = (flip ? -w.x : w.x) / 65536, wy = (flip ? -w.y : w.y) / 65536;
      const a0 = this.P(sp.x + 3, sp.y), a1 = this.P(sp.x + 3 + wx * 0.4, sp.y + wy * 0.4);
      g.lineStyle(Math.max(2, o.s * 0.18), 0x9ad8ff, 0.9).lineBetween(a0.x, a0.y, a1.x, a1.y);
    }
  }

  /** Pre-snap overlay: your routes (offense) or your assignments (defense). Never the opponent's. */
  private drawPresnap(cur: PlaySnapshot, flip: boolean) {
    const g = this.guide, live = this.ctl.live!;
    const P = (x: number, y: number) => { const u = this.toUser(x, y, flip); return this.P(u.x, u.y); };
    const S = this.view.S;
    if (live.userOffense) {
      for (const r of cur.routes) {
        const a = cur.actors[r.i]!;
        const hot = Boolean(this.ctl.preOff.hot?.[a.role]);
        g.lineStyle(Math.max(2, S * 0.22), hot ? 0xff5a4e : 0xffd23e, 0.85);
        let p0 = P(a.x, a.y);
        for (const pt of r.pts) { const p1 = P(pt.x, pt.y); g.lineBetween(p0.x, p0.y, p1.x, p1.y); p0 = p1; }
        g.fillStyle(hot ? 0xff5a4e : 0xffd23e, 1).fillCircle(p0.x, p0.y, S * 0.35);
      }
      // practice: the coverage read (normally you never see the other side's assignments)
      if (!this.ctl.coverageHints) return;
    }
    const qb = cur.actors.find((a) => a.side === "O" && a.role === "QB")!;
    for (const as of cur.assign) {
      const a = cur.actors[as.i]!;
      const p0 = P(a.x, a.y);
      if (as.task === "zone" && as.at && as.r) {
        const c = P(as.at.x, as.at.y), rr = (as.r / 65536) * c.s * 0.55;
        g.lineStyle(Math.max(1, S * 0.15), 0x4fa8ff, 0.7).strokeEllipse(c.x, c.y, rr * 2, rr * 2 * this.view.squash);
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

  private hideActors() {
    for (const s of this.sprites) s.setVisible(false);
    for (const t of this.fxText) t.setVisible(false);
    this.ball.setVisible(false); this.ballShadow.setVisible(false);
  }

  /** LOS and first-down line between plays (from the game state). */
  private drawStateLines() {
    const s = this.ctl.state;
    this.lines.clear();
    if (s.phase !== "play") return;
    const userOff = s.possession === this.ctl.userSide;
    const los = s.ballOn / 65536, fd = (s.ballOn + s.toGo) / 65536;
    const conv = (y: number) => (userOff ? y : 100 - y);
    this.lines.lineStyle(Math.max(2, this.view.S * 0.3), 0x4fa8ff, 0.9);
    this.line(this.lines, 0, conv(los), FIELD_W, conv(los));
    if (fd < 100) { this.lines.lineStyle(Math.max(2, this.view.S * 0.3), 0xffd23e, 0.9); this.line(this.lines, 0, conv(fd), FIELD_W, conv(fd)); }
  }
  private drawLines(cur: PlaySnapshot, flip: boolean) {
    const s = this.ctl.replay ? null : this.ctl.live?.ctx.at ?? this.ctl.state;
    this.lines.clear();
    const los = cur.los / 65536;
    const conv = (y: number) => (flip ? 100 - y : y);
    this.lines.lineStyle(Math.max(2, this.view.S * 0.3), 0x4fa8ff, 0.9);
    this.line(this.lines, 0, conv(los), FIELD_W, conv(los));
    if (s && s.phase === "play") {
      const fd = (s.ballOn + s.toGo) / 65536;
      if (fd < 100) { this.lines.lineStyle(Math.max(2, this.view.S * 0.3), 0xffd23e, 0.9); this.line(this.lines, 0, conv(fd), FIELD_W, conv(fd)); }
    }
  }
}

export type { ActorView };
