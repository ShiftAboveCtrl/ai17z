import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, renderTemplate } from '@xbam/prompts';

/**
 * Sections nest, and for a long time they did not.
 *
 * The default reply template puts the parent post's attachments inside the
 * block for the parent post itself, which is the obvious way to write it. A
 * single left-to-right pass takes the outer body as literal text, so the inner
 * markers were emitted verbatim and the value pass then blanked the variable
 * between them. Every prompt with a post above it -- which is most of them --
 * carried two lines of raw template syntax into the model:
 *
 *   {{#parentAttachments}}
 *   {{/parentAttachments}}
 *
 * Noise, and a plain statement to the model that its prompt was assembled by a
 * machine. Found by reading a prompt that had actually been sent, rather than
 * the template it came from.
 */
describe('sections inside sections', () => {
  const template =
    '{{#parentText}}REPLYING TO\n{{parentText}}\n{{#parentAttachments}}{{parentAttachments}}\n{{/parentAttachments}}{{/parentText}}END';

  it('leaves no template syntax behind when the inner value is empty', () => {
    const out = renderTemplate(template, { parentText: 'GM', parentAttachments: '' });
    expect(out).not.toContain('{{');
    expect(out).toContain('GM');
  });

  it('renders the inner block when it has something to say', () => {
    const out = renderTemplate(template, { parentText: 'GM', parentAttachments: 'It carries a chart.' });
    expect(out).toContain('It carries a chart.');
    expect(out).not.toContain('{{');
  });

  it('drops the whole thing when the outer value is empty', () => {
    const out = renderTemplate(template, { parentText: '', parentAttachments: 'never seen' });
    expect(out).toBe('END');
  });

  it('handles three deep', () => {
    const deep = '{{#a}}A{{#b}}B{{#c}}C{{/c}}{{/b}}{{/a}}';
    expect(renderTemplate(deep, { a: '1', b: '1', c: '1' })).toBe('ABC');
    expect(renderTemplate(deep, { a: '1', b: '1', c: '' })).toBe('AB');
    expect(renderTemplate(deep, { a: '1', b: '', c: '1' })).toBe('A');
  });

  it('inverts correctly when nested', () => {
    const t = '{{#a}}A{{^b}}no-b{{/b}}{{/a}}';
    expect(renderTemplate(t, { a: '1', b: '' })).toBe('Ano-b');
    expect(renderTemplate(t, { a: '1', b: 'yes' })).toBe('A');
  });
});

/**
 * The shipped templates, not fixtures of them.
 *
 * A template is content rather than code, so nothing typechecks it. Rendering
 * every layer of every default template with a plausible set of values and
 * asserting that no markers survive is the only thing standing between a
 * malformed section and a prompt that shows its own scaffolding to the model.
 */
describe('every layer of every default template', () => {
  const values: Record<string, string> = {
    channelName: 'X',
    parentText: 'GM',
    parentAttachments: 'It carries a chart.',
    incomingText: 'what is this',
    authorHandle: '@someone',
    threadState: 'They asked about fees twice.',
    threadTranscript: 'them: hi\nme: hello',
    researchBlock: 'Web search - something',
    mediaBlock: '- image: a chart',
    quotedBlock: 'they quoted someone',
    linksBlock: '- https://example.com',
  };

  for (const template of DEFAULT_TEMPLATES) {
    for (const layer of template.layers) {
      it(`${template.key} / ${layer.key} renders clean`, () => {
        const filled = renderTemplate(layer.template, values);
        expect(filled).not.toContain('{{');
        // And with everything empty, which is the other half of the range.
        const bare = renderTemplate(layer.template, {});
        expect(bare).not.toContain('{{');
      });
    }
  }
});
