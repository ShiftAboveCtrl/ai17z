"""The AI17Z logo, as every icon and piece of artwork takes it.

`ai17z-logo.png` beside this file is the owner's canonical logo and the only
source of the mark. Nothing here draws, traces or restyles it: every output is
that image, cropped to its own bounds, scaled, and placed on a ground. If the
logo changes, replace the PNG and run the two scripts that use this:

    python packaging/windows/make-icon.py
    python packaging/windows/make-wizard-art.py

Two decisions, both about placement rather than the mark:

**A dark tile.** The logo is a near-white wordmark on transparency, which
disappears on a light taskbar, a white Start menu or a browser tab. So an icon
is the logo on the product's own ink, the same ground the app is drawn on.

**The face below 40 pixels.** Five letters across 16 pixels is a grey smear.
Below that size the icon is the "i" head with its eyes, cut from the same
image rather than redrawn: the most recognisable part of the mark at a size
where the whole of it cannot be read.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
LOGO = HERE / 'ai17z-logo.png'

# The app's ink, from apps/web/tailwind.config.js.
INK = (12, 12, 12)

# Where the mark sits in the source image. Measured, not guessed: alpha above
# 16 bounds the wordmark including its soft edge, and the "i" head is the
# circle at (485, 320) with a radius of 56.
WORDMARK_THRESHOLD = 16
HEAD_CENTRE = (485, 320.5)
HEAD_RADIUS = 56

# Below this edge length an icon shows the face rather than the wordmark.
FACE_BELOW = 40

# Everything is composed this many times larger and downsampled once, so the
# edges come from one high-quality resize.
OVERSAMPLE = 4


def source() -> Image.Image:
    return Image.open(LOGO).convert('RGBA')


def wordmark() -> Image.Image:
    """The logo cropped to itself, soft edge included."""
    image = source()
    alpha = image.split()[3].point(lambda v: 255 if v > WORDMARK_THRESHOLD else 0)
    left, top, right, bottom = alpha.getbbox()
    pad = 6
    return image.crop((max(0, left - pad), max(0, top - pad), min(image.width, right + pad), min(image.height, bottom + pad)))


def face() -> Image.Image:
    """The "i" head and its eyes, cut out of the logo along its own circle."""
    image = source()
    cx, cy = HEAD_CENTRE
    r = HEAD_RADIUS + 4
    box = (round(cx - r), round(cy - r), round(cx + r), round(cy + r))
    crop = image.crop(box)
    # Keep only what is inside the circle, so no part of the neighbouring
    # letters comes with it.
    keep = Image.new('L', crop.size, 0)
    ImageDraw.Draw(keep).ellipse([0, 0, crop.width - 1, crop.height - 1], fill=255)
    alpha = Image.composite(crop.split()[3], Image.new('L', crop.size, 0), keep)
    crop.putalpha(alpha)
    return crop


def fit(mark: Image.Image, width: int, height: int) -> Image.Image:
    scale = min(width / mark.width, height / mark.height)
    return mark.resize((max(1, round(mark.width * scale)), max(1, round(mark.height * scale))), Image.LANCZOS)


def tile(size: int, radius: float = 0.22) -> Image.Image:
    """One square icon: the mark on a rounded ink tile, with a transparent corner."""
    big = size * OVERSAMPLE
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle([0, 0, big - 1, big - 1], radius=round(big * radius), fill=INK + (255,))
    if size < FACE_BELOW:
        mark = fit(face(), round(big * 0.80), round(big * 0.80))
    else:
        mark = fit(wordmark(), round(big * 0.84), round(big * 0.84))
    canvas.alpha_composite(mark, ((big - mark.width) // 2, (big - mark.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def on_ground(width: int, height: int, ground: tuple[int, int, int], mark_width: float, y_centre: float = 0.5) -> Image.Image:
    """The wordmark on a flat ground, for artwork that is not an icon."""
    canvas = Image.new('RGBA', (width * OVERSAMPLE, height * OVERSAMPLE), ground + (255,))
    mark = fit(wordmark(), round(canvas.width * mark_width), canvas.height)
    canvas.alpha_composite(mark, ((canvas.width - mark.width) // 2, round(canvas.height * y_centre - mark.height / 2)))
    return canvas.resize((width, height), Image.LANCZOS)
