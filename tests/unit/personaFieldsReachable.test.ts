import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const source = readFileSync(resolve(root, 'apps/web/src/routes/sections/IdentitySection.tsx'), 'utf8');

/**
 * A persona field can be in the schema, be sent on every save, and be rendered
 * into every prompt, while having no input anywhere. That is not a visible
 * failure: the form saves, the version number goes up, and the field keeps
 * whatever it held at creation, which for a new agent is nothing.
 *
 * styleGuidelines and customInstructions were both in that state. Between them
 * they carry how the agent writes and the standing facts it always has to hand,
 * so the two least reachable fields were among the most consequential.
 *
 * The invariant is narrow and mechanical: whatever this form claims to save is
 * something this form can edit.
 */
describe('every persona field the identity form saves is editable in it', () => {
  const payload = source.match(/await put\(`\/api\/agents\/\$\{agentId\}\/persona`, \{([\s\S]*?)\n {6}\}\);/);

  it('the save payload is where this test thinks it is', () => {
    expect(payload).not.toBeNull();
  });

  const saved = [...(payload?.[1] ?? '').matchAll(/^\s{8}(\w+):/gm)]
    .map((m) => m[1])
    // Written by the form itself rather than typed by anyone.
    .filter((key) => key !== 'changeNote');

  it('finds the fields being saved', () => {
    expect(saved.length).toBeGreaterThan(8);
    expect(saved).toContain('styleGuidelines');
    expect(saved).toContain('customInstructions');
  });

  for (const key of saved) {
    it(`${key} has an input bound to it`, () => {
      expect(source).toContain(`set('${key}'`);
    });
  }
});
