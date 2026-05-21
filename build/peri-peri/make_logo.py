"""
Generate the PeriPeri chili-pepper logo.

Renders a red chili pepper with a green stem at high resolution,
then downsamples to the icon sizes Windows / VS Code expect:

    code.ico            -> multi-resolution: 16, 24, 32, 48, 64, 128, 256
    code_70x70.png      -> Windows tile (small)
    code_150x150.png    -> Windows tile (medium)
    chili_1024.png      -> master (for sanity-checking)
    chili.svg           -> simple SVG fallback

Usage (from repo root):
    python build/peri-peri/make_logo.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFilter

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
WIN32_RES = os.path.join(REPO_ROOT, "resources", "win32")
OUT_DIR = SCRIPT_DIR  # also drop intermediates here

MASTER = 1024  # supersampled canvas


# ---------- bezier helpers ----------

def cubic_bezier(p0, p1, p2, p3, steps=120):
    """Return list of (x, y) points along a cubic Bezier."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = (u ** 3) * p0[0] + 3 * (u ** 2) * t * p1[0] + 3 * u * (t ** 2) * p2[0] + (t ** 3) * p3[0]
        y = (u ** 3) * p0[1] + 3 * (u ** 2) * t * p1[1] + 3 * u * (t ** 2) * p2[1] + (t ** 3) * p3[1]
        pts.append((x, y))
    return pts


# ---------- shape drawing ----------

def chili_body_polygon(scale=1.0, ox=0.0, oy=0.0):
    """
    Build a closed polygon of a chili pepper body shape.
    Coordinate system: 1000x1000 logical, then scaled.
    The pepper is wide at the top, tapers down with a slight S-curve to a tip.
    """
    # Outline: traverse left side from top-left to tip, then right side back.
    # Reference points (logical 1000-space):
    left_top   = (380, 230)   # where stem meets body (left)
    right_top  = (640, 230)   # where stem meets body (right)
    tip        = (760, 880)   # pepper tip (slightly to the right)

    # Left side curve: from left_top down to tip
    left_curve = cubic_bezier(
        left_top,
        (260, 460),   # bulge outward to the left
        (340, 760),   # come back inward
        tip,
        steps=140,
    )
    # Right side curve: from tip back up to right_top
    right_curve = cubic_bezier(
        tip,
        (820, 700),   # right shoulder bulge
        (760, 360),   # narrow towards top-right
        right_top,
        steps=140,
    )
    # Top arc connecting right_top to left_top (slight upward dome)
    top_curve = cubic_bezier(
        right_top,
        (560, 200),
        (460, 200),
        left_top,
        steps=40,
    )

    pts = left_curve + right_curve + top_curve
    return [(ox + p[0] * scale, oy + p[1] * scale) for p in pts]


def stem_polygon(scale=1.0, ox=0.0, oy=0.0):
    """Green stem sitting on top of the pepper, bent slightly to one side."""
    # Stem rises from (510, 230) and curves to a point at (430, 60).
    base_left  = (430, 240)
    base_right = (590, 240)
    tip        = (430, 60)

    left = cubic_bezier(base_left, (380, 170), (380, 110), tip, steps=80)
    right = cubic_bezier(tip, (520, 110), (600, 170), base_right, steps=80)
    return [(ox + p[0] * scale, oy + p[1] * scale) for p in left + right]


def stem_highlight_polygon(scale=1.0, ox=0.0, oy=0.0):
    """A thinner inner shape on the stem to suggest a highlight ridge."""
    p0 = (470, 220)
    p1 = (445, 150)
    p2 = (455, 100)
    p3 = (450, 80)
    p4 = (475, 95)
    p5 = (485, 160)
    p6 = (500, 220)
    pts = (cubic_bezier(p0, p1, p2, p3, steps=40)
           + cubic_bezier(p3, p4, p5, p6, steps=40))
    return [(ox + p[0] * scale, oy + p[1] * scale) for p in pts]


def body_highlight_polygon(scale=1.0, ox=0.0, oy=0.0):
    """A long tapered highlight along the front-left of the pepper body."""
    p0 = (430, 290)
    p1 = (370, 460)
    p2 = (430, 720)
    p3 = (520, 820)
    p4 = (470, 700)
    p5 = (450, 470)
    p6 = (470, 300)
    pts = (cubic_bezier(p0, p1, p2, p3, steps=80)
           + cubic_bezier(p3, p4, p5, p6, steps=80))
    return [(ox + p[0] * scale, oy + p[1] * scale) for p in pts]


# ---------- compose the icon ----------

def render_master(size: int = MASTER) -> Image.Image:
    """Render the chili at `size` x `size` with transparent background."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Map our 1000-logical space into `size` pixels with a small inner margin
    margin = int(size * 0.06)
    scale = (size - 2 * margin) / 1000.0
    ox = margin
    oy = margin

    # --- soft drop shadow ---
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    body = chili_body_polygon(scale, ox + size * 0.012, oy + size * 0.018)
    sd.polygon(body, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=size * 0.018))
    img = Image.alpha_composite(img, shadow)

    # --- main body (deep red) ---
    body_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body_layer)
    body = chili_body_polygon(scale, ox, oy)
    bd.polygon(body, fill=(196, 30, 30, 255))
    img = Image.alpha_composite(img, body_layer)

    # --- vertical gradient on body (lighter at top, darker at tip) ---
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    # bright top half
    top_overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(top_overlay)
    td.polygon(body, fill=(255, 90, 60, 90))
    # mask top half by drawing a gradient mask
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    for y in range(size):
        # alpha falls off from top to bottom
        t = max(0.0, 1.0 - y / (size * 0.55))
        md.line([(0, y), (size, y)], fill=int(220 * t))
    img.paste(top_overlay, (0, 0), mask)

    # darker tip overlay
    tip_overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tdd = ImageDraw.Draw(tip_overlay)
    tdd.polygon(body, fill=(80, 0, 0, 140))
    mask2 = Image.new("L", (size, size), 0)
    md2 = ImageDraw.Draw(mask2)
    for y in range(size):
        t = max(0.0, (y - size * 0.55) / (size * 0.45))
        md2.line([(0, y), (size, y)], fill=int(180 * t))
    img.paste(tip_overlay, (0, 0), mask2)

    # --- specular highlight on body (curved white streak) ---
    hl_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl_layer)
    hl = body_highlight_polygon(scale, ox, oy)
    hd.polygon(hl, fill=(255, 220, 200, 130))
    hl_layer = hl_layer.filter(ImageFilter.GaussianBlur(radius=size * 0.006))
    img = Image.alpha_composite(img, hl_layer)

    # --- stem ---
    stem_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd2 = ImageDraw.Draw(stem_layer)
    stem = stem_polygon(scale, ox, oy)
    sd2.polygon(stem, fill=(46, 120, 42, 255))
    img = Image.alpha_composite(img, stem_layer)

    # stem highlight
    sh_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shd = ImageDraw.Draw(sh_layer)
    sh = stem_highlight_polygon(scale, ox, oy)
    shd.polygon(sh, fill=(140, 200, 90, 220))
    sh_layer = sh_layer.filter(ImageFilter.GaussianBlur(radius=size * 0.003))
    img = Image.alpha_composite(img, sh_layer)

    # tiny dark notch where stem meets body
    notch = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    nd = ImageDraw.Draw(notch)
    nd.ellipse(
        [
            ox + 410 * scale, oy + 220 * scale,
            ox + 600 * scale, oy + 270 * scale,
        ],
        fill=(70, 0, 0, 160),
    )
    notch = notch.filter(ImageFilter.GaussianBlur(radius=size * 0.004))
    img = Image.alpha_composite(img, notch)

    return img


# ---------- I/O ----------

def save_png(img: Image.Image, path: str):
    img.save(path, "PNG")
    print(f"  wrote {path}  ({img.size[0]}x{img.size[1]})")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(WIN32_RES, exist_ok=True)

    print("Rendering master 1024x1024...")
    master = render_master(MASTER)
    save_png(master, os.path.join(OUT_DIR, "chili_1024.png"))

    # Build resized variants by downsampling the master (LANCZOS)
    sizes = [16, 24, 32, 48, 64, 70, 128, 150, 256]
    variants = {}
    for s in sizes:
        variants[s] = master.resize((s, s), Image.LANCZOS)

    # Save Windows tile PNGs
    save_png(variants[70], os.path.join(WIN32_RES, "code_70x70.png"))
    save_png(variants[150], os.path.join(WIN32_RES, "code_150x150.png"))

    # Pack ICO
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_imgs = [variants[s] for s in ico_sizes]
    ico_path = os.path.join(WIN32_RES, "code.ico")
    # Pillow's ICO writer accepts a `sizes` arg listing tuples and
    # an `append_images` list for multi-frame ICOs.
    ico_imgs[-1].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_imgs[:-1],
    )
    print(f"  wrote {ico_path}  (frames: {ico_sizes})")

    # SVG fallback (used by Linux / macOS source if needed)
    svg_path = os.path.join(OUT_DIR, "chili.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(_svg())
    print(f"  wrote {svg_path}")


def _svg() -> str:
    # Hand-written SVG mirror of the bitmap shape, for source-of-truth
    return """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#ff6a3c"/>
      <stop offset="55%" stop-color="#c41e1e"/>
      <stop offset="100%" stop-color="#5a0000"/>
    </linearGradient>
    <linearGradient id="stem" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8cc85a"/>
      <stop offset="100%" stop-color="#2e782a"/>
    </linearGradient>
  </defs>
  <!-- shadow -->
  <path d="M380,230 C260,460 340,760 760,880 C820,700 760,360 640,230 C560,200 460,200 380,230 Z"
        fill="#000" opacity="0.25" transform="translate(14,18)" filter="url(#blur)"/>
  <!-- body -->
  <path d="M380,230 C260,460 340,760 760,880 C820,700 760,360 640,230 C560,200 460,200 380,230 Z"
        fill="url(#body)"/>
  <!-- highlight -->
  <path d="M430,290 C370,460 430,720 520,820 C470,700 450,470 470,300 Z"
        fill="#ffd9c2" opacity="0.55"/>
  <!-- stem -->
  <path d="M430,240 C380,170 380,110 430,60 C520,110 600,170 590,240 C520,250 480,250 430,240 Z"
        fill="url(#stem)"/>
</svg>
"""


if __name__ == "__main__":
    main()
