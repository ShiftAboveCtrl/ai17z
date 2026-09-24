import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every top-level page opens below the navigation.
 *
 * The header is `fixed`: 67px on a desktop, and 117px on a narrow window
 * where it wraps to two rows. A page that opens with its own padding rather
 * than the shared one puts its first line underneath it, and the only way to
 * see that is to look at the running application at that width.
 *
 * The owner saw exactly that on the Plugins page, which had invented
 * `max-w-4xl px-4 py-8` -- 32px of top padding against a 67px header, so its
 * title sat 35px behind the navigation. Measured in the browser before the
 * fix and after it: -35px, then +45px.
 *
 * `pt-32` below 640px and `sm:pt-28` from there, because that is where the
 * navigation stops wrapping. Every page sharing the shell had the narrow-
 * window overlap and none of them showed it on a desktop.
 */

const routes = join(process.cwd(), 'apps', 'web', 'src', 'routes');

/** The pages that own a full-width main of their own. */
const TOP_LEVEL = ['Home.tsx', 'ActivityPage.tsx', 'SettingsPage.tsx', 'PluginsPage.tsx'];

describe('the page shell clears the navigation', () => {
  it('is the same shell on every top-level page', () => {
    for (const file of TOP_LEVEL) {
      const source = readFileSync(join(routes, file), 'utf8');
      expect(source, `${file} does not use the shared page shell`).toContain(
        'mx-auto max-w-page px-6 pb-24 pt-32 sm:px-10 sm:pt-28',
      );
    }
  });

  it('leaves no page opening with the padding that did not clear a wrapped header', () => {
    // `pt-24` is 96px and the wrapped header is 117px. Whoever adds a page
    // next should copy a shell that works rather than the one that did not.
    for (const file of readdirSync(routes).filter((name) => name.endsWith('.tsx'))) {
      const source = readFileSync(join(routes, file), 'utf8');
      expect(source, `${file} still opens with pt-24 under a header that can be 117px tall`).not.toMatch(
        /className="[^"]*\bpt-24\b[^"]*"/,
      );
    }
  });

  it('gives the Plugins page the heading every other page has', () => {
    // Not only the spacing: the page had a plain small `h1` where the rest of
    // the application has an eyebrow, a monument heading and an `Explain`.
    const source = readFileSync(join(routes, 'PluginsPage.tsx'), 'utf8');
    expect(source).toContain('eyebrow');
    expect(source).toContain('AnimatedText');
    expect(source).toContain('<Explain');
    // In a className, rather than anywhere: the comment above the shell names
    // the width this page used to invent, and saying why is worth keeping.
    expect(source).not.toMatch(/className="[^"]*\bmax-w-4xl\b[^"]*"/);
  });
});
