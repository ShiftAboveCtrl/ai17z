"""Generates the installer's artwork from the canonical logo.

    python packaging/windows/make-wizard-art.py

Inno's modern wizard shows two bitmaps: a tall panel down the left of the first
and last pages, and a small mark in the top-right corner of every page in
between. Stock Inno ships a blue-green gradient with a hand holding a box, which
is what "plain old installer" looks like, and it is the first thing anybody sees
of AI17Z.

Both are the owner's logo, taken from `packaging/brand/ai17z-logo.png` by
`packaging/brand/logo.py` and never redrawn. The pages themselves stay white,
which is what Windows draws its controls well on; only these two bitmaps carry
the product's ink, because the logo is white and needs a dark ground to be seen.

The panel is 410x785, Inno's 164x314 slot at 2.5x, so a stretched panel stays
crisp on a scaled display where it is the largest thing on the screen. The
small mark is the same tile as the icon, at the 55 pixels Inno gives it.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'brand'))

from logo import INK, on_ground, tile  # noqa: E402

PANEL = (410, 785)
SMALL = 55


def main() -> None:
    panel = on_ground(PANEL[0], PANEL[1], INK, mark_width=0.78, y_centre=0.42)
    small = tile(SMALL, radius=0)
    for name, image in (('wizard-panel.bmp', panel), ('wizard-small.bmp', small)):
        out = HERE / name
        # BMP: Inno reads these, and a 24-bit BMP is what it expects.
        image.convert('RGB').save(out, format='BMP')
        print(f'wrote {out.name} ({image.size[0]}x{image.size[1]}, {out.stat().st_size} bytes)')
        image.convert('RGB').save(out.with_suffix('.png'), format='PNG')


if __name__ == '__main__':
    main()
