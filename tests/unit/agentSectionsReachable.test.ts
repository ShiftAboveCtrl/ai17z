import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../apps/web/src/routes/AgentPage.tsx'), 'utf8');

/**
 * The navigation and the page are two lists that have to agree.
 *
 * A section can be rendered, scrollable and completely finished while being
 * absent from the menu that is the only way anybody finds it. That happened the
 * moment Knowledge was added: the section was on the page and the nav did not
 * mention it, so the feature existed and nobody could reach it.
 *
 * The same shape as the persona fields that were saved on every edit with no
 * input anywhere. Worth a standing test rather than a fixed entry.
 */
describe('every section on the agent page is in its navigation', () => {
  const listed = [...source.matchAll(/\['([a-z]+)',\s*'[^']+'\],/g)].map((m) => m[1]!);
  const rendered = [...source.matchAll(/<(\w+)Section\s/g)].map((m) => m[1]!.toLowerCase());

  it('finds both lists where this test thinks they are', () => {
    expect(listed.length).toBeGreaterThan(8);
    expect(rendered.length).toBeGreaterThan(8);
  });

  for (const name of ['identity', 'voice', 'accounts', 'intelligence', 'memory', 'knowledge', 'tools', 'activity']) {
    it(`${name} is reachable from the navigation`, () => {
      expect(listed).toContain(name);
    });
  }

  it('every rendered section has a way to reach it', () => {
    // Section components are named after their anchor, which is what makes
    // this comparison meaningful rather than a coincidence.
    const missing = rendered.filter((name) => !listed.includes(name));
    expect(missing, 'rendered but not in the navigation').toEqual([]);
  });

  it('the navigation does not point at a section that is not there', () => {
    const dangling = listed.filter((name) => !rendered.includes(name));
    expect(dangling, 'in the navigation but not rendered').toEqual([]);
  });
});
