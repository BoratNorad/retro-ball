#!/usr/bin/env python3
"""Pre-bake pixel-art headshots from nflverse so the dex works offline.

Downloads every player's nflverse headshot, converts it into a small
16-bit pixel portrait (80x80, 40 colours, face-cropped) and writes js/headshots.js, which maps
Madden player id -> PNG data URI. index.html loads it automatically if
present; without it the browser pixelates headshots live instead.

Usage:
    python3 tools/bake_headshots.py                 # all players
    python3 tools/bake_headshots.py --team BUF      # just one team
    python3 tools/bake_headshots.py --size 80 --colors 40

Requires: Pillow, numpy   (pip install pillow numpy)
"""
import argparse
import base64
import io
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data/headshot_cache"


def load_data():
    txt = (ROOT / "js/data.js").read_text(encoding="utf-8")
    return json.loads(txt[txt.index("{"): txt.rindex("}") + 1])


def fetch(url, dest):
    if dest.exists():
        return dest.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "gridiron-dex/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    dest.write_bytes(data)
    return data


LW = np.array([0.299, 0.587, 0.114])


def _mask(arr):
    """Foreground mask: alpha, or (opaque photos) pixels that differ from the corner colour."""
    alpha = arr[..., 3] >= 128
    if arr[0, 0, 3] > 200:
        bg = arr[0, 0, :3].astype(int)
        alpha &= np.abs(arr[..., :3].astype(int) - bg).sum(-1) > 48
    return alpha


def face_crop(im):
    """Square crop around the head, found from the top of the silhouette."""
    a = _mask(np.array(im))
    ys, xs = np.nonzero(a)
    if not len(ys):
        w, h = im.size
        side = min(w, h) * 0.62
        return im.crop((int((w - side) / 2), int(h * 0.02), int((w + side) / 2), int(h * 0.02 + side)))
    top, bot = ys.min(), ys.max()
    head = a[top: top + max(1, int((bot - top) * 0.38))]
    cols = np.nonzero(head.any(axis=0))[0]
    widths = head.sum(axis=1)
    head_w = np.percentile(widths[widths > 0], 70)
    cx = (cols.min() + cols.max()) / 2
    side = head_w * 1.75
    t = top - side * 0.08
    return im.crop((int(cx - side / 2), int(t), int(cx + side / 2), int(t + side)))


def _bilateral(rgb, alpha, sig):
    """Edge-preserving 3x3 smoothing (vectorised)."""
    H, W, _ = rgb.shape
    pr = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode="edge")
    pa = np.pad(alpha, 1).astype(float)
    num = np.zeros_like(rgb); den = np.zeros((H, W))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nb = pr[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
            na = pa[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
            wt = np.exp(-((nb - rgb) ** 2).sum(-1) / sig ** 2) * na
            num += nb * wt[..., None]; den += wt
    out = rgb.copy()
    out[alpha] = num[alpha] / den[alpha][:, None]
    return out


def _kmeans(px, k, iters=10):
    """k-means in a luminance-weighted space so facial shading keeps more levels."""
    w = np.sqrt(LW * 3)
    X = px * w
    order = np.argsort(px @ LW)
    C = X[order[((np.arange(k) + 0.5) / k * len(px)).astype(int)]].copy()
    for _ in range(iters):
        lab = ((X[:, None, :] - C[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            m = lab == j
            if m.any():
                C[j] = X[m].mean(0)
    return np.round((C / w)[lab])


def _despeckle(out, alpha, passes=2):
    """Pixels matching none of their 4 neighbours take the most common neighbour colour."""
    H, W, _ = out.shape
    for _ in range(passes):
        src = out.copy()
        for y in range(1, H - 1):
            for x in range(1, W - 1):
                if not alpha[y, x]:
                    continue
                nbs = [(y + dy, x + dx) for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)) if alpha[y + dy, x + dx]]
                if len(nbs) < 3:
                    continue
                me = tuple(src[y, x])
                cols = [tuple(src[q]) for q in nbs]
                if me in cols:
                    continue
                best = max(set(cols), key=cols.count)
                if cols.count(best) >= 2:
                    out[y, x] = best
    return out


def pixelate(raw, size=80, colors=40, outline=(18, 18, 26, 255)):
    """Photo -> 16-bit portrait ("style G"): face crop, 80px, smoothing, 40-colour palette, despeckle, outline.
    Mirrors js/portrait.js so baked and live portraits match."""
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    im = face_crop(im).resize((size, size), Image.LANCZOS)
    arr = np.array(im)
    alpha = _mask(arr)
    rgb = arr[..., :3].astype(float)
    lum = (rgb @ LW)[..., None]
    rgb = np.clip(((lum + (rgb - lum) * 1.12) - 128) * 1.05 + 128, 0, 255)
    rgb = _bilateral(rgb, alpha, 18)
    rgb = _bilateral(rgb, alpha, 22)
    out = rgb.copy()
    if alpha.any():
        out[alpha] = _kmeans(rgb[alpha], min(colors, int(alpha.sum())))
    out = _despeckle(np.round(out), alpha)
    res = np.zeros((size, size, 4), np.uint8)
    res[..., :3] = np.clip(out, 0, 255)
    res[..., 3] = alpha * 255
    ap = np.pad(alpha, 1)
    edge = (~alpha) & (ap[:-2, 1:-1] | ap[2:, 1:-1] | ap[1:-1, :-2] | ap[1:-1, 2:])
    res[edge] = outline
    buf = io.BytesIO()
    Image.fromarray(res).save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=80)
    ap.add_argument("--colors", type=int, default=40)
    ap.add_argument("--team", help="only bake one team (abbr, e.g. BUF)")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    data = load_data()
    players = [p for p in data["players"] if p.get("headshot")]
    if args.team:
        players = [p for p in players if p["team"] == args.team.upper()]
    CACHE.mkdir(parents=True, exist_ok=True)

    out_path = ROOT / "js/headshots.js"
    baked = {}
    if out_path.exists():
        txt = out_path.read_text()
        baked = json.loads(txt[txt.index("{"): txt.rindex("}") + 1])

    def work(p):
        try:
            raw = fetch(p["headshot"], CACHE / f'{p["id"]}.img')
            return p["id"], pixelate(raw, args.size, args.colors)
        except Exception as e:  # noqa: BLE001
            print(f'  ! {p["first"]} {p["last"]}: {e}', file=sys.stderr)
            return p["id"], None

    with ThreadPoolExecutor(args.workers) as ex:
        for i, (pid, uri) in enumerate(ex.map(work, players), 1):
            if uri:
                baked[str(pid)] = uri
            if i % 100 == 0:
                print(f"{i}/{len(players)}", file=sys.stderr)

    out_path.write_text("// Generated by tools/bake_headshots.py\nwindow.DEX_HEADSHOTS = " +
                        json.dumps(baked, separators=(",", ":")) + ";\n")
    print(f"baked {len(baked)} headshots -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
