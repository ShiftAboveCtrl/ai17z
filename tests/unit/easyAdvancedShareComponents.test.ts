import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/**
 * Easy and Advanced must stay two views, not two applications.
 *
 * The tempting way to give Easy Mode an accounts panel is to write a simpler
 * one. Then connecting an account works differently depending on which screen
 * somebody used, a fix lands in one and not the other, and the claim that there
 * is a single configuration system quietly stops being true.
 *
 * So Easy renders the same components Advanced does, in a compact presentation.
 * That is the property worth pinning: not which fields appear, but that there
 * is only one implementation of each.
 */
describe('Easy Mode reuses the Advanced sections', () => {
  const easy = read('apps/web/src/routes/EasyAgentView.tsx');

  for (const section of ['AccountsSection', 'IntelligenceSection', 'VoiceSection']) {
    it(`uses the real ${section}`, () => {
      expect(easy).toContain(`<${section} `);
      expect(easy).toContain(`from './sections/${section}'`);
    });
  }

  it('renders them compactly rather than with the full section chrome', () => {
    // Same component, different presentation. If this ever needs a second
    // component instead, that is the moment the two views have diverged.
    const uses = [...easy.matchAll(/<(Accounts|Intelligence|Voice)Section[^>]*>/g)].map((m) => m[0]);
    expect(uses.length).toBe(3);
    for (const use of uses) expect(use, use).toContain('compact');
  });

  it('the sections accept the compact presentation', () => {
    for (const file of ['AccountsSection', 'IntelligenceSection', 'VoiceSection', 'Section']) {
      expect(read(`apps/web/src/routes/sections/${file}.tsx`), file).toContain('compact');
    }
  });

  it('Easy Mode can reach everything a person needs to start an agent', () => {
    // Identity, accounts, a model and a voice test. Being told to "connect an
    // X account" with nowhere to go is what this replaces.
    expect(easy).toMatch(/Character/);
    expect(easy).toMatch(/AccountsSection/);
    expect(easy).toMatch(/IntelligenceSection/);
    expect(easy).toMatch(/VoiceSection/);
    expect(easy).toMatch(/Replies/);
    expect(easy).toMatch(/Posts/);
    expect(easy).toMatch(/RecentActivity/);
  });
});
