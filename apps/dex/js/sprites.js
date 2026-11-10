// Procedural pixel-art sprites in team colors (Retro Bowl-ish chunky players + helmets).
// Every sprite is a string map; each char is a palette key, '.' = transparent.
(function () {
  const PLAYER_BACK = [
    "......kkkk......",
    "....kkHHHHkk....",
    "...kHHHSSHHHk...",
    "...kHHHSSHHHk...",
    "...kHHHSSHHHk...",
    "...kHHHSSHHHk...",
    "....kkHHHHkk....",
    "..kkkkJJJJkkkk..",
    ".kTTJJJJJJJJTTk.",
    "kTTJJJJJJJJJJTTk",
    "kJJkJJJJJJJJkJJk",
    "kJJkJJJJJJJJkJJk",
    "kJJkJJJJJJJJkJJk",
    "kJJkJJJJJJJJkJJk",
    "kGGkJJJJJJJJkGGk",
    ".kk.kPPPPPPk.kk.",
    "....kPPPPPPk....",
    "....kPPkkPPk....",
    "....kOOkkOOk....",
    "....kOOkkOOk....",
    "...kBBBkkBBBk...",
    "...kkkk..kkkk...",
  ];
  // Front view: same body, face mask instead of the helmet stripe.
  const PLAYER_FRONT = PLAYER_BACK.slice();
  PLAYER_FRONT[3] = "...kHVVVVVVHk...";
  PLAYER_FRONT[4] = "...kHMVMMVMHk...";
  PLAYER_FRONT[5] = "...kHMMMMMMHk...";
  PLAYER_FRONT[6] = "....kkMMMMkk....";

  // running frame: legs split
  const runLegs = (map) => {
    const m = map.slice();
    m[17] = "...kPPk..kPPk...";
    m[18] = "..kOOk....kOOk..";
    m[19] = ".kBBBk....kOOk..";
    m[20] = ".kkkk.....kBBBk.";
    m[21] = "...........kkk..";
    return m;
  };
  const PLAYER_BACK_RUN = runLegs(PLAYER_BACK);
  const PLAYER_FRONT_RUN = runLegs(PLAYER_FRONT);

  const HELMET = [
    "...kkkkk....",
    "..kHHHHHkk..",
    ".kHHSSSHHHk.",
    "kHHHHHHHHHHk",
    "kHHHHHHHkkHk",
    "kHHHHHHkMMMk",
    "kHHHHHHkMkMk",
    ".kHHHHHkMMMk",
    "..kkkkkk.kk.",
  ];

  // 3x5 digits for jersey numbers
  const DIGITS = {
    0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"],
    2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "011", "001", "111"],
    4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
    6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"],
    8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
  };

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  function palette(team) {
    const c1 = team.c1, c2 = team.c2;
    // keep the stripe visible even if both team colors are dark
    const stripe = Math.abs(luminance(c1) - luminance(c2)) < 0.18 ? (team.c3 || "#ffffff") : c2;
    return {
      k: "#14141c", H: c1, S: stripe, J: c1, T: stripe, G: "#f2f2f2",
      P: luminance(c1) > 0.75 ? c2 : "#e9e6dc", O: c1, B: "#1d1d24",
      M: "#b9bcc4", V: "#23232b",
      N: luminance(c1) > 0.55 ? "#14141c" : "#ffffff", // jersey number
    };
  }

  function drawMap(ctx, map, pal, x, y, s) {
    for (let r = 0; r < map.length; r++) {
      const row = map[r];
      for (let c = 0; c < row.length; c++) {
        const k = row[c];
        if (k === ".") continue;
        ctx.fillStyle = pal[k];
        ctx.fillRect(x + c * s, y + r * s, s, s);
      }
    }
  }

  function drawNumber(ctx, num, color, x, y, s, top) {
    if (num == null) return;
    const str = String(num);
    const w = str.length * 4 - 1;
    let cx = x + Math.round((16 - w) / 2) * s;
    ctx.fillStyle = color;
    for (const ch of str) {
      const g = DIGITS[ch];
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++)
          if (g[r][c] === "1") ctx.fillRect(cx + c * s, y + (top + r) * s, s, s);
      cx += 4 * s;
    }
  }

  /** Draw a full player sprite (16x22 logical px). facing: 'back' | 'front'; frame 0 stand, 1 run */
  function drawPlayer(ctx, team, num, x, y, s = 1, facing = "back", frame = 0) {
    const pal = palette(team);
    const map = facing === "back" ? (frame ? PLAYER_BACK_RUN : PLAYER_BACK) : (frame ? PLAYER_FRONT_RUN : PLAYER_FRONT);
    drawMap(ctx, map, pal, x, y, s);
    drawNumber(ctx, num, pal.N, x, y, s, 9);
  }

  const spriteCache = new Map();
  /** Cached canvas of a player sprite at scale s. */
  function playerCanvas(team, num, s, facing, frame) {
    const key = [team.abbr, team.c1, num, s, facing, frame].join("|");
    let c = spriteCache.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = 16 * s; c.height = 22 * s;
      drawPlayer(c.getContext("2d"), team, num, 0, 0, s, facing, frame);
      spriteCache.set(key, c);
    }
    return c;
  }

  function drawHelmet(ctx, team, x, y, s = 1) {
    drawMap(ctx, HELMET, palette(team), x, y, s);
  }

  /** A canvas containing a team helmet, for team chips / placeholders. */
  function helmetCanvas(team, s = 3) {
    const c = document.createElement("canvas");
    c.width = 12 * s; c.height = 9 * s;
    drawHelmet(c.getContext("2d"), team, 0, 0, s);
    return c;
  }

  window.Sprites = { drawPlayer, playerCanvas, drawHelmet, helmetCanvas, palette, luminance,
    PLAYER_W: 16, PLAYER_H: 22 };
})();
