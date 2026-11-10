#!/usr/bin/env python3
"""Draw the pixel-art app icon (a red dex with a football) at the sizes phones need."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# 16x16 pixel map: k outline, r red, d dark red, w white, b ball brown, l lace
ART = [
    "................",
    ".kkkkkkkkkkkkkk.",
    ".krrrrrrrrrrrrk.",
    ".krwwkrrrrrrrdk.",
    ".krwwkrrrrrrrdk.",
    ".krkkkrrrrrrrdk.",
    ".krrrrkkkkkkrdk.",
    ".krrrkbbbbbbkdk.",
    ".krrkbbwlwlbbkk.",
    ".krrkbbllllbbkk.",
    ".krrkbbwlwlbbkk.",
    ".krrrkbbbbbbkdk.",
    ".krrrrkkkkkkrdk.",
    ".kdddddddddddddk",
    ".kkkkkkkkkkkkkk.",
    "................",
]
PAL = {"k": (20, 20, 28), "r": (215, 38, 61), "d": (142, 16, 34), "w": (191, 232, 255),
       "b": (138, 75, 34), "l": (255, 255, 255)}


def main():
    base = Image.new("RGBA", (16, 16), (18, 20, 28, 255))
    for y, row in enumerate(ART):
        for x, ch in enumerate(row[:16]):
            if ch in PAL:
                base.putpixel((x, y), PAL[ch] + (255,))
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    for size in (180, 192, 512):
        base.resize((size, size), Image.NEAREST).save(out / f"icon-{size}.png")
    print("wrote", out)


if __name__ == "__main__":
    main()
