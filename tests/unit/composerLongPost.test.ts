import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fillComposer, typingBudgetMs } from '@xbam/channels';

/**
 * A long post must reach the composer whole, or must not be submitted at all.
 *
 * Seen live on 2026-11-12: a 1,438 character post stopped in the composer at
 * about 1,063 characters, and again at 1,084 on the retry. Neither attempt
 * reached X. A 1,750 character post had worked the day before.
 *
 * Cause: the editor was filled with one `locator.type(text, { delay: 12 })`
 * call. That is a single Playwright action with a single deadline, the page
 * default of 30 s, and a keystroke costs about 28 ms once the CDP round trip is
 * counted, so the deadline fell near 1,070 characters. The throw was swallowed,
 * the retry cleared and started over into the same wall.
 *
 * The fake editor enforces that deadline the way Playwright does: it is a
 * virtual clock, so the test takes no real time.
 */

const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 30_000;

let clock = 0;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as { document?: unknown }).document;
});

function longText(chars: number): string {
  const words = 'the quick brown fox jumps over a lazy dog while shipping a release note'.split(' ');
  let out = '';
  for (let i = 0; out.length < chars; i += 1) out += `${words[i % words.length]} `;
  return out.slice(0, chars).trim();
}

function fakeEditor(msPerChar: number) {
  const self = {
    state: { text: '', typeCalls: [] as Array<{ chars: number; timeout: number }> },
    isContentEditable: true,
    contains: (node: unknown) => node === self,
    async waitFor() {
      /* visible, and attached for a detach wait */
    },
    async evaluate(fn: (el: unknown) => unknown) {
      return fn(self);
    },
    async focus() {
      (globalThis as unknown as { document: { activeElement: unknown } }).document = { activeElement: self };
    },
    async type(value: string, opts: { delay?: number; timeout?: number } = {}) {
      const timeout = opts.timeout ?? PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
      self.state.typeCalls.push({ chars: value.length, timeout });
      const fits = Math.min(value.length, Math.floor(timeout / msPerChar));
      self.state.text += value.slice(0, fits);
      clock += fits * msPerChar;
      if (fits < value.length) throw new Error(`Timeout ${timeout}ms exceeded.`);
    },
    async innerText() {
      return self.state.text;
    },
  };
  return self;
}

function fakePage(editor: ReturnType<typeof fakeEditor>) {
  return {
    keyboard: {
      async press(key: string) {
        if (key === 'Delete') editor.state.text = '';
      },
    },
  };
}

describe('a long post is typed whole', () => {
  it('types 1,438 characters at 28 ms a keystroke, past the 30 s action deadline', async () => {
    const text = longText(1438);
    const editor = fakeEditor(28);
    const landed = await fillComposer(fakePage(editor) as never, editor as never, text);
    expect(landed).toBe(text);
    // Typed once, in pieces: no retry was needed, and none of the calls could
    // have hit the deadline that cut the live post at 1,063 characters.
    expect(editor.state.typeCalls.length).toBeGreaterThan(1);
    expect(editor.state.typeCalls.every((c) => c.chars * 28 < c.timeout)).toBe(true);
    expect(editor.state.typeCalls.reduce((n, c) => n + c.chars, 0)).toBe(1438);
  });

  it('types 1,750 characters on the same slow machine', async () => {
    const text = longText(1750);
    const editor = fakeEditor(28);
    await expect(fillComposer(fakePage(editor) as never, editor as never, text)).resolves.toBe(text);
  });
});

describe('a post that cannot be typed in time is never left half-typed for submit', () => {
  it('refuses with a classified, retryable error and does not start a second pass', async () => {
    // 100 ms a keystroke: 1,438 characters would need over two minutes, past the budget.
    const text = longText(1438);
    const editor = fakeEditor(100);
    const error = await fillComposer(fakePage(editor) as never, editor as never, text).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'composer_typing_timeout' });
    expect(editor.state.text.length).toBeLessThan(text.length);
    // One pass only. A second would double the hold on the tab for nothing.
    const sent = editor.state.typeCalls.reduce((n, c) => n + c.chars, 0);
    expect(sent).toBeLessThan(text.length);
  });

  it('refuses a short composer that holds the wrong text (read-back still decides)', async () => {
    const editor = fakeEditor(1);
    // Simulate X eating the tail after typing: the read-back sees a short draft.
    const real = editor.innerText;
    editor.innerText = async () => (await real()).slice(0, -10);
    await expect(
      fillComposer(fakePage(editor) as never, editor as never, longText(300)),
    ).rejects.toMatchObject({ reason: 'composer_text_mismatch' });
  });
});

describe('typing budget', () => {
  it('grows with length and is capped under the tab hold', () => {
    expect(typingBudgetMs(100)).toBeLessThan(typingBudgetMs(1000));
    // Two attempts must fit inside the 180 s tab hold.
    expect(typingBudgetMs(100_000) * 2).toBeLessThan(180_000);
  });
});
