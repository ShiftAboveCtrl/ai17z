/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

/**
 * The monumental headings must paint their descenders.
 *
 * "Your agents" looked cut off along the bottom, and the reason was not a
 * clipping container. `.monument` gives the text no colour of its own — every
 * pixel comes from a gradient, and a gradient is painted only inside the
 * element's background box. Line-height 0.84 makes that box shorter than the
 * glyphs, so the tails of "y" and "g" fell outside it and were never painted.
 *
 * Measured on the real page before the fix, at 204.8px:
 *
 *   background box   172.0px
 *   baseline at      158.0px  ->  14.0px beneath it
 *   ink descent       36.0px  ->  22.0px with nowhere to be painted
 *
 * This test rebuilds that geometry from the declarations in styles.css and
 * asserts the box now clears the descenders at every heading size in the app.
 * Deleting `padding-block-end` from `.monument` fails it.
 *
 * It runs against whichever font resolves, which matters: a machine with no
 * network gets neither Archivo nor Kanit and falls back to a system face whose
 * descenders are deeper still. The padding is sized for the worst of them,
 * because a heading that only renders correctly online is not fixed.
 *
 * Kanit is still the body face. It is not the display face because its
 * descenders are short and flat-terminated at every weight, which at 96px reads
 * as text with its bottom sliced off — a rendering that is correct and looks
 * broken, which is the worst kind.
 *
 * Rendered in Playwright's Chromium on purpose: this measures CSS layout, and
 * says nothing about which browser drives an X session. Browser identity is
 * proved in realChrome.test.ts, against Google Chrome, and nowhere else.
 */

/** Every place `.monument` is used, with the line-height set on it. */
const HEADINGS = [
  { where: 'Home / Your agents', text: 'Your agents', lineHeight: 0.84, sizes: [62, 133, 205, 230, 352] },
  { where: 'Activity', text: 'Activity', lineHeight: 0.84, sizes: [62, 133, 205] },
  { where: 'Settings', text: 'Settings', lineHeight: 0.84, sizes: [62, 133, 205] },
  { where: 'Welcome', text: 'Build agents, not bots.', lineHeight: 0.85, sizes: [51, 108, 166] },
  { where: 'Create agent', text: 'A new agent', lineHeight: 0.85, sizes: [51, 108, 166] },
  { where: 'Section headings', text: 'Beliefs and stances', lineHeight: 0.86, sizes: [43, 65, 92] },
];

/** Pulls the plain declarations out of the `.monument` rule in the real file. */
function monumentDeclarations(css: string): string {
  const start = css.indexOf('.monument {');
  expect(start, '.monument rule not found in styles.css').toBeGreaterThan(-1);
  const body = css.slice(start + '.monument {'.length, css.indexOf('}', start));
  return body
    .split('\n')
    // @apply is Tailwind's, and is reproduced explicitly in the fixture below.
    .filter((line) => !line.includes('@apply'))
    .join('\n');
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe('monumental headings paint their descenders', () => {
  it('gives every heading a background box that clears its deepest glyph', async () => {
    const css = await readFile(resolve(process.cwd(), 'apps/web/src/styles.css'), 'utf8');
    const declarations = monumentDeclarations(css);

    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <html><head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Kanit:wght@200;300;400;500;600;700&display=swap">
        <style>
          body { margin: 0; background: #0a0a0a; }
          /* What @apply font-display font-semibold tracking-monument expands to. */
          h1 {
            font-family: Archivo, Kanit, ui-sans-serif, system-ui, sans-serif;
            font-weight: 600;
            letter-spacing: -0.045em;
            margin: 0;
            ${declarations}
          }
        </style>
      </head><body><h1 id="h"></h1></body></html>`);

    // Kanit or the fallback — either way the assertion is about this font.
    await page.evaluate(() => document.fonts.ready).catch(() => undefined);

    const failures: string[] = [];
    for (const heading of HEADINGS) {
      for (const size of heading.sizes) {
        const measured = await page.evaluate(
          ({ text, lineHeight, size }) => {
            const h = document.getElementById('h')!;
            h.textContent = text;
            h.style.fontSize = `${size}px`;
            h.style.lineHeight = String(lineHeight);
            // One line only: wrapping would measure a different geometry than
            // the one under test.
            h.style.whiteSpace = 'nowrap';

            const cs = getComputedStyle(h);
            const ctx = document.createElement('canvas').getContext('2d')!;
            ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
            const m = ctx.measureText(text);

            // Where the baseline sits inside the background box, and how much
            // box is left underneath it for a descender to be painted in.
            const lineBox = size * lineHeight;
            const halfLeading = (lineBox - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2;
            const baselineY = halfLeading + m.fontBoundingBoxAscent;
            return {
              boxBelowBaseline: h.clientHeight - baselineY,
              inkDescent: m.actualBoundingBoxDescent,
              fontFamily: cs.fontFamily.split(',')[0],
            };
          },
          { text: heading.text, lineHeight: heading.lineHeight, size },
        );

        if (measured.boxBelowBaseline < measured.inkDescent) {
          failures.push(
            `${heading.where} at ${size}px in ${measured.fontFamily}: ` +
              `${measured.inkDescent.toFixed(1)}px of descender, ` +
              `${measured.boxBelowBaseline.toFixed(1)}px of box beneath the baseline`,
          );
        }
      }
    }

    await page.close();
    expect(failures, failures.join('\n')).toEqual([]);
  }, 120_000);

  it('keeps the extension out of the layout', async () => {
    // The padding exists so the gradient has somewhere to paint. If it also
    // pushed the next element down, the fix would have changed the design, and
    // the spacing below every heading in the app would be wrong.
    const css = await readFile(resolve(process.cwd(), 'apps/web/src/styles.css'), 'utf8');
    const declarations = monumentDeclarations(css);

    const padding = declarations.match(/padding-block-end:\s*([\d.]+)em/)?.[1];
    const margin = declarations.match(/margin-block-end:\s*-([\d.]+)em/)?.[1];

    expect(padding, '.monument must extend its background box past the descenders').toBeDefined();
    expect(margin, '.monument must take that extension back out of the layout').toBeDefined();
    expect(Number(margin)).toBe(Number(padding));
  });
});
