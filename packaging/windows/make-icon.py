"""Generates the AI17Z icon.

A script rather than a checked-in binary nobody can regenerate. Run it after
changing anything here:

    python packaging/windows/make-icon.py

Design constraints, in the order they mattered:

**It has to survive 16 pixels.** That is the taskbar, the window corner and the
Alt-Tab strip, and it is where most people actually see an icon. The first
version was thin white numerals on near-black: elegant at 256, an illegible
smudge at 16.

**It has to be visible on a dark taskbar.** Windows ships dark by default, and a
near-black icon on a near-black bar is a hole. So the ground is light and the
mark is dark -- the opposite of the app's own interface, and the right way round
for where the icon is seen.

**The numerals are drawn, not typed.** No font dependency, no hinting surprises,
and full control of stroke weight at every size: the strokes thicken as the
canvas shrinks, because a stroke that looks refined at 256 disappears at 16.
"""

from PIL import Image, ImageDraw

# The product palette.
INK = (12, 12, 12)
BONE = (242, 241, 238)
ACCENT = (139, 164, 184)
ACCENT_DEEP = (92, 118, 140)

SIZES = [16, 24, 32, 48, 64, 128, 256]
# Rendered large and downsampled: PIL has no antialiased polygon fill, so the
# edges come from the resize rather than from the drawing.
SUPER = 8


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_one(draw, x, top, height, weight, colour):
    """A '1': a vertical stem, an angled flag, and a foot.

    The foot is what stops it reading as a lower-case 'l' at small sizes.
    """
    stem_left = x + weight * 0.9
    draw.rectangle([stem_left, top, stem_left + weight, top + height], fill=colour)
    # The flag, as a quadrilateral so it has a real angle rather than a step.
    draw.polygon(
        [
            (x, top + height * 0.24),
            (stem_left + weight * 0.1, top),
            (stem_left + weight * 0.1, top + weight * 1.1),
            (x + weight * 0.35, top + height * 0.34),
        ],
        fill=colour,
    )
    # The foot.
    foot_w = weight * 2.9
    cx = stem_left + weight / 2
    draw.rectangle([cx - foot_w / 2, top + height - weight, cx + foot_w / 2, top + height], fill=colour)


def draw_seven(draw, x, top, height, weight, colour, width):
    """A '7': a top bar and a diagonal."""
    draw.rectangle([x, top, x + width, top + weight], fill=colour)
    # The diagonal, drawn as a quad so its width stays constant along its length
    # instead of thinning the way a rotated rectangle would.
    draw.polygon(
        [
            (x + width, top),
            (x + width - weight * 0.15, top),
            (x + width * 0.30 - weight * 0.2, top + height),
            (x + width * 0.30 + weight * 0.95, top + height),
        ],
        fill=colour,
    )


def render(size: int) -> Image.Image:
    s = size * SUPER
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # The tile. Windows 11 uses a generous corner radius; matching it stops the
    # icon looking like a sticker sitting on top of the taskbar.
    radius = int(s * 0.22)
    rounded_rect(d, [0, 0, s - 1, s - 1], radius, BONE)

    # A band of accent along the bottom, which is what makes it identifiable as
    # a shape rather than as "a light square" when the numerals stop resolving.
    band_top = int(s * 0.775)
    band = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    rounded_rect(bd, [0, 0, s - 1, s - 1], radius, ACCENT)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rectangle([0, band_top, s, s], fill=255)
    img.paste(band, (0, 0), mask)

    # A hairline above the band, in the deeper accent. Reads as a considered
    # edge at large sizes and simply vanishes at small ones, which is fine.
    if size >= 48:
        d.rectangle([0, band_top, s, band_top + max(1, int(s * 0.006))], fill=ACCENT_DEEP)

    # Numerals. Heavier as the canvas shrinks: 0.115 of the width at 256 would
    # be a single pale pixel at 16.
    if size <= 24:
        weight_ratio = 0.155
    elif size <= 48:
        weight_ratio = 0.135
    else:
        weight_ratio = 0.115

    weight = s * weight_ratio
    height = s * 0.40
    top = s * 0.235

    seven_w = s * 0.245
    one_w = weight * 2.9
    gap = s * 0.075
    total = one_w + gap + seven_w
    left = (s - total) / 2

    draw_one(d, left, top, height, weight, INK)
    draw_seven(d, left + one_w + gap, top, height, weight, INK, seven_w)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    frames = [render(n) for n in SIZES]
    here = __file__.rsplit("make-icon.py", 1)[0]

    largest = frames[-1]
    largest.save(here + "ai17z-256.png")
    # Pillow writes every listed size into the .ico from the image it is given;
    # passing the already-rendered frames keeps the small ones as drawn rather
    # than as a downscale of the large one.
    largest.save(
        here + "ai17z.ico",
        format="ICO",
        sizes=[(n, n) for n in SIZES],
        append_images=frames[:-1],
    )
    print("wrote ai17z.ico and ai17z-256.png at", SIZES)


if __name__ == "__main__":
    main()
