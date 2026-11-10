// Turns nflverse headshots into 16-bit pixel-art portraits ("style G").
//
//   face crop (from the photo's silhouette) -> 80x80 -> vibrance/contrast
//   -> 2x edge-preserving smoothing -> 40-colour k-means (luminance-weighted)
//   -> despeckle -> 1px dark silhouette outline
//
// tools/bake_headshots.py runs the same steps in Python for offline use.
//
// Source priority for each player:
//   1. window.DEX_HEADSHOTS[id]  - pre-baked by tools/bake_headshots.py (works offline)
//   2. the player's nflverse headshot URL, converted live in the browser
//   3. a procedural helmet placeholder in team colours
(function () {
  const SIZE = 80;          // logical pixels of a portrait
  const COLORS = 40;        // palette size
  const cache = new Map();  // id -> Promise<HTMLCanvasElement>

  // ---- tiny loader queue so 1900 list rows don't fire 1900 requests at once ----
  const MAX = 6;
  let active = 0;
  const queue = [];
  function enqueue(fn) {
    return new Promise((res, rej) => {
      queue.push(() => fn().then(res, rej).finally(() => { active--; pump(); }));
      pump();
    });
  }
  function pump() {
    while (active < MAX && queue.length) { active++; queue.shift()(); }
  }

  function loadImage(src, cors) {
    return new Promise((res, rej) => {
      const img = new Image();
      if (cors) img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("load failed: " + src));
      img.src = src;
    });
  }

  // ---- 1. face crop ---------------------------------------------------------------
  /**
   * Find a square around the head. Uses the alpha channel when the photo has a transparent
   * background, otherwise treats pixels close to the corner colour as background.
   * Returns [sx, sy, side] in source-image pixels, or null if pixels can't be read.
   */
  function faceBox(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const A = 160, k = A / Math.max(w, h);
    const aw = Math.round(w * k), ah = Math.round(h * k);
    const c = document.createElement("canvas");
    c.width = aw; c.height = ah;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, aw, ah);
    let d;
    try { d = ctx.getImageData(0, 0, aw, ah).data; } catch (e) { return null; }
    const corner = [d[0], d[1], d[2], d[3]];
    const opaqueBg = corner[3] > 200;
    const fg = (i) => {
      if (d[i + 3] < 128) return false;
      if (!opaqueBg) return true;
      return Math.abs(d[i] - corner[0]) + Math.abs(d[i + 1] - corner[1]) + Math.abs(d[i + 2] - corner[2]) > 48;
    };
    const rowW = new Array(ah).fill(0), rowMin = new Array(ah).fill(aw), rowMax = new Array(ah).fill(-1);
    let top = -1, bot = -1;
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      if (!fg((y * aw + x) * 4)) continue;
      rowW[y]++;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (top < 0) top = y;
      bot = y;
    }
    if (top < 0) return null;
    // the head is the silhouette in the top 38%; its typical width sets the crop size
    const headRows = [];
    let lo = aw, hi = -1;
    for (let y = top; y < top + (bot - top) * 0.38; y++) {
      if (!rowW[y]) continue;
      headRows.push(rowW[y]);
      lo = Math.min(lo, rowMin[y]); hi = Math.max(hi, rowMax[y]);
    }
    headRows.sort((a, b) => a - b);
    const headW = headRows[Math.floor(headRows.length * 0.7)] || aw * 0.35;
    const side = headW * 1.75, cx = (lo + hi) / 2, t = top - side * 0.08;
    return [(cx - side / 2) / k, t / k, side / k];
  }

  /** Crop + downscale to SIZE x SIZE (stepping down for a clean average). */
  function cropScale(img, box) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const [sx, sy, side] = box || [(w - Math.min(w, h) * 0.62) / 2, h * 0.02, Math.min(w, h) * 0.62];
    // draw the crop onto a canvas first, padding with transparency if it runs off the photo
    let cur = Math.max(SIZE, Math.round(Math.min(side, 1024)));
    let src = document.createElement("canvas");
    src.width = src.height = cur;
    let sctx = src.getContext("2d");
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(img, sx, sy, side, side, 0, 0, cur, cur);
    while (cur / 2 >= SIZE * 1.5) {
      const nxt = Math.floor(cur / 2);
      const t = document.createElement("canvas");
      t.width = t.height = nxt;
      const tc = t.getContext("2d");
      tc.imageSmoothingQuality = "high";
      tc.drawImage(src, 0, 0, nxt, nxt);
      src = t; cur = nxt;
    }
    const out = document.createElement("canvas");
    out.width = out.height = SIZE;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, SIZE, SIZE);
    return out;
  }

  // ---- 2. pixel-art treatment ------------------------------------------------------
  const LW = [0.299, 0.587, 0.114];

  function enhance(rgb, alpha) {
    for (let p = 0; p < alpha.length; p++) {
      if (!alpha[p]) continue;
      const i = p * 3;
      const l = LW[0] * rgb[i] + LW[1] * rgb[i + 1] + LW[2] * rgb[i + 2];
      for (let c = 0; c < 3; c++) {
        const v = ((l + (rgb[i + c] - l) * 1.12) - 128) * 1.05 + 128;
        rgb[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  /** Edge-preserving 3x3 smoothing: flattens skin noise, keeps eyes/mouth edges. */
  function bilateral(rgb, alpha, sig) {
    const out = rgb.slice(), N = SIZE, s2 = sig * sig;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const p = y * N + x;
      if (!alpha[p]) continue;
      const i = p * 3;
      let wr = 0, wg = 0, wb = 0, ws = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= N || xx >= N) continue;
        const q = yy * N + xx;
        if (!alpha[q]) continue;
        const j = q * 3;
        const d2 = (rgb[j] - rgb[i]) ** 2 + (rgb[j + 1] - rgb[i + 1]) ** 2 + (rgb[j + 2] - rgb[i + 2]) ** 2;
        const wt = Math.exp(-d2 / s2);
        wr += rgb[j] * wt; wg += rgb[j + 1] * wt; wb += rgb[j + 2] * wt; ws += wt;
      }
      out[i] = wr / ws; out[i + 1] = wg / ws; out[i + 2] = wb / ws;
    }
    return out;
  }

  /** k-means in a luminance-weighted space so facial shading keeps more levels. */
  function quantize(rgb, alpha, k) {
    const wt = LW.map((v) => Math.sqrt(v * 3));
    const pts = [];
    for (let p = 0; p < alpha.length; p++) if (alpha[p]) pts.push(p);
    if (!pts.length) return;
    const X = new Float32Array(pts.length * 3);
    pts.forEach((p, n) => { for (let c = 0; c < 3; c++) X[n * 3 + c] = rgb[p * 3 + c] * wt[c]; });
    const lum = pts.map((p, n) => n).sort((a, b) =>
      (X[a * 3] + X[a * 3 + 1] + X[a * 3 + 2]) - (X[b * 3] + X[b * 3 + 1] + X[b * 3 + 2]));
    const C = new Float32Array(k * 3);
    for (let j = 0; j < k; j++) {
      const n = lum[Math.floor((j + 0.5) / k * pts.length)];
      C[j * 3] = X[n * 3]; C[j * 3 + 1] = X[n * 3 + 1]; C[j * 3 + 2] = X[n * 3 + 2];
    }
    const lab = new Int16Array(pts.length);
    for (let iter = 0; iter < 10; iter++) {
      const sum = new Float64Array(k * 4);
      for (let n = 0; n < pts.length; n++) {
        let best = 0, bd = Infinity;
        const x0 = X[n * 3], x1 = X[n * 3 + 1], x2 = X[n * 3 + 2];
        for (let j = 0; j < k; j++) {
          const d = (x0 - C[j * 3]) ** 2 + (x1 - C[j * 3 + 1]) ** 2 + (x2 - C[j * 3 + 2]) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
        lab[n] = best;
        sum[best * 4] += x0; sum[best * 4 + 1] += x1; sum[best * 4 + 2] += x2; sum[best * 4 + 3]++;
      }
      for (let j = 0; j < k; j++) if (sum[j * 4 + 3]) for (let c = 0; c < 3; c++) C[j * 3 + c] = sum[j * 4 + c] / sum[j * 4 + 3];
    }
    pts.forEach((p, n) => { for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round(C[lab[n] * 3 + c] / wt[c]); });
  }

  /** Replace pixels that match none of their 4 neighbours with the most common neighbour colour. */
  function despeckle(rgb, alpha, passes) {
    const N = SIZE;
    const key = (b, p) => (b[p * 3] << 16) | (b[p * 3 + 1] << 8) | b[p * 3 + 2];
    for (let pass = 0; pass < passes; pass++) {
      const src = rgb.slice();
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
        const p = y * N + x;
        if (!alpha[p]) continue;
        const me = key(src, p);
        const nbs = [p + 1, p - 1, p + N, p - N].filter((q) => alpha[q]);
        if (nbs.length < 3) continue;
        const ks = nbs.map((q) => key(src, q));
        if (ks.includes(me)) continue;
        const counts = {};
        let bestK = null, bestC = 0, bestQ = -1;
        ks.forEach((kk, n) => { counts[kk] = (counts[kk] || 0) + 1; if (counts[kk] > bestC) { bestC = counts[kk]; bestK = kk; bestQ = nbs[n]; } });
        if (bestC >= 2) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = src[bestQ * 3 + c];
      }
    }
  }

  function stylize(canvas) {
    const ctx = canvas.getContext("2d");
    let id;
    try { id = ctx.getImageData(0, 0, SIZE, SIZE); } catch (e) { return canvas; } // tainted: pixel grid only
    const d = id.data, n = SIZE * SIZE;
    // background: transparent pixels, or (for opaque photos) the corner colour
    const opaqueBg = d[3] > 200;
    const bg = [d[0], d[1], d[2]];
    const alpha = new Uint8Array(n);
    let rgb = new Float32Array(n * 3);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      let on = d[i + 3] >= 128;
      if (on && opaqueBg) on = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 48;
      alpha[p] = on ? 1 : 0;
      rgb[p * 3] = d[i]; rgb[p * 3 + 1] = d[i + 1]; rgb[p * 3 + 2] = d[i + 2];
    }
    enhance(rgb, alpha);
    rgb = bilateral(rgb, alpha, 18);
    rgb = bilateral(rgb, alpha, 22);
    const q = new Uint8ClampedArray(rgb);
    quantize(q, alpha, COLORS);
    despeckle(q, alpha, 2);
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      d[i] = q[p * 3]; d[i + 1] = q[p * 3 + 1]; d[i + 2] = q[p * 3 + 2]; d[i + 3] = alpha[p] ? 255 : 0;
    }
    // 1px dark outline around the silhouette
    const N = SIZE;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const p = y * N + x;
      if (alpha[p]) continue;
      if ((x > 0 && alpha[p - 1]) || (x < N - 1 && alpha[p + 1]) || (y > 0 && alpha[p - N]) || (y < N - 1 && alpha[p + N])) {
        const i = p * 4; d[i] = 18; d[i + 1] = 18; d[i + 2] = 26; d[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  function placeholder(player, team) {
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    Sprites.drawHelmet(c.getContext("2d"), team, 10, 18, 5);
    c.dataset.placeholder = "1";
    return c;
  }

  async function build(player, team) {
    const baked = window.DEX_HEADSHOTS && window.DEX_HEADSHOTS[player.id];
    if (baked) {
      const img = await loadImage(baked, false);
      const c = document.createElement("canvas");
      c.width = c.height = SIZE;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      return c;
    }
    if (!player.headshot) return placeholder(player, team);
    return enqueue(async () => {
      try {
        // with CORS we can read pixels: face crop + full 16-bit treatment
        const img = await loadImage(player.headshot, true);
        return stylize(cropScale(img, faceBox(img)));
      } catch (e) {
        try {
          // no CORS headers: we can still crop roughly and drop onto the pixel grid
          return cropScale(await loadImage(player.headshot, false), null);
        } catch (e2) {
          return placeholder(player, team);
        }
      }
    });
  }

  /** Returns a Promise of a SIZE x SIZE canvas. */
  function get(player, team) {
    if (!cache.has(player.id)) cache.set(player.id, build(player, team));
    return cache.get(player.id);
  }

  /** Draw a portrait into a target canvas. */
  async function paint(target, player, team) {
    const src = await get(player, team);
    const ctx = target.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(src, 0, 0, target.width, target.height);
    target.classList.toggle("is-placeholder", !!src.dataset.placeholder);
  }

  window.Portrait = { get, paint, SIZE, _stylize: stylize, _cropScale: cropScale, _faceBox: faceBox };
})();
