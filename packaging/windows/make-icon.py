"""Generates every AI17Z icon from the canonical logo.

    python packaging/windows/make-icon.py

A script rather than checked-in binaries nobody can regenerate. The mark is
never drawn here: `packaging/brand/logo.py` takes it from
`packaging/brand/ai17z-logo.png` and places it on the product's ink. See that
file for why the smallest sizes show the "i" head rather than the wordmark.

Outputs, each where something already reads it:

    packaging/windows/ai17z.ico       installer, shortcuts, Add/Remove Programs
    packaging/windows/ai17z.png       256px, the Windows package's own copy
    packaging/windows/ai17z-256.png   256px, the Ubuntu and macOS packages
    packaging/brand/icons/*.png       hicolor sizes for the Ubuntu desktop entry
    apps/web/public/*                 favicon, touch icon, install icons, wordmark
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / 'packaging' / 'brand'))

from logo import fit, tile, wordmark  # noqa: E402

from PIL import Image  # noqa: E402

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
HICOLOR = [48, 128, 256, 512]


def write_ico(path: Path, sizes: list[int]) -> None:
    images = [tile(s) for s in sizes]
    largest = images[-1]
    largest.save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=images[:-1])


def main() -> None:
    # Windows.
    write_ico(HERE / 'ai17z.ico', ICO_SIZES)
    tile(256).save(HERE / 'ai17z.png')
    tile(256).save(HERE / 'ai17z-256.png')

    # Ubuntu's icon theme, one file per size it looks in.
    icons = ROOT / 'packaging' / 'brand' / 'icons'
    icons.mkdir(exist_ok=True)
    for size in HICOLOR:
        tile(size).save(icons / f'ai17z-{size}.png')

    # The web app.
    public = ROOT / 'apps' / 'web' / 'public'
    public.mkdir(exist_ok=True)
    write_ico(public / 'favicon.ico', [16, 32, 48])
    tile(192).save(public / 'icon-192.png')
    tile(512).save(public / 'icon-512.png')
    # A touch icon is masked by the device, so it fills its square.
    tile(180, radius=0).save(public / 'apple-touch-icon.png')
    # The wordmark for the app's own header, white on transparent as supplied.
    mark = wordmark()
    fit(mark, 480, 480).save(public / 'ai17z-wordmark.png')
    manifest = {
        'name': 'AI17Z',
        'short_name': 'AI17Z',
        'description': 'Run autonomous agents on your own machine.',
        'start_url': '/',
        'display': 'standalone',
        'background_color': '#0C0C0C',
        'theme_color': '#0C0C0C',
        'icons': [
            {'src': '/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': '/icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
        ],
    }
    (public / 'manifest.webmanifest').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

    for path in sorted([HERE / 'ai17z.ico', HERE / 'ai17z.png', public / 'favicon.ico']):
        with Image.open(path) as image:
            print(path.relative_to(ROOT), image.size)


if __name__ == '__main__':
    main()
