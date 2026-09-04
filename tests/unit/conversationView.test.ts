import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../apps/web/src/components/ConversationView.tsx'), 'utf8');

/**
 * The conversation as AI17Z understood it, in order.
 *
 * What goes wrong with a nested mention is invisible in a flat list: a mention
 * four levels down reads identically to one at the top, and the difference is
 * the entire reason replies used to land on the wrong post.
 */
describe('showing the conversation the way the runtime saw it', () => {
  it('lays out the chain in order, root first', () => {
    // The Turn labels specifically, not the heading above them, which uses
    // some of the same words.
    const at = (label: string) => source.indexOf(`label="${label}"`);
    const rootAt = at('Root of the thread');
    const parentAt = at('The post above');
    const incomingAt = at('What it was answering');
    const replyAt = at('What your agent said');

    expect(rootAt).toBeGreaterThan(-1);
    expect(parentAt).toBeGreaterThan(rootAt);
    expect(incomingAt).toBeGreaterThan(parentAt);
    expect(replyAt).toBeGreaterThan(incomingAt);
  });

  it('shows what was used', () => {
    for (const used of ['Looked up', 'Remembered', 'Who this is', 'Whether to answer']) {
      expect(source, `${used} should be shown`).toContain(used);
    }
  });

  it('shows a lookup that failed, not only the ones that worked', () => {
    // The difference between "did not check" and "could not", which is what
    // tells somebody whether an answer had a hole in it.
    expect(source).toContain('did not work');
  });

  it('exposes no chain-of-thought', () => {
    // Not stored, not shown. An explanation reconstructed afterwards would be a
    // plausible story rather than a record, which is worse than nothing.
    for (const forbidden of ['reasoning', 'chain-of-thought', 'thoughts', 'scratchpad']) {
      const body = source.slice(source.indexOf('export function ConversationView'));
      expect(body.toLowerCase(), `${forbidden} must not be rendered`).not.toContain(`{${forbidden}`);
    }
  });

  it('wraps machine-generated text, which is most of what it shows', () => {
    // Handles, URLs and quoted posts push a layout wider than a phone.
    expect(source).toContain('break-words');
  });
});
