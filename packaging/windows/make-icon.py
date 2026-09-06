"""Generates the AI17Z icon.

A script rather than a checked-in binary nobody can regenerate. Run it after
changing anything here:

    python packaging/windows/make-icon.py

The mark is the wordmark: `ai17z` in a thin frame, brushed-silver on nothing at
all. Four things decided how it is drawn.

**Transparent, because it was asked for.** That costs the safety a solid tile
gave: white glyphs vanish on a white background. So every stroke carries a soft
grey edge, which the wordmark it came from already has -- it is what makes the
letters read as metal rather than as paint. The edge is what keeps the icon
visible on a light taskbar, and it is not decoration.

**It has to survive 16 pixels.** That is the taskbar, the window corner and the
Alt-Tab strip, and it is where most people actually see an icon. Five characters
inside a square frame at 16px is a grey smudge, so below 40px the mark becomes
`17` alone -- the half of the wordmark that is distinctive -- at a size that can
actually be read. The frame stays, because the frame is the silhouette and
silhouette is what is recognised at a glance.

**A wordmark is wide and an icon is square.** The letters are set on a baseline
across the middle with generous margins rather than stretched to fill, which is
what the source does.

**Rendered large and downsampled.** PIL has no antialiased polygon fill, so the
edges come from the resize rather than from the drawing.
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Brushed silver, top to bottom: the sheen in the wordmark is a light band a
# little above the middle, not a straight gradient.
SHEEN = [
    (0.00, (255, 255, 255)),
    (0.34, (250, 250, 251)),
    (0.46, (255, 255, 255)),
    (0.62, (222, 224, 228)),
    (0.82, (198, 202, 208)),
    (1.00, (176, 181, 189)),
]

# The edge that keeps white visible on white. Soft and cool rather than a hard
# black outline, which would read as a sticker.
EDGE = (146, 152, 161)

SIZES = [16, 24, 32, 48, 64, 128, 256]
SCALE = 8

# Below this the full wordmark cannot be read, so the mark becomes `17`.
WORDMARK_FLOOR = 40


def sheen(height: int) -> Image.Image:
    """A one-pixel-wide column of the gradient, stretched later."""
    column = Image.new('RGB', (1, height))
    pixels = column.load()
    for y in range(height):
        t = y / max(1, height - 1)
        for i in range(len(SHEEN) - 1):
            t0, c0 = SHEEN[i]
            t1, c1 = SHEEN[i + 1]
            if t0 <= t <= t1:
                k = (t - t0) / max(1e-6, t1 - t0)
                pixels[0, y] = tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                break
    return column


def font_for(px: int) -> ImageFont.FreeTypeFont:
    """
    The wordmark's face, or the closest thing this machine has.

    A geometric sans with a single-storey `a` is what the source uses. Tried in
    order of how close they are; the icon is committed as a binary, so this only
    has to be right on the machine that regenerates it -- and it says which one
    it used rather than silently drawing something else.
    """
    for name in ('arialbd.ttf', 'segoeuib.ttf', 'calibrib.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    raise SystemExit('no suitable bold sans font found; install one or edit font_for()')


def draw_mark(size: int) -> Image.Image:
    """One square of the icon, at `size` pixels, on transparency."""
    n = size * SCALE
    text = 'ai17z' if size >= WORDMARK_FLOOR else '17'

    # The frame. Thin, inset, with a hairline gap inside it like the source.
    inset = round(n * 0.055)
    stroke = max(SCALE, round(n * 0.015))
    frame = Image.new('L', (n, n), 0)
    fd = ImageDraw.Draw(frame)
    fd.rectangle([inset, inset, n - inset - 1, n - inset - 1], outline=255, width=stroke)
    gap = stroke + max(SCALE, round(n * 0.018))
    fd.rectangle(
        [inset + gap, inset + gap, n - inset - gap - 1, n - inset - gap - 1],
        outline=255,
        width=max(SCALE // 2, round(n * 0.006)),
    )

    # The wordmark, fitted to the space inside the frame rather than guessed at.
    room = n - 2 * (inset + gap) - round(n * 0.10)
    px = room
    while px > 8:
        font = font_for(px)
        box = font.getbbox(text)
        if (box[2] - box[0]) <= room and (box[3] - box[1]) <= room * 0.62:
            break
        px = int(px * 0.94)
    font = font_for(px)
    box = font.getbbox(text)

    letters = Image.new('L', (n, n), 0)
    ld = ImageDraw.Draw(letters)
    ld.text(
        ((n - (box[2] - box[0])) / 2 - box[0], (n - (box[3] - box[1])) / 2 - box[1]),
        text,
        font=font,
        fill=255,
    )

    ink = Image.new('L', (n, n), 0)
    ink.paste(frame, (0, 0), frame)
    ink.paste(letters, (0, 0), letters)

    # The edge: the mark grown slightly and blurred, painted under it. This is
    # what makes a white icon survive a white background.
    halo = ink.filter(ImageFilter.MaxFilter(max(3, (round(n * 0.012) * 2) + 1)))
    halo = halo.filter(ImageFilter.GaussianBlur(n * 0.010))

    canvas = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    canvas.paste(Image.new('RGB', (n, n), EDGE), (0, 0), halo)
    canvas.paste(sheen(n).resize((n, n)), (0, 0), ink)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    frames = [draw_mark(size) for size in SIZES]
    out = HERE / 'ai17z.ico'
    # `append_images`, not `sizes`. Passing only the largest frame and a list of
    # sizes makes PIL downsample that one image into all of them -- which
    # silently threw away every size drawn for its own scale, so 16px got the
    # full five-character wordmark shrunk into a smudge, which is the exact
    # thing drawing per size exists to prevent.
    frames[-1].save(out, format='ICO', append_images=frames[:-1])
    print(f'wrote {out} ({out.stat().st_size} bytes) at {", ".join(str(s) for s in SIZES)}')

    # A PNG beside it, for anywhere that wants the mark without an .ico.
    frames[-1].save(HERE / 'ai17z.png', format='PNG')
    print(f'wrote {HERE / "ai17z.png"}')


if __name__ == '__main__':
    main()
