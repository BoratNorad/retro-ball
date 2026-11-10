// Pretend-play animations that show an ability in action.
// One mini-play per ability *type* (deep pass, juke, sack, pick...). The clicked player is the
// hero, drawn in his own team's colours and number. The ability fires at the play's "key" moment:
// the momentum meter drains, time slows, and the badge and call-out pop over him.
(function () {
  const W = 256, H = 176, LOS = 108;

  // path helper: [[t,x,y],...]
  const at = (path, t) => {
    if (t <= path[0][0]) return [path[0][1], path[0][2]];
    for (let i = 1; i < path.length; i++) {
      const [t1, x1, y1] = path[i];
      if (t <= t1) {
        const [t0, x0, y0] = path[i - 1];
        const u = (t - t0) / Math.max(1e-6, t1 - t0);
        return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u];
      }
    }
    const l = path[path.length - 1];
    return [l[1], l[2]];
  };

  // shared bits
  const shiftLine = (L, dx) => {
    if (dx) for (const a of Object.values(L)) a.path = a.path.map(([t, x, y]) => [t, x + dx, y]);
    return L;
  };
  const LINE = (dx = 0) => shiftLine({
    ol: { side: "O", num: 66, path: [[0, 128, 114], [1, 128, 116]] },
    ol2: { side: "O", num: 72, path: [[0, 108, 114], [1, 107, 117]] },
    ol3: { side: "O", num: 77, path: [[0, 148, 114], [1, 149, 117]] },
    dl: { side: "D", num: 93, path: [[0, 128, 99], [0.4, 128, 103], [1, 128, 104]], shake: [0.2, 1] },
    dl2: { side: "D", num: 97, path: [[0, 108, 99], [1, 109, 104]], shake: [0.2, 1] },
    dl3: { side: "D", num: 90, path: [[0, 148, 99], [1, 147, 104]], shake: [0.2, 1] },
  }, dx);
  const QB_DROP = (deep = 140) => ({ side: "O", num: 12, path: [[0, 128, 128], [0.18, 128, deep], [1, 128, deep]] });
  const RB_HANDOFF = (pts) => ({ side: "O", num: 28, path: [[0, 128, 146], [0.12, 128, 132], ...pts] });

  const DEMOS = {
    deep_pass: (m) => ({
      keys: { qb: 0.36, wr: 0.22 },
      actors: {
        ...LINE(), qb: QB_DROP(),
        wr: { side: "O", num: 11, path: [[0, 50, 114], [0.2, 50, 90], [0.8, 64, 26], [1, 66, 14]] },
        db: { side: "D", num: 24, path: [[0, 50, 86], [0.3, 52, 70], [0.8, 72, 34], [1, 74, 30]] },
      },
      ball: [{ t0: 0, t1: 0.38, hold: "qb" }, { t0: 0.38, t1: 0.8, from: "qb", to: "wr", h: 50 }, { t0: 0.8, t1: 1, hold: "wr" }],
      events: [{ t: 0.8, text: "CATCH!", at: "wr" }, { t: 0.95, text: "TOUCHDOWN!", big: true }],
    }),
    quick_pass: () => ({
      keys: { qb: 0.27, wr: 0.18 },
      actors: {
        ...LINE(), qb: QB_DROP(134),
        wr: { side: "O", num: 81, path: [[0, 70, 114], [0.2, 70, 98], [0.45, 104, 80], [1, 150, 40]] },
        db: { side: "D", num: 31, path: [[0, 70, 90], [0.3, 78, 88], [0.5, 98, 86], [1, 138, 56]] },
      },
      ball: [{ t0: 0, t1: 0.3, hold: "qb" }, { t0: 0.3, t1: 0.48, from: "qb", to: "wr", h: 12 }, { t0: 0.48, t1: 1, hold: "wr" }],
      events: [{ t: 0.48, text: "COMPLETE", at: "wr" }, { t: 0.85, text: "+22 YDS", big: true }],
    }),
    scramble: () => ({
      keys: { qb: 0.24 },
      actors: {
        ...LINE(),
        qb: { side: "O", num: 7, path: [[0, 128, 128], [0.15, 128, 136], [0.25, 128, 137], [0.55, 182, 132], [0.7, 196, 122], [1, 198, 120]] },
        dl: { side: "D", num: 99, path: [[0, 128, 99], [0.2, 122, 118], [0.33, 128, 134], [0.52, 148, 138], [0.58, 154, 140]], fall: 0.56 },
        wr: { side: "O", num: 84, path: [[0, 222, 114], [0.3, 220, 84], [0.75, 206, 54], [1, 200, 40]] },
        db: { side: "D", num: 22, path: [[0, 222, 90], [0.4, 216, 74], [1, 208, 58]] },
      },
      ball: [{ t0: 0, t1: 0.72, hold: "qb" }, { t0: 0.72, t1: 0.88, from: "qb", to: "wr", h: 18 }, { t0: 0.88, t1: 1, hold: "wr" }],
      events: [{ t: 0.57, text: "WHIFF!", at: "dl" }, { t: 0.9, text: "ON THE RUN!", big: true }],
    }),
    pass_pro: () => {
      const L = LINE();
      L.ol.path = [[0, 128, 114], [0.25, 128, 118], [1, 128, 120]];
      L.dl.path = [[0, 128, 99], [0.25, 128, 108], [1, 128, 110]];
      L.dl2.path = [[0, 108, 99], [0.3, 106, 108], [1, 106, 110]];
      L.dl3.path = [[0, 148, 99], [0.3, 150, 108], [1, 150, 110]];
      return {
        keys: { ol: 0.22, qb: 0.04 },
        actors: {
          ...L, qb: QB_DROP(142),
          wr: { side: "O", num: 13, path: [[0, 60, 114], [0.3, 60, 76], [0.6, 92, 56], [1, 112, 40]] },
          db: { side: "D", num: 26, path: [[0, 60, 88], [0.35, 64, 72], [0.65, 90, 62], [1, 106, 50]] },
        },
        ball: [{ t0: 0, t1: 0.62, hold: "qb" }, { t0: 0.62, t1: 0.84, from: "qb", to: "wr", h: 28 }, { t0: 0.84, t1: 1, hold: "wr" }],
        events: [{ t: 0.5, text: "CLEAN POCKET", at: "qb" }, { t: 0.86, text: "COMPLETE", big: true }],
      };
    },
    juke: () => ({
      keys: { rb: 0.42 },
      actors: {
        ...LINE(-11), qb: QB_DROP(132),
        rb: RB_HANDOFF([[0.3, 128, 98], [0.42, 128, 82], [0.5, 112, 74], [1, 104, 14]]),
        lb: { side: "D", num: 54, path: [[0, 128, 50], [0.4, 128, 70], [0.5, 138, 76], [0.6, 142, 80]], fall: 0.52 },
        db: { side: "D", num: 21, path: [[0, 196, 40], [0.5, 162, 40], [1, 128, 26]] },
      },
      ball: [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
      events: [{ t: 0.53, burst: "lb" }, { t: 0.9, text: "BREAKAWAY!", big: true }],
    }),
    spin: () => ({
      keys: { rb: 0.4 },
      actors: {
        ...LINE(-11), qb: QB_DROP(132),
        rb: { ...RB_HANDOFF([[0.3, 128, 98], [0.42, 128, 82], [0.52, 124, 70], [1, 120, 14]]), spin: [0.42, 0.52] },
        lb: { side: "D", num: 52, path: [[0, 128, 50], [0.42, 128, 68], [0.5, 136, 76], [0.56, 142, 80]], fall: 0.5 },
        db: { side: "D", num: 29, path: [[0, 70, 40], [0.5, 100, 44], [1, 112, 26]] },
      },
      ball: [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
      events: [{ t: 0.5, burst: "lb" }, { t: 0.9, text: "+31 YDS", big: true }],
    }),
    truck: () => ({
      keys: { rb: 0.36 },
      actors: {
        ...LINE(-11), qb: QB_DROP(132),
        rb: RB_HANDOFF([[0.3, 128, 98], [0.45, 128, 80], [0.52, 128, 76], [1, 128, 16]]),
        lb: { side: "D", num: 55, path: [[0, 128, 46], [0.45, 128, 70], [0.55, 134, 60], [0.6, 136, 58]], fall: 0.5 },
      },
      ball: [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
      events: [{ t: 0.46, burst: "lb", shake: true }, { t: 0.9, text: "RUN OVER!", big: true }],
    }),
    stiff_arm: () => ({
      keys: { rb: 0.4 },
      actors: {
        ...LINE(-11), qb: QB_DROP(132),
        rb: RB_HANDOFF([[0.3, 128, 98], [0.45, 126, 80], [1, 118, 14]]),
        lb: { side: "D", num: 47, path: [[0, 186, 56], [0.45, 138, 78], [0.52, 152, 84], [0.58, 160, 86]], fall: 0.52 },
      },
      ball: [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
      events: [{ t: 0.46, burst: "lb" }, { t: 0.9, text: "STIFFED!", big: true }],
    }),
    speed_burst: () => ({
      keys: { rb: 0.38 },
      actors: {
        ...LINE(-11), qb: QB_DROP(132),
        rb: { ...RB_HANDOFF([[0.3, 128, 100], [0.45, 128, 80], [1, 128, 4]]), lines: true },
        lb: { side: "D", num: 51, path: [[0, 98, 60], [0.45, 116, 74], [0.75, 122, 58], [1, 124, 50]] },
        db: { side: "D", num: 32, path: [[0, 172, 40], [0.5, 146, 40], [1, 136, 28]] },
      },
      ball: [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
      events: [{ t: 0.92, text: "GONE!", big: true }],
    }),
    catch_contested: () => ({
      keys: { wr: 0.7 },
      actors: {
        ...LINE(), qb: QB_DROP(),
        wr: { side: "O", num: 88, path: [[0, 40, 114], [0.25, 40, 80], [0.78, 42, 34], [1, 42, 28]], jump: [0.72, 0.86] },
        db: { side: "D", num: 23, path: [[0, 48, 88], [0.3, 48, 74], [0.78, 50, 36], [1, 54, 34]], jump: [0.74, 0.86], fall: 0.88 },
      },
      ball: [{ t0: 0, t1: 0.36, hold: "qb" }, { t0: 0.36, t1: 0.8, from: "qb", to: "wr", h: 60 }, { t0: 0.8, t1: 1, hold: "wr" }],
      events: [{ t: 0.82, text: "MOSSED!", at: "wr" }, { t: 0.95, text: "CAUGHT!", big: true }],
    }),
    block_pancake: () => {
      const L = LINE();
      L.ol.path = [[0, 128, 114], [0.3, 128, 104], [0.4, 128, 98], [1, 128, 94]];
      L.dl = { side: "D", num: 94, path: [[0, 128, 99], [0.3, 128, 92], [0.38, 128, 86], [0.42, 130, 82]], fall: 0.4 };
      return {
        keys: { ol: 0.28 },
        actors: {
          ...L, qb: QB_DROP(130),
          rb: RB_HANDOFF([[0.3, 134, 112], [0.45, 142, 94], [1, 142, 18]]),
          lb: { side: "D", num: 50, path: [[0, 128, 56], [0.5, 134, 70], [0.7, 146, 64], [1, 146, 48]] },
        },
        ball: [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
        events: [{ t: 0.41, burst: "dl", shake: true }, { t: 0.9, text: "HUGE HOLE!", big: true }],
      };
    },
    sack: (m) => {
      const L = LINE();
      L.dl = { side: "D", num: 97, path: [[0, 128, 99], [0.22, 128, 110], [0.3, 120, 118], [0.5, 126, 136], [0.56, 128, 140]] };
      L.ol = { side: "O", num: 74, path: [[0, 128, 114], [0.22, 128, 114], [0.34, 136, 120]], fall: 0.34 };
      return {
        keys: { dl: 0.22 },
        actors: {
          ...L, qb: { side: "O", num: 9, path: [[0, 128, 128], [0.2, 128, 140], [0.5, 128, 142], [0.56, 130, 144]], fall: 0.56 },
          wr: { side: "O", num: 80, path: [[0, 60, 114], [0.5, 60, 70], [1, 70, 50]] },
          db: { side: "D", num: 25, path: [[0, 60, 88], [0.5, 62, 68], [1, 70, 52]] },
        },
        ball: m === "fumble"
          ? [{ t0: 0, t1: 0.56, hold: "qb" }, { t0: 0.56, t1: 0.72, from: "qb", to: [156, 150], h: 12 }, { t0: 0.72, t1: 1, loose: [156, 150] }]
          : [{ t0: 0, t1: 1, hold: "qb" }],
        events: [{ t: 0.56, burst: "qb", shake: true, text: m === "fumble" ? "FUMBLE!" : "SACK!", at: "qb" },
          { t: 0.9, text: m === "fumble" ? "TURNOVER!" : "-9 YDS", big: true }],
      };
    },
    tackle_hit: (m) => ({
      keys: { lb: 0.4 },
      actors: {
        ...LINE(-11), qb: QB_DROP(132),
        rb: RB_HANDOFF([[0.3, 130, 104], [0.5, 134, 82], [0.56, 136, 80]]),
        lb: { side: "D", num: 58, path: [[0, 100, 52], [0.5, 132, 76], [0.58, 136, 80]] },
      },
      ball: m === "fumble"
        ? [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 0.52, hold: "rb" }, { t0: 0.52, t1: 0.7, from: "rb", to: [164, 70], h: 18 }, { t0: 0.7, t1: 1, loose: [164, 70] }]
        : [{ t0: 0, t1: 0.12, hold: "qb" }, { t0: 0.12, t1: 1, hold: "rb" }],
      fallRb: 0.53,
      events: [{ t: 0.52, burst: "rb", shake: true, text: m === "fumble" ? "FUMBLE!" : "STUFFED!", at: "rb" },
        { t: 0.9, text: m === "fumble" ? "TURNOVER!" : "NO GAIN", big: true }],
    }),
    interception: () => ({
      keys: { db: 0.34 },
      actors: {
        ...LINE(), qb: QB_DROP(138),
        wr: { side: "O", num: 17, path: [[0, 70, 114], [0.2, 70, 96], [0.55, 110, 74], [1, 116, 80]] },
        db: { side: "D", num: 20, path: [[0, 96, 62], [0.35, 100, 66], [0.55, 108, 76], [1, 92, 172]] },
      },
      ball: [{ t0: 0, t1: 0.32, hold: "qb" }, { t0: 0.32, t1: 0.55, from: "qb", to: "db", h: 16 }, { t0: 0.55, t1: 1, hold: "db" }],
      events: [{ t: 0.56, text: "PICKED!", at: "db" }, { t: 0.92, text: "PICK SIX!", big: true }],
    }),
    lockdown: () => ({
      keys: { db: 0.58 },
      actors: {
        ...LINE(), qb: QB_DROP(),
        wr: { side: "O", num: 85, path: [[0, 60, 114], [0.25, 60, 84], [0.5, 72, 62], [0.75, 80, 46], [1, 82, 40]] },
        db: { side: "D", num: 39, path: [[0, 60, 90], [0.25, 62, 76], [0.5, 74, 58], [0.75, 82, 42], [1, 84, 38]], jump: [0.68, 0.8] },
      },
      ball: [{ t0: 0, t1: 0.4, hold: "qb" }, { t0: 0.4, t1: 0.74, from: "qb", to: [82, 44], h: 30 },
        { t0: 0.74, t1: 0.9, from: [82, 44], to: [112, 30], h: 14 }, { t0: 0.9, t1: 1, loose: [112, 30] }],
      events: [{ t: 0.75, burst: [82, 44], text: "SWATTED!", at: "db" }, { t: 0.92, text: "INCOMPLETE", big: true }],
    }),
    kick: () => ({
      posts: true,
      keys: { k: 0.24, ls: 0.03 },
      actors: {
        ...LINE(),
        ls: { side: "O", num: 46, path: [[0, 128, 114], [1, 128, 116]] },
        h: { side: "O", num: 4, path: [[0, 124, 140], [1, 124, 140]] },
        k: { side: "O", num: 3, path: [[0, 140, 156], [0.25, 130, 146], [0.32, 128, 142], [1, 128, 142]] },
      },
      ball: [{ t0: 0, t1: 0.06, hold: "ls" }, { t0: 0.06, t1: 0.18, from: "ls", to: "h", h: 3 }, { t0: 0.18, t1: 0.3, hold: "h" },
        { t0: 0.3, t1: 0.86, from: "h", to: [128, 8], h: 70 }],
      events: [{ t: 0.86, text: "IT'S GOOD!", big: true }],
    }),
    punt: () => ({
      goal: true,
      keys: { k: 0.24, gunner: 0.1 },
      actors: {
        ...LINE(),
        ls: { side: "O", num: 48, path: [[0, 128, 114], [1, 128, 116]] },
        k: { side: "O", num: 8, path: [[0, 128, 160], [0.24, 128, 154], [1, 128, 154]] },
        gunner: { side: "O", num: 18, path: [[0, 30, 114], [0.82, 44, 32], [1, 46, 30]] },
        pr: { side: "D", num: 15, path: [[0, 66, 34], [0.8, 58, 30], [1, 56, 30]] },
      },
      ball: [{ t0: 0, t1: 0.06, hold: "ls" }, { t0: 0.06, t1: 0.2, from: "ls", to: "k", h: 4 }, { t0: 0.2, t1: 0.27, hold: "k" },
        { t0: 0.27, t1: 0.8, from: "k", to: [46, 22], h: 90 }, { t0: 0.8, t1: 1, loose: [46, 22] }],
      events: [{ t: 0.86, text: "DOWNED AT THE 3!", big: true }],
    }),
    return: () => ({
      keys: { kr: 0.28 },
      actors: {
        kr: { side: "O", num: 82, lines: true, path: [[0, 128, 160], [0.2, 128, 158], [0.4, 110, 120], [0.55, 150, 90], [0.75, 140, 50], [1, 136, 0]] },
        b1: { side: "O", num: 41, path: [[0, 100, 130], [0.4, 108, 108], [1, 108, 104]] },
        b2: { side: "O", num: 45, path: [[0, 160, 128], [0.5, 156, 100], [1, 156, 96]] },
        d1: { side: "D", num: 57, path: [[0, 110, 30], [0.4, 112, 112], [0.46, 116, 118]], fall: 0.43 },
        d2: { side: "D", num: 36, path: [[0, 170, 20], [0.55, 146, 86], [0.6, 140, 88]], fall: 0.58 },
        d3: { side: "D", num: 27, path: [[0, 96, 10], [0.7, 148, 52], [0.76, 154, 54]], fall: 0.74 },
      },
      ball: [{ t0: 0, t1: 0.2, from: [128, -10], to: "kr", h: 40 }, { t0: 0.2, t1: 1, hold: "kr" }],
      events: [{ t: 0.43, burst: "d1" }, { t: 0.58, burst: "d2" }, { t: 0.74, burst: "d3" }, { t: 0.96, text: "TOUCHDOWN!", big: true }],
    }),
  };

  const SIZES = { dur: 3.6, pause: 1.4 };

  function textOut(ctx, str, x, y, size, color, s) {
    ctx.font = `${size * s}px "Press Start 2P", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#14141c";
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, 1], [1, -1], [-1, -1]])
      ctx.fillText(str, x * s + dx * s * 0.8, y * s + dy * s * 0.8);
    ctx.fillStyle = color;
    ctx.fillText(str, x * s, y * s);
  }

  /**
   * Mount a looping demo on a canvas.
   * opts: { ability, player, team, opp, scale }
   */
  function mount(canvas, opts) {
    const s = opts.scale || 3;
    canvas.width = W * s; canvas.height = H * s;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const ab = opts.ability;
    const spec = (DEMOS[ab.demo] || DEMOS.quick_pass)(ab.mod);
    const heroName = spec.actors[ab.role] ? ab.role : Object.keys(spec.keys)[0];
    const hero = spec.actors[heroName];
    hero.num = opts.player.num ?? hero.num;
    hero.hero = true;
    if (spec.fallRb && heroName !== "rb") spec.actors.rb.fall = spec.fallRb;
    else if (spec.fallRb && heroName === "rb") { /* hero RB doesn't go down in his own demo */ }
    const key = spec.keys[heroName] ?? 0.3;
    const heroTeamSide = hero.side;
    const teamFor = (side) => (side === heroTeamSide ? opts.team : opts.opp);
    const passive = ab.kind === "P";
    const badge = Abilities.badgeCanvas(ab, s);
    const particles = [];

    let raf = 0, last = 0, clock = 0, t = 0, phase = "play", pauseT = 0, flash = 0, firedKey = false;
    const fired = new Set();

    function actorPos(a, tt) { return at(a.path, tt); }

    function drawField() {
      for (let i = 0; i < H / 11; i++) {
        ctx.fillStyle = i % 2 ? "#3b8f3e" : "#348238";
        ctx.fillRect(0, i * 11 * s, W * s, 11 * s);
      }
      ctx.fillStyle = "#ffffff40";
      for (let y = LOS + 4 - 88; y < H; y += 22) ctx.fillRect(0, y * s, W * s, s);
      for (let y = 2; y < H; y += 4.4) { ctx.fillRect(92 * s, y * s, 3 * s, s); ctx.fillRect(161 * s, y * s, 3 * s, s); }
      ctx.fillStyle = "#4fa8ff"; ctx.fillRect(0, (LOS + 4) * s, W * s, s);
      if (spec.posts || spec.goal) {
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 12 * s, W * s, s * 2);
        ctx.fillStyle = "#2a6f8f"; ctx.fillRect(0, 0, W * s, 12 * s);
      }
      if (spec.posts) {
        ctx.fillStyle = "#ffd23e";
        ctx.fillRect(108 * s, 2 * s, 2 * s, 12 * s); ctx.fillRect(146 * s, 2 * s, 2 * s, 12 * s);
        ctx.fillRect(108 * s, 12 * s, 40 * s, 2 * s); ctx.fillRect(127 * s, 12 * s, 2 * s, 10 * s);
      }
    }

    function drawBall(x, y, z) {
      ctx.fillStyle = "#0005"; ctx.fillRect((x - 2) * s, (y + 1) * s, 4 * s, 2 * s);
      const by = y - z;
      ctx.fillStyle = "#14141c"; ctx.fillRect((x - 3) * s, (by - 1) * s, 6 * s, 3 * s);
      ctx.fillStyle = "#8a4b22"; ctx.fillRect((x - 2) * s, (by - 1) * s, 4 * s, 3 * s);
      ctx.fillStyle = "#fff"; ctx.fillRect((x - 1) * s, by * s, 2 * s, s);
    }

    function ballPos(tt) {
      for (const seg of spec.ball) {
        if (tt < seg.t0 || tt > seg.t1) continue;
        if (seg.hold) { const [x, y] = actorPos(spec.actors[seg.hold], tt); return [x + 5, y - 2, 6]; }
        if (seg.loose) { const k = (tt - seg.t0) / (seg.t1 - seg.t0); return [seg.loose[0] + k * 4, seg.loose[1], Math.abs(Math.sin(k * 9)) * 4 * (1 - k)]; }
        const P = (e, tq) => (Array.isArray(e) ? e : actorPos(spec.actors[e], tq));
        const [x0, y0] = P(seg.from, seg.t0), [x1, y1] = P(seg.to, seg.t1);
        const u = (tt - seg.t0) / (seg.t1 - seg.t0);
        return [x0 + 5 + (x1 - x0) * u, y0 - 2 + (y1 - y0) * u, 6 + 4 * seg.h * u * (1 - u)];
      }
      return null;
    }

    function drawActor(name, a, tt) {
      const [x, y] = actorPos(a, tt);
      const [x2, y2] = actorPos(a, Math.min(1, tt + 0.01));
      const moving = Math.hypot(x2 - x, y2 - y) > 0.05;
      const team = teamFor(a.side);
      const facing = a.side === "O" ? "back" : "front";
      const frame = moving && a.fall == null || (moving && tt < a.fall) ? Math.floor(clock * 8) % 2 : 0;
      const spr = Sprites.playerCanvas(team, a.num, s, facing, frame);
      let jx = 0, jy = 0;
      if (a.shake && tt > a.shake[0] && tt < a.shake[1]) jx = Math.round(Math.sin(clock * 50)) * 0.6;
      if (a.jump && tt > a.jump[0] && tt < a.jump[1]) jy = -Math.sin((tt - a.jump[0]) / (a.jump[1] - a.jump[0]) * Math.PI) * 12;
      // shadow
      ctx.fillStyle = "#0004";
      ctx.fillRect((x - 6) * s, (y + 9) * s, 12 * s, 3 * s);
      // speed lines
      if (a.hero && a.lines && tt > key) {
        ctx.fillStyle = "#ffffffaa";
        for (let i = 0; i < 4; i++) ctx.fillRect((x - 6 + i * 4) * s, (y + 12 + ((clock * 60 + i * 5) % 12)) * s, s, 4 * s);
      }
      // hero aura
      const auraOn = a.hero && (passive || tt >= key);
      if (auraOn) {
        const r = 13 + Math.sin(clock * 10) * 1.5;
        ctx.fillStyle = ab.light + "88";
        for (let i = 0; i < 28; i++) {
          const ang = (i / 28) * Math.PI * 2 + clock * 2;
          ctx.fillRect(Math.round(x + Math.cos(ang) * r) * s, Math.round(y + jy + Math.sin(ang) * r * 0.9) * s, s * 2, s * 2);
        }
      }
      ctx.save();
      ctx.translate((x + jx) * s, (y + jy) * s);
      if (a.fall != null && tt >= a.fall) {
        ctx.translate(0, 6 * s);
        ctx.rotate((name.length % 2 ? 1 : -1) * Math.PI / 2);
      } else if (a.spin && tt > a.spin[0] && tt < a.spin[1]) {
        ctx.rotate((tt - a.spin[0]) / (a.spin[1] - a.spin[0]) * Math.PI * 2);
      }
      ctx.drawImage(spr, -8 * s, -11 * s);
      ctx.restore();
      if (a.hero && tt < 0.16 && phase === "play") {
        // "this is him" marker at the snap
        const bob = Math.round(Math.sin(clock * 8));
        ctx.fillStyle = "#ffd23e";
        for (let i = 0; i < 4; i++) ctx.fillRect((x - 3 + i) * s, (y - 19 + i + bob) * s, (7 - i * 2) * s, s);
      }
    }

    function burst(x, y, color) {
      for (let i = 0; i < 14; i++) {
        const ang = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 40;
        particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0.5 + Math.random() * 0.3, c: color || (i % 2 ? "#fff" : "#ffd23e") });
      }
    }

    function drawHUD(tt) {
      // momentum meter
      const bx = 6, by = 6;
      ctx.fillStyle = "#14141ccc"; ctx.fillRect(bx * s, by * s, 74 * s, 14 * s);
      ctx.font = `${5 * s}px "Press Start 2P", monospace`; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = "#fff"; ctx.fillText(passive ? "PASSIVE" : "MOMENTUM", (bx + 3) * s, (by + 2) * s);
      if (passive) {
        ctx.fillStyle = ab.light; ctx.fillText("ALWAYS ON", (bx + 3) * s, (by + 8) * s);
      } else {
        const cost = ab.cost;
        const drain = firedKey ? Math.min(1, (tt - key) / 0.08) : 0;
        for (let i = 0; i < 3; i++) {
          const spent = i >= 3 - cost;
          const full = !spent || drain < 1;
          const x = bx + 3 + i * 23, y = by + 8;
          ctx.fillStyle = "#3a3a48"; ctx.fillRect(x * s, y * s, 21 * s, 4 * s);
          if (full) {
            ctx.fillStyle = spent && firedKey ? (Math.floor(clock * 12) % 2 ? "#fff" : ab.color) : (ab.kind === "S" ? "#ffd23e" : "#4fd0ff");
            const w = spent && firedKey ? 21 * (1 - drain) : 21;
            ctx.fillRect(x * s, y * s, Math.max(0, w) * s, 4 * s);
          }
        }
      }
      // badge + name, top right
      ctx.drawImage(badge, (W - 26) * s, 4 * s, 20 * s, 20 * s);
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      clock += dt;
      if (phase === "play") {
        // slow-mo around the activation
        const near = !passive && Math.abs(t - key) < 0.06;
        t += (dt / SIZES.dur) * (near ? 0.3 : 1);
        if (t >= 1) { t = 1; phase = "pause"; pauseT = 0; }
      } else {
        pauseT += dt;
        if (pauseT > SIZES.pause) { t = 0; phase = "play"; fired.clear(); firedKey = false; particles.length = 0; }
      }
      if (!firedKey && t >= key) {
        firedKey = true;
        flash = passive ? 0 : 0.25;
        const [hx, hy] = actorPos(hero, t);
        if (!passive) burst(hx, hy, ab.light);
      }
      spec.events.forEach((e, i) => {
        if (fired.has(i) || t < e.t) return;
        fired.add(i);
        if (e.burst) {
          const [x, y] = Array.isArray(e.burst) ? e.burst : actorPos(spec.actors[e.burst], e.t);
          burst(x, y);
        }
        if (e.shake) flash = Math.max(flash, 0.12);
      });

      ctx.save();
      if (flash > 0 && flash > 0.1) ctx.translate(Math.round(Math.sin(clock * 90) * 2) * s, 0);
      drawField();
      // sort by y so lower sprites overlap higher ones
      const order = Object.entries(spec.actors).sort((a, b) => actorPos(a[1], t)[1] - actorPos(b[1], t)[1]);
      for (const [n, a] of order) drawActor(n, a, t);
      const bp = ballPos(t);
      if (bp) drawBall(bp[0], bp[1], bp[2]);
      // particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        ctx.fillStyle = p.c; ctx.fillRect(Math.round(p.x) * s, Math.round(p.y) * s, 2 * s, 2 * s);
      }
      ctx.restore();

      // call-outs
      if (t >= key || passive) {
        const k = passive ? Math.min(1, t / 0.15) : Math.min(1, (t - key) / 0.05);
        const [hx, hy] = actorPos(hero, Math.min(t, 1));
        const lift = passive ? 0 : Math.min(14, (t - key) * 60);
        if (k > 0 && (passive ? t < 0.5 : t - key < 0.35)) {
          const bx = Math.min(W - 14, Math.max(14, hx));
          ctx.globalAlpha = Math.min(1, k * 2);
          ctx.drawImage(badge, (bx - 10) * s, (hy - 44 - lift) * s, 20 * s, 20 * s);
          textOut(ctx, ab.fx, Math.min(W - ab.fx.length * 3.5 - 4, Math.max(ab.fx.length * 3.5 + 4, hx)), hy - 18 - lift, 7, ab.light, s);
          ctx.globalAlpha = 1;
        }
      }
      spec.events.forEach((e) => {
        if (!e.text || t < e.t || t > e.t + (e.big ? 1 : 0.22)) return;
        if (e.big) textOut(ctx, e.text, W / 2, H / 2 - 10, 11, "#ffd23e", s);
        else {
          const [x, y] = actorPos(spec.actors[e.at] || hero, e.t);
          textOut(ctx, e.text, Math.min(W - 40, Math.max(40, x)), y - 16, 6, "#ffffff", s);
        }
      });
      if (flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(0.6, flash * 2)})`;
        ctx.fillRect(0, 0, W * s, H * s);
        flash -= dt;
      }
      drawHUD(t);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return {
      stop() { cancelAnimationFrame(raf); },
      replay() { t = 0; phase = "play"; fired.clear(); firedKey = false; particles.length = 0; },
    };
  }

  window.Plays = { mount, DEMOS: Object.keys(DEMOS) };
})();
