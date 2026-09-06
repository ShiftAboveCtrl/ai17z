"""Generates the installer's artwork.

    python packaging/windows/make-wizard-art.py

Inno's modern wizard shows two bitmaps: a tall panel down the left of the first
and last pages, and a small mark in the top-right corner of every page in
between. Stock Inno ships a blue-green gradient with a hand holding a box, which
is what "plain old installer" looks like, and it is the first thing anybody sees
of AI17Z.

So both are drawn from the product's own palette: near-black ground, the
brushed-silver wordmark, and one hairline frame. The same mark as the desktop
icon, at the size each slot actually gets, because Inno scales these itself and
scaling a wordmark is how it turns to mush.

Sizes are Inno's, at 100% DPI. It scales them for higher DPI, so they are drawn
at 3x and downsampled -- a 164x314 bitmap stretched to 200% is visibly soft, and
the panel is the largest thing on the screen.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The product's own ground and ink.
INK = (11, 11, 12)
INK_LIFT = (26, 27, 30)
EDGE = (146, 152, 161)
SHEEN = [
    (0.00, (255, 255, 255)),
    (0.46, (255, 255, 255)),
    (0.62, (222, 224, 228)),
    (1.00, (172, 177, 186)),
]

# Inno's slots at 100% DPI. Drawn larger and downsampled.
# Inno''s slot is 164x314; drawn at 2.5x that so a stretched panel stays crisp
# on a scaled display, where this is the largest thing on the screen.
PANEL = (410, 785)
SMALL = (55, 55)
SCALE = 2


def font_for(px: int) -> ImageFont.FreeTypeFont:
    for name in ('arialbd.ttf', 'segoeuib.ttf', 'calibrib.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    raise SystemExit('no suitable bold sans font found')


def silver(size: tuple[int, int]) -> Image.Image:
    w, h = size
    column = Image.new('RGB', (1, h))
    px = column.load()
    for y in range(h):
        t = y / max(1, h - 1)
        for i in range(len(SHEEN) - 1):
            t0, c0 = SHEEN[i]
            t1, c1 = SHEEN[i + 1]
            if t0 <= t <= t1:
                k = (t - t0) / max(1e-6, t1 - t0)
                px[0, y] = tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                break
    return column.resize((w, h))


def wordmark(canvas_size: tuple[int, int], text: str, width_fraction: float) -> Image.Image:
    """The wordmark as a mask, fitted to a fraction of the canvas width."""
    w, h = canvas_size
    target = w * width_fraction
    px = int(h)
    while px > 8:
        box = font_for(px).getbbox(text)
        if (box[2] - box[0]) <= target:
            break
        px = int(px * 0.94)
    font = font_for(px)
    box = font.getbbox(text)
    mask = Image.new('L', canvas_size, 0)
    ImageDraw.Draw(mask).text(
        ((w - (box[2] - box[0])) / 2 - box[0], (h - (box[3] - box[1])) / 2 - box[1]),
        text,
        font=font,
        fill=255,
    )
    return mask


def panel() -> Image.Image:
    w, h = PANEL[0] * SCALE, PANEL[1] * SCALE
    img = Image.new('RGB', (w, h), INK)

    # A slow vertical lift, so the panel is not a flat black slab.
    lift = Image.new('RGB', (1, h))
    lp = lift.load()
    for y in range(h):
        t = y / (h - 1)
        lp[0, y] = tuple(round(INK[i] + (INK_LIFT[i] - INK[i]) * (t ** 1.6)) for i in range(3))
    img.paste(lift.resize((w, h)), (0, 0))

    # The hairline frame from the mark, inset generously.
    inset = round(w * 0.10)
    frame = Image.new('L', (w, h), 0)
    ImageDraw.Draw(frame).rectangle(
        [inset, inset, w - inset - 1, h - inset - 1], outline=255, width=max(2, round(w * 0.006))
    )
    img.paste(silver((w, h)), (0, 0), frame.point(lambda v: v // 3))

    # The wordmark, sitting a little above the middle where the eye lands.
    mark = wordmark((w, h), 'ai17z', 0.62)
    halo = mark.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(w * 0.006))
    shifted = Image.new('L', (w, h), 0)
    shifted.paste(mark, (0, -round(h * 0.08)))
    shifted_halo = Image.new('L', (w, h), 0)
    shifted_halo.paste(halo, (0, -round(h * 0.08)))
    img.paste(Image.new('RGB', (w, h), EDGE), (0, 0), shifted_halo.point(lambda v: v // 4))
    img.paste(silver((w, h)), (0, 0), shifted)

    # One line of quiet type under it, because a panel with a single word on it
    # reads as unfinished.
    sub = font_for(round(w * 0.042))
    d = ImageDraw.Draw(img)
    line = 'agents that run on your machine'
    box = d.textbbox((0, 0), line, font=sub)
    d.text(
        ((w - (box[2] - box[0])) / 2 - box[0], h * 0.56),
        line,
        font=sub,
        fill=(122, 127, 136),
    )

    return img.resize(PANEL, Image.LANCZOS)


def small() -> Image.Image:
    w, h = SMALL[0] * SCALE, SMALL[1] * SCALE
    img = Image.new('RGB', (w, h), INK)
    inset = round(w * 0.06)
    frame = Image.new('L', (w, h), 0)
    ImageDraw.Draw(frame).rectangle(
        [inset, inset, w - inset - 1, h - inset - 1], outline=255, width=max(2, round(w * 0.022))
    )
    img.paste(silver((w, h)), (0, 0), frame)
    mark = wordmark((w, h), '17', 0.46)
    img.paste(silver((w, h)), (0, 0), mark)
    return img.resize(SMALL, Image.LANCZOS)


def main() -> None:
    for name, image in (('wizard-panel.bmp', panel()), ('wizard-small.bmp', small())):
        out = HERE / name
        # BMP: Inno reads these, and a 24-bit BMP is what it expects.
        image.convert('RGB').save(out, format='BMP')
        print(f'wrote {out} ({image.size[0]}x{image.size[1]}, {out.stat().st_size} bytes)')
        image.save(out.with_suffix('.png'), format='PNG')


if __name__ == '__main__':
    main()
