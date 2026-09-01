import { expect, test } from '@playwright/test';
import { signIn, useInterface } from './helpers';

/**
 * The layout, at the widths people actually use.
 *
 * Two things are checked at every size, on every route that matters.
 *
 * The heading must paint its descenders. "Your agents" looked cut along the
 * bottom for a long time, and the cause was not a clipping container: the
 * monumental headings take every pixel from a gradient, a gradient is painted
 * only inside the element's background box, and a line-height under one makes
 * that box shorter than the glyphs. The tails of "y" and "g" fell outside it
 * and were simply never drawn. `headingPaint.test.ts` pins the geometry from
 * the stylesheet; this pins it on the rendered page, which is where it was
 * actually wrong.
 *
 * And nothing may scroll sideways. A page wider than the phone it is on is the
 * most common way a layout breaks, and the easiest to miss on a desktop.
 */

const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2200, height: 1200 },
];

const ROUTES = ['/', '/activity', '/settings'];

for (const size of WIDTHS) {
  test(`no sideways scroll and no clipped heading at ${size.width}px (${size.name})`, async ({ page }) => {
    await useInterface(page, 'advanced');
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page);

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);

      // Sideways scroll. One pixel of slack for sub-pixel rounding; anything
      // more is a real overflow somebody will find on a phone.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${route} at ${size.width}px scrolls sideways`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);

      // Every monumental heading must fit its own painted box. `scrollHeight`
      // exceeding `clientHeight` is exactly the overflow that used to eat the
      // descenders.
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('.monument')]
          .map((el) => {
            const node = el as HTMLElement;
            return {
              text: (node.textContent ?? '').trim().slice(0, 40),
              scrollHeight: node.scrollHeight,
              clientHeight: node.clientHeight,
            };
          })
          .filter((h) => h.scrollHeight > h.clientHeight + 1),
      );
      expect(clipped, `${route} at ${size.width}px has a clipped heading`).toEqual([]);
    }
  });
}

test('the agents heading keeps its descenders under zoom', async ({ page }) => {
  await useInterface(page, 'advanced');
  await signIn(page);

  // Browser zoom is a device-pixel-ratio change, which is what this emulates.
  // 125% and 150% are the two settings people actually run at.
  for (const scale of [1, 1.25, 1.5]) {
    await page.setViewportSize({ width: Math.round(1440 / scale), height: Math.round(900 / scale) });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);

    const heading = page.getByRole('heading', { name: 'Your agents' });
    await expect(heading).toBeVisible();

    const fits = await heading.evaluate((el) => {
      const node = el as HTMLElement;
      return node.scrollHeight <= node.clientHeight + 1;
    });
    expect(fits, `clipped at ${Math.round(scale * 100)}% zoom`).toBe(true);
  }
});
