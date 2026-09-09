import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const wizard = readFileSync(resolve(root, 'apps/web/src/routes/EasySetup.tsx'), 'utf8');
const agentView = readFileSync(resolve(root, 'apps/web/src/routes/EasyAgentView.tsx'), 'utf8');

/**
 * A model id is an identifier, and casing it is how it stops being one.
 *
 * `deepseek-v4-pro` rendered as `Deepseek-v4-pro` is not the string the
 * provider answers to, and somebody copying it out of the interface into a
 * config file gets a 404 from a screen that looked right.
 *
 * The setup wizard was fixed for this and the Easy agent view was not, because
 * nothing pinned the property -- so the same defect sat one screen over for a
 * release, and the agent page showed the same model two ways at once: `Model
 * Deepseek-v4-pro` in the summary and `deepseek-v4-pro` in the Intelligence
 * section directly below it.
 *
 * Both summary rows take a `verbatim` flag that turns the casing off. These
 * tests hold each screen to using it where an id is rendered, and hold the
 * components to actually honouring it.
 */
describe('a model id is never cased for display', () => {
  it('the setup review passes the saved model through verbatim', () => {
    const row = wizard.slice(wizard.indexOf('label="AI"'), wizard.indexOf('label="Replies"'));
    expect(row).toContain('savedPrimary.model');
    expect(row).toContain('verbatim');
  });

  it('the agent summary passes its model through verbatim', () => {
    const line = agentView.slice(agentView.indexOf('label="Model"'), agentView.indexOf('label="Through"'));
    expect(line).toContain('model.model');
    expect(line).toContain('verbatim');
  });

  it('neither component cases a value it was told is verbatim', () => {
    // The two casing rules in play: `capitalize` in the wizard's review rows and
    // `first-letter:uppercase` in the agent summary. Both must sit on the
    // not-verbatim branch of the same conditional.
    for (const [name, source, casing] of [
      ['EasySetup', wizard, 'capitalize'],
      ['EasyAgentView', agentView, 'first-letter:uppercase'],
    ] as const) {
      expect(source, `${name} lost its casing rule`).toContain(casing);
      // `verbatim ? <mono> : <casing>` -- the casing never applies unconditionally.
      const pattern = new RegExp(`verbatim \\? [^:]+ : '${casing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
      expect(source, `${name} applies ${casing} regardless of verbatim`).toMatch(pattern);
    }
  });

  it('the label beside it is still prose', () => {
    // Only the value is an identifier. "Through" naming the provider, and every
    // other line, still reads as a sentence.
    const through = agentView.slice(agentView.indexOf('label="Through"'), agentView.indexOf('label="Through"') + 120);
    expect(through).not.toContain('verbatim');
  });
});
