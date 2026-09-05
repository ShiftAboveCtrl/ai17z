import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../apps/web/src/routes/AgentPage.tsx'), 'utf8');

/**
 * Every section has to be somewhere you can get to.
 *
 * A section can be rendered, finished and completely unreachable. That happened
 * the moment Knowledge was added: the section was on the page and the nav did
 * not mention it, so the feature existed and nobody could find it.
 *
 * The page used to be one flat list of fifteen sections with a fifteen-item
 * nav, and this test compared the two lists. It is now five named areas, each
 * rendering only its own sections, so the same property has a different shape:
 * a section must be claimed by exactly one area, and every area's claim must
 * correspond to something the page actually renders. A section claimed by no
 * area is unreachable; a section claimed by two has an ambiguous `#anchor`.
 */
const areaBlock = source.slice(source.indexOf('const AREAS = ['), source.indexOf('] as const;\n\ntype AreaId'));

/** The sections each area claims, in declaration order. */
const claimed = [...areaBlock.matchAll(/sections:\s*\[([^\]]*)\]/g)].flatMap((m) =>
  [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!),
);

/** What the page actually puts on screen. Components are named after their anchor. */
const rendered = [...source.matchAll(/<(\w+)Section\s/g)].map((m) => m[1]!.toLowerCase());

describe('every section on the agent page is reachable', () => {
  it('finds both lists where this test thinks they are', () => {
    expect(areaBlock, 'the AREAS declaration moved or was renamed').toContain('sections:');
    expect(claimed.length).toBeGreaterThan(8);
    expect(rendered.length).toBeGreaterThan(8);
  });

  for (const name of ['identity', 'voice', 'accounts', 'intelligence', 'memory', 'knowledge', 'tools', 'activity']) {
    it(`${name} belongs to an area`, () => {
      expect(claimed).toContain(name);
    });
  }

  it('every rendered section is claimed by an area', () => {
    const missing = rendered.filter((name) => !claimed.includes(name));
    expect(missing, 'rendered but in no area, so nothing can reach it').toEqual([]);
  });

  it('no area claims a section that is not rendered', () => {
    const dangling = claimed.filter((name) => !rendered.includes(name));
    expect(dangling, 'claimed by an area but never rendered').toEqual([]);
  });

  it('no section is claimed by two areas', () => {
    // `#knowledge` has to select one area. Two claims makes which one arbitrary.
    const seen = new Set<string>();
    const twice = claimed.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
    expect(twice, 'claimed by more than one area').toEqual([]);
  });
});

/**
 * Old links have to keep working.
 *
 * Fifteen anchors were the navigation for months. They are in bookmarks, in
 * notes, and in the fix text this application writes for itself -- several
 * error messages say things like "set a vision model under Intelligence".
 */
describe('a link to a section still lands on it', () => {
  it('maps every section to the area that holds it', () => {
    expect(source).toContain('AREA_OF_SECTION');
  });

  it('reacts to the hash changing, not only to a fresh load', () => {
    expect(source).toContain("addEventListener('hashchange'");
  });

  it('also handles a cold load, when the section is not rendered yet', () => {
    // The browser tries to scroll before React has drawn the area, finds
    // nothing, and silently leaves you at the top.
    // Anchored on the comment rather than on exact whitespace, because line
    // endings differ between checkouts.
    const at = source.indexOf('The same thing on a cold load');
    expect(at, 'the cold-load effect is gone').toBeGreaterThan(-1);
    expect(source.slice(at, at + 700)).toContain('scrollIntoView');
  });
});
