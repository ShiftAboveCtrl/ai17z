import { expect, test, type Page } from '@playwright/test';
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

/**
 * The agent page, which this did not cover and is the one that would break.
 *
 * Three static routes were checked and the densest layout in the application
 * was not: five areas of sections, a 3D portrait, tab navigation that has to
 * fit five labels on a 375px phone, and tables of machine-generated text. It
 * needs an agent, so the id is read from the API rather than written down.
 */
async function agentRoutes(page: Page): Promise<string[]> {
  const id = await page.evaluate(async () => {
    const token = localStorage.getItem('ai17z.session') ?? localStorage.getItem('xbam.session');
    if (!token) return null;
    const listed = await fetch('/api/agents', { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    return (listed?.data?.items ?? [])[0]?.id ?? null;
  });
  // Every area, because only the selected one renders.
  return id ? ['', '#identity', '#accounts', '#memory', '#policies'].map((h) => `/agents/${id}${h}`) : [];
}

for (const size of WIDTHS) {
  test(`no sideways scroll and no clipped heading at ${size.width}px (${size.name})`, async ({ page }) => {
    await useInterface(page, 'advanced');
    await page.setViewportSize({ width: size.width, height: size.height });
    /*
      Without motion, because the thing being measured is the layout.

      The monumental headings enter with `whileInView` from `y: 0.35em`, and a
      heading still sitting at its starting offset measures as exactly that
      much overflow -- which is the animation, not a clipped descender. On the
      three static routes the heading is at the top and has already arrived,
      which is why this never came up until the agent page, whose sections are
      mostly below the fold. `AnimatedText` honours the preference by rendering
      the words plainly, so this measures the geometry that ships.
    */
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);

    for (const route of [...ROUTES, ...(await agentRoutes(page))]) {
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
        Array.from(document.querySelectorAll('.monument'))
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
