import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKER_WHERES, blockerSchema, type Blocker } from '@xbam/shared/contracts';
import { blockerHref } from '../../apps/web/src/lib/blockers';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const blocker = (where: Blocker['where']): Blocker => ({ what: 'x', fix: 'y', where });

/**
 * "No account is connected" with nowhere to go.
 *
 * The API has always worked out where the fix for a blocker lives and sent it
 * as `where`. Three screens rendered blockers, each declared its own
 * `{ what, fix }[]` inline, and all three dropped that field -- so the one
 * piece of navigation the API had already computed was thrown away in every
 * place it could have been used.
 */
describe('what is stopping an agent, and where to fix it', () => {
  it('sends somebody to the panel that holds the fix', () => {
    expect(blockerHref(blocker('account'), 'a1')).toBe('/agents/a1#accounts');
    // Capabilities are granted on the account, so they share a destination.
    expect(blockerHref(blocker('capabilities'), 'a1')).toBe('/agents/a1#accounts');
    expect(blockerHref(blocker('models'), 'a1')).toBe('/agents/a1#intelligence');
    expect(blockerHref(blocker('persona'), 'a1')).toBe('/agents/a1#identity');
  });

  it('sends a worker problem to Health rather than to the agent', () => {
    // A worker that is not running is not on any one agent's page, and it is
    // the same worker for all of them.
    expect(blockerHref(blocker('worker'), 'a1')).toBe('/health');
    expect(blockerHref(blocker('worker'), null)).toBe('/health');
  });

  it('offers no link when there is nowhere useful to go', () => {
    // `where: null` is what a fault in AI17Z itself carries. A link to the
    // agent page pretending otherwise is worse than no link.
    expect(blockerHref(blocker(null), 'a1')).toBeNull();
    // And during setup there is no agent page yet.
    expect(blockerHref(blocker('account'), null)).toBeNull();
  });

  it('has a destination for every place the contract can name', () => {
    // The failing case: somebody adds a `where` value to the contract, the
    // switch falls through to the default, and the blocker silently loses its
    // link rather than failing anywhere.
    for (const where of BLOCKER_WHERES) {
      expect(blockerHref(blocker(where), 'a1'), where).not.toBeNull();
    }
  });

  it('anchors at sections the agent page actually knows about', () => {
    // The page selects an area from the hash via AREA_OF_SECTION. An anchor
    // that names no section leaves somebody at the top of whatever they were
    // already looking at, which reads as the link being broken.
    const page = read('apps/web/src/routes/AgentPage.tsx');
    for (const anchor of ['accounts', 'intelligence', 'identity']) {
      expect(page, anchor).toContain(`'${anchor}'`);
    }
  });

  it('is one list, not three', () => {
    // Three screens rendered this. The tempting fix for a wording problem is
    // to fix the one you are looking at.
    for (const file of [
      'apps/web/src/routes/EasySetup.tsx',
      'apps/web/src/routes/EasyAgentView.tsx',
      'apps/web/src/routes/AgentPage.tsx',
    ]) {
      const source = read(file);
      expect(source, file).toContain('<Blockers');
      // The shape of the old hand-rolled list: mapping blockers straight into
      // list items. If this comes back, so has the divergence.
      expect(source, file).not.toMatch(/blockers\.map\(/);
    }
  });

  it('declares the blocker shape once, in contracts', () => {
    // The inline `{ what: string; fix: string }[]` is what dropped `where` in
    // the first place, and it dropped it identically in three files.
    for (const file of [
      'apps/web/src/routes/EasySetup.tsx',
      'apps/web/src/routes/EasyAgentView.tsx',
      'apps/web/src/routes/AgentPage.tsx',
      'apps/api/src/routes/easy.ts',
    ]) {
      expect(read(file), file).not.toMatch(/\{\s*what:\s*string;\s*fix:\s*string\s*\}/);
    }
    expect(blockerSchema.parse({ what: 'a', fix: 'b', where: 'account' }).where).toBe('account');
    expect(() => blockerSchema.parse({ what: 'a', fix: 'b' })).toThrow();
  });
});
