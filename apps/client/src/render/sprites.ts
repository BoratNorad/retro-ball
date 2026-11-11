// Chunky pixel-art players and helmets in team colours (carried over from Gridiron Dex).
// Every sprite is a string map; each char is a palette key, '.' = transparent.
export interface TeamColors { abbr: string; c1: string; c2: string; c3: string }

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
const PLAYER_FRONT = PLAYER_BACK.slice();
PLAYER_FRONT[3] = "...kHVVVVVVHk...";
PLAYER_FRONT[4] = "...kHMVMMVMHk...";
PLAYER_FRONT[5] = "...kHMMMMMMHk...";
PLAYER_FRONT[6] = "....kkMMMMkk....";
const runLegs = (map: string[]) => {
  const m = map.slice();
  m[17] = "...kPPk..kPPk...";
  m[18] = "..kOOk....kOOk..";
  m[19] = ".kBBBk....kOOk..";
  m[20] = ".kkkk.....kBBBk.";
  m[21] = "...........kkk..";
  return m;
};
/** Side profile, facing right (the Pro camera; flipped for players facing left). */
const PLAYER_SIDE = [
  "................",
  "......kkkkk.....",
  "....kkHHHHHk....",
  "...kHHHSSSHHk...",
  "...kHHHHHHHMMk..",
  "...kHHHHHHHMVk..",
  "...kHHHHHHHMMk..",
  "....kkHHHHkkk...",
  "....kkJJJJk.....",
  "...kJJJJJJJk....",
  "...kTJJJJJJJk...",
  "...kTJJJJJJGk...",
  "...kTJJJJJJkGk..",
  "...kJJJJJJJk.k..",
  "...kJJJJJJJk....",
  "....kPPPPPk.....",
  "....kPPPPPk.....",
  "....kPPkPPk.....",
  "....kOOkOOk.....",
  "....kOOkOOk.....",
  "...kBBBkBBBk....",
  "...kkkk.kkkk....",
];
const sideRun = (map: string[]) => {
  const m = map.slice();
  m[17] = "...kPPk.kPPk....";
  m[18] = "..kOOk...kOOk...";
  m[19] = ".kOOk.....kOOk..";
  m[20] = ".kBBBk....kBBBk.";
  m[21] = "..kkk......kkk..";
  return m;
};
const MAPS = { back: [PLAYER_BACK, runLegs(PLAYER_BACK)], front: [PLAYER_FRONT, runLegs(PLAYER_FRONT)], side: [PLAYER_SIDE, sideRun(PLAYER_SIDE)] };
const HELMET = [
  "...kkkkk....", "..kHHHHHkk..", ".kHHSSSHHHk.", "kHHHHHHHHHHk", "kHHHHHHHkkHk",
  "kHHHHHHkMMMk", "kHHHHHHkMkMk", ".kHHHHHkMMMk", "..kkkkkk.kk.",
];
const DIGITS: Record<string, string[]> = {
  0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "011", "001", "111"],
  4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
};
export const SPRITE_W = 16, SPRITE_H = 22;

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function palette(t: TeamColors): Record<string, string> {
  const stripe = Math.abs(luminance(t.c1) - luminance(t.c2)) < 0.18 ? (t.c3 || "#ffffff") : t.c2;
  return {
    k: "#14141c", H: t.c1, S: stripe, J: t.c1, T: stripe, G: "#f2f2f2",
    P: luminance(t.c1) > 0.75 ? t.c2 : "#e9e6dc", O: t.c1, B: "#1d1d24", M: "#b9bcc4", V: "#23232b",
    N: luminance(t.c1) > 0.55 ? "#14141c" : "#ffffff",
  };
}

function paint(ctx: CanvasRenderingContext2D, map: string[], pal: Record<string, string>, ox = 0, oy = 0) {
  for (let r = 0; r < map.length; r++) for (let c = 0; c < map[r]!.length; c++) {
    const k = map[r]![c]!;
    if (k === ".") continue;
    ctx.fillStyle = pal[k]!;
    ctx.fillRect(ox + c, oy + r, 1, 1);
  }
}

/** 16x22 player sprite canvas. */
export type Facing = "back" | "front" | "side";
export function playerCanvas(t: TeamColors, num: number | null, facing: Facing, frame: 0 | 1): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = SPRITE_W; cv.height = SPRITE_H;
  const ctx = cv.getContext("2d")!;
  const pal = palette(t);
  paint(ctx, MAPS[facing][frame]!, pal);
  if (num != null) {
    const str = String(num);
    let cx = facing === "side" ? 4 : Math.round((16 - (str.length * 4 - 1)) / 2);
    ctx.fillStyle = pal.N!;
    for (const ch of str) {
      const g = DIGITS[ch]!;
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r]![c] === "1") ctx.fillRect(cx + c, 9 + r, 1, 1);
      cx += 4;
    }
  }
  return cv;
}

/** Helmet icon canvas at integer scale. */
export function helmetCanvas(t: TeamColors, scale = 3): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 12 * scale; cv.height = 9 * scale;
  const ctx = cv.getContext("2d")!;
  ctx.scale(scale, scale);
  paint(ctx, HELMET, palette(t));
  return cv;
}

/** A tileable patch of crowd in the stands (Pro camera backdrop): seat rows and fans in both teams' colours. */
export function crowdCanvas(colors: string[]): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 96; cv.height = 48;
  const ctx = cv.getContext("2d")!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 48; y += 6) { ctx.fillStyle = (y / 6) % 2 ? "#23252f" : "#2b2e3a"; ctx.fillRect(0, y, 96, 6); }
  const skin = ["#f1c9a5", "#c68e63", "#8d5a3b", "#5c3a24"];
  for (let y = 1; y < 48; y += 6) for (let x = 1; x < 96; x += 3) {
    if (rnd() < 0.18) continue;
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)]!;
    ctx.fillRect(x, y + 2, 2, 3);
    ctx.fillStyle = skin[Math.floor(rnd() * skin.length)]!;
    ctx.fillRect(x, y, 2, 2);
  }
  return cv;
}
