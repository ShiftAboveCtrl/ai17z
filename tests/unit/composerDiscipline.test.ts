import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineError } from '@xbam/shared';
import { X_PLAIN_POST_CHARS, fillComposer, readyForTyping, requirePostButton, submitComposer, typingOptions } from '@xbam/channels';

/**
 * What has to be true before AI17Z types into X, and before it submits.
 *
 * These pin a bug that was visible from across the room on a live account: the
 * reply began typing, arrived missing its first characters, was cleared, and
 * was typed again. A live observation of the running browser caught the
 * composer holding 87 characters of a 186 character draft.
 *
 * The old code was two swallowed results in a row:
 *
 *   await editor.focus().catch(() => undefined);
 *   await editor.type(text, { delay: 12 }).catch(() => undefined);
 *
 * so focus landing on X's @-mention typeahead instead of the editor, or the
 * editor being re-rendered mid-type, both produced a short draft that nothing
 * noticed until the check below it failed and cleared everything -- and that
 * check only compared the first sixty characters, so a draft correct at the
 * start and truncated later passed it.
 *
 * The fakes run the *real* predicates rather than standing in for them:
 * `readyForTyping` asks the node for `isContentEditable` and compares against
 * `document.activeElement`, so both are provided and the production callbacks
 * execute unchanged.
 */

interface FakeDoc {
  activeElement: unknown;
}

afterEach(() => {
  delete (globalThis as unknown as { document?: FakeDoc }).document;
});

interface EditorOptions {
  /** Whether X has wired the editor behind the node yet. */
  editable?: boolean;
  visible?: boolean;
  /** How many typing attempts go wrong before one succeeds. */
  badAttempts?: number;
  /** How a bad attempt goes wrong. */
  mangle?: { dropLeading?: number; keepFirst?: number; focusStolen?: boolean };
  /** The composer has gone, as it does once X accepts a reply. */
  detached?: boolean;
}

function fakeEditor(options: EditorOptions = {}) {
  const elsewhere = { name: 'x-typeahead' };
  const state = { text: '', attempts: 0, calls: [] as string[], typed: [] as unknown[], detached: options.detached ?? false };
  const bad = () => state.attempts < (options.badAttempts ?? 0);

  const self = {
    state,
    isContentEditable: options.editable ?? true,
    contains(node: unknown) {
      return node === self;
    },

    async waitFor(opts?: { state?: string }) {
      if (opts?.state === 'detached') {
        if (!state.detached) throw new Error('still attached');
        return;
      }
      if (options.visible === false) throw new Error('not visible');
    },
    async evaluate(fn: (el: unknown) => unknown) {
      return fn(self);
    },
    async focus() {
      state.calls.push('focus');
      const stolen = bad() && options.mangle?.focusStolen === true;
      (globalThis as unknown as { document: FakeDoc }).document = {
        activeElement: stolen ? elsewhere : self,
      };
    },
    async type(value: string, typing?: unknown) {
      state.calls.push('type');
      state.typed.push(typing);
      const broken = bad();
      state.attempts += 1;
      if (!broken) {
        state.text += value;
        return;
      }
      if (options.mangle?.keepFirst !== undefined) {
        state.text += value.slice(0, options.mangle.keepFirst);
        // A re-render mid-type throws; the old code discarded this.
        throw new Error('Element is not attached to the DOM');
      }
      state.text += value.slice(options.mangle?.dropLeading ?? 0);
    },
    async innerText() {
      return state.text;
    },
  };
  return self;
}

function fakePage(editor: ReturnType<typeof fakeEditor>) {
  const keys: string[] = [];
  return {
    keys,
    keyboard: {
      async press(key: string) {
        keys.push(key);
        // Select-all then Delete empties the editor, as in a real browser.
        if (key === 'Delete') editor.state.text = '';
      },
    },
  };
}

function fakeScope(options: { enabled?: boolean; clickWorks?: boolean } = {}) {
  const clicks: string[] = [];
  const button = {
    async waitFor() {
      /* visible */
    },
    async isEnabled() {
      return options.enabled ?? true;
    },
    async click() {
      clicks.push('click');
      if (options.clickWorks === false) throw new Error('element is covered by another element');
    },
  };
  return { clicks, locator: () => ({ first: () => button }) };
}

const DRAFT = 'AI17Z is getting much better.';
const LONG =
  'You are right to watch the tech, not the volume. I am an AI17Z agent testing pre-release features in public.';

describe('nothing is typed until the editor can take a keystroke', () => {
  it('refuses a node X has not made editable yet', async () => {
    const editor = fakeEditor({ editable: false });
    await expect(readyForTyping(editor as never)).rejects.toThrow(/not accepting input/i);
    expect(editor.state.calls).not.toContain('type');
  });

  it('refuses when focus landed somewhere else', async () => {
    // X's @-mention typeahead opens over the composer and takes focus. This is
    // the condition that ate the first characters.
    const editor = fakeEditor({ badAttempts: 1, mangle: { focusStolen: true } });
    await expect(readyForTyping(editor as never)).rejects.toThrow(/focus did not land/i);
    expect(editor.state.calls).not.toContain('type');
  });

  it('refuses when the composer never becomes visible', async () => {
    const editor = fakeEditor({ visible: false });
    await expect(readyForTyping(editor as never)).rejects.toThrow(/did not become visible/i);
  });

  it('accepts an editor that is editable and holds focus', async () => {
    await expect(readyForTyping(fakeEditor() as never)).resolves.toBeUndefined();
  });
});

describe('the whole draft is verified, not its first sixty characters', () => {
  it('refuses to submit a draft missing its opening characters', async () => {
    // The regression in the exact shape the brief names:
    //   expected "AI17Z is getting much better."
    //   actual   "17Z is getting much better."
    const editor = fakeEditor({ badAttempts: 9, mangle: { dropLeading: 2 } });
    await expect(fillComposer(fakePage(editor) as never, editor as never, DRAFT)).rejects.toThrow(
      /composer holds/i,
    );
  });

  it('refuses a draft cut off after the first sixty characters', async () => {
    // The live failure: correct at the start, truncated later. The old check
    // compared `fingerprint(text).slice(0, 60)`, so exactly this passed it.
    const editor = fakeEditor({ badAttempts: 9, mangle: { keepFirst: 87 } });
    await expect(fillComposer(fakePage(editor) as never, editor as never, LONG)).rejects.toThrow(
      /composer holds/i,
    );
    expect(editor.state.text.length).toBeLessThan(LONG.length);
    expect(editor.state.text.length).toBeGreaterThan(60);
  });

  it('accepts a draft that arrived whole', async () => {
    const editor = fakeEditor();
    await expect(fillComposer(fakePage(editor) as never, editor as never, DRAFT)).resolves.toBe(DRAFT);
  });

  it('recovers on a bounded second attempt rather than looping', async () => {
    // Attempt one loses the opening; attempt two is clean. Recovery still
    // exists -- it is no longer the mechanism.
    const editor = fakeEditor({ badAttempts: 1, mangle: { dropLeading: 6 } });
    await expect(fillComposer(fakePage(editor) as never, editor as never, DRAFT)).resolves.toBe(DRAFT);
    // Exactly two. An unbounded open/type/clear/reopen cycle is what a person
    // was watching happen on screen.
    expect(editor.state.calls.filter((c) => c === 'type')).toHaveLength(2);
  });
});

describe('submitting happens once', () => {
  it('clicks once and does not also press the keyboard', async () => {
    const scope = fakeScope();
    const editor = fakeEditor();
    const page = fakePage(editor);

    const how = await submitComposer(page as never, { scope, editor } as never);

    expect(how).toBe('clicked');
    expect(scope.clicks).toHaveLength(1);
    expect(page.keys).toHaveLength(0);
  });

  it('does not press the keyboard when a failed click actually landed', async () => {
    // The dangerous case, and the reason this function returns a verdict.
    // Playwright can report a click failed after dispatching it; following that
    // with Control+Enter sends the same reply twice. The composer letting go is
    // the evidence that the click went through.
    const scope = fakeScope({ clickWorks: false });
    const editor = fakeEditor({ detached: true });
    const page = fakePage(editor);

    const how = await submitComposer(page as never, { scope, editor } as never);

    expect(how).toBe('clicked');
    expect(scope.clicks).toHaveLength(1);
    // This assertion is the one that stops a double post.
    expect(page.keys).toHaveLength(0);
  });

  it('uses the keyboard only when the composer plainly still holds the draft', async () => {
    const scope = fakeScope({ clickWorks: false });
    const editor = fakeEditor();
    await editor.type(DRAFT);
    const page = fakePage(editor);

    const how = await submitComposer(page as never, { scope, editor } as never);

    expect(how).toBe('keyboard');
    expect(scope.clicks).toHaveLength(1);
    expect(page.keys).toHaveLength(1);
  });
});

describe('a long post, for an account that has long posts', () => {
  const LONG_POST = 'replies keep their thread through a worker restart now, so long chats stop losing context. '.repeat(40).trim();

  it('types the whole text in one pass, with time to finish, and never cuts it', async () => {
    expect([...LONG_POST].length).toBeGreaterThan(3000);
    const editor = fakeEditor();
    await expect(fillComposer(fakePage(editor) as never, editor as never, LONG_POST)).resolves.toBe(LONG_POST);
    expect(editor.state.text).toBe(LONG_POST);
    expect(editor.state.calls.filter((c) => c === 'type')).toHaveLength(1);
    // Focused for the keystrokes, never clicked.
    expect(editor.state.calls).toContain('focus');
    expect(editor.state.calls).not.toContain('click');

    const [typing] = editor.state.typed as Array<{ delay: number; timeout: number }>;
    // Playwright's own 30 seconds would end a draft this long mid-sentence.
    expect(typing!.timeout).toBeGreaterThan(typing!.delay * [...LONG_POST].length);
  });

  it('keeps the unhurried typing for an ordinary post', () => {
    expect(typingOptions(DRAFT)).toEqual({ delay: 12, timeout: 30_000 + DRAFT.length * 20 });
    expect(typingOptions('x'.repeat(25_000)).timeout).toBeGreaterThan(25_000 * 3);
  });

  describe('when X will not enable the post button', () => {
    const disabledButton = () => {
      const checks = { count: 0 };
      return {
        checks,
        async isEnabled() {
          checks.count += 1;
          return false;
        },
      };
    };

    it('fails a draft over 280 characters at once, in a sentence, as something a retry cannot fix', async () => {
      vi.useFakeTimers();
      try {
        const button = disabledButton();
        const outcome = requirePostButton(button as never, LONG_POST).then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(11_000);
        const error = (await outcome) as PipelineError;

        expect(error).toBeInstanceOf(PipelineError);
        expect(error.reason).toBe('post_too_long_for_account');
        expect(error.errorClass).toBe('PERMANENT');
        expect(error.message).toMatch(new RegExp(`${[...LONG_POST].length} characters`));
        expect(error.message).toMatch(/long posts/i);
        expect(error.message).toMatch(/not shortened/i);
        // One ten second wait for the button, not a second round of anything.
        expect(button.checks.count).toBeLessThan(60);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails a thread part over 280 characters permanently, as replyOnPage now asks before submit', async () => {
      vi.useFakeTimers();
      try {
        const part = 'b'.repeat(300);
        const outcome = requirePostButton(disabledButton() as never, part).then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(11_000);
        const error = (await outcome) as PipelineError;
        expect(error.reason).toBe('post_too_long_for_account');
        expect(error.errorClass).toBe('PERMANENT');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the old retryable answer for a draft within 280', async () => {
      vi.useFakeTimers();
      try {
        const outcome = requirePostButton(disabledButton() as never, DRAFT).then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(11_000);
        const error = (await outcome) as PipelineError;
        expect(error.reason).toBe('post_button_disabled');
        expect(error.errorClass).toBe('RETRYABLE');
        expect([...DRAFT].length).toBeLessThanOrEqual(X_PLAIN_POST_CHARS);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets a long draft through when X enables the button', async () => {
      await expect(requirePostButton({ isEnabled: async () => true } as never, LONG_POST)).resolves.toBeUndefined();
    });
  });
});
