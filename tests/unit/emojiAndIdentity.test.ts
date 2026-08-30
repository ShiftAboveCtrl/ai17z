import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, EmojiPolicy, type PolicyConfig } from '@xbam/shared/contracts';
import { applyEmojiPolicy, countEmoji, validateOutput } from '@xbam/runtime';

/**
 * Two rules an agent must not be able to get around.
 *
 * Emoji, because a model left to itself decorates every sentence and an account
 * that does that reads as a bot to every human who sees it. Telling the model to
 * go easy helps and does not hold, so the finished text is trimmed.
 *
 * And what is running the agent, which is nobody's business but the operator's.
 * There is no policy field for that one: an agent may say it is an AI17Z agent
 * and nothing further, and no setting changes it.
 */

function policyWith(emoji: Record<string, unknown>): PolicyConfig {
  return {
    ...DEFAULT_POLICY,
    output: { ...DEFAULT_POLICY.output, emoji: EmojiPolicy.parse(emoji) },
  };
}

describe('counting emoji', () => {
  it('counts multi-codepoint emoji as one, not as their pieces', () => {
    // A family is five codepoints joined by zero-width joiners. Counting the
    // pieces would report five, and stripping them would leave debris.
    expect(countEmoji('👨‍👩‍👧‍👦')).toBe(1);
    expect(countEmoji('👍🏽')).toBe(1);
    expect(countEmoji('🇬🇧')).toBe(1);
    expect(countEmoji('1️⃣')).toBe(1);
    expect(countEmoji('nice 🎉 work 🚀')).toBe(2);
  });

  it('does not mistake ordinary punctuation or digits for emoji', () => {
    expect(countEmoji('Revenue rose 12% in Q3 — up from 8%.')).toBe(0);
    expect(countEmoji('#1 and *bold* and 42')).toBe(0);
  });
});

describe('no emoji at all', () => {
  const policy = EmojiPolicy.parse({ use: 'NONE' });

  it('removes every one', () => {
    const out = applyEmojiPolicy('Great news 🎉 shipping today 🚀', policy);
    expect(countEmoji(out.text)).toBe(0);
    expect(out.removed).toBe(2);
    expect(out.reason).toContain('uses none');
  });

  it('leaves the sentence readable rather than full of gaps', () => {
    const out = applyEmojiPolicy('Great news 🎉 shipping today 🚀 .', policy);
    expect(out.text).not.toContain('  ');
    expect(out.text).not.toMatch(/\s\./);
  });

  it('does nothing to text that had none', () => {
    const out = applyEmojiPolicy('Just words.', policy);
    expect(out.text).toBe('Just words.');
    expect(out.removed).toBe(0);
  });
});

describe('minimal emoji', () => {
  it('keeps the first and drops the rest', () => {
    const out = applyEmojiPolicy('a 🎉 b 🚀 c 🔥', EmojiPolicy.parse({ use: 'MINIMAL', maxPerMessage: 1 }));
    expect(countEmoji(out.text)).toBe(1);
    expect(out.text).toContain('🎉');
    expect(out.removed).toBe(2);
  });

  it('honours a higher ceiling', () => {
    const out = applyEmojiPolicy('a 🎉 b 🚀 c 🔥', EmojiPolicy.parse({ use: 'MINIMAL', maxPerMessage: 2 }));
    expect(countEmoji(out.text)).toBe(2);
  });
});

describe('selected emoji only', () => {
  const policy = EmojiPolicy.parse({ use: 'SELECTED', allowed: ['🔥'], maxPerMessage: 2 });

  it('keeps what is on the list and removes what is not', () => {
    const out = applyEmojiPolicy('good 🔥 and 🎉 and 🙈', policy);
    expect(out.text).toContain('🔥');
    expect(out.text).not.toContain('🎉');
    expect(out.text).not.toContain('🙈');
    expect(out.reason).toContain('list');
  });

  it('still applies the ceiling to ones that are on the list', () => {
    const out = applyEmojiPolicy('🔥 🔥 🔥 🔥', policy);
    expect(countEmoji(out.text)).toBe(2);
  });
});

describe('how often, not just how many', () => {
  it('lets some messages through and not others', () => {
    const policy = EmojiPolicy.parse({ use: 'MINIMAL', maxPerMessage: 1, messagesPercent: 25 });
    const allowed = Array.from({ length: 8 }, (_, i) =>
      countEmoji(applyEmojiPolicy('nice 🎉', policy, { messageIndex: i }).text),
    );
    // Roughly a quarter, and crucially not all of them.
    expect(allowed.filter((n) => n > 0).length).toBeGreaterThan(0);
    expect(allowed.filter((n) => n > 0).length).toBeLessThan(8);
  });

  it('does not apply the frequency rule when there is nothing to count against', () => {
    const policy = EmojiPolicy.parse({ use: 'MINIMAL', maxPerMessage: 1, messagesPercent: 25 });
    expect(countEmoji(applyEmojiPolicy('nice 🎉', policy).text)).toBe(1);
  });
});

describe('unrestricted', () => {
  it('leaves everything alone', () => {
    const text = 'a 🎉 b 🚀 c 🔥 d 🙈';
    expect(applyEmojiPolicy(text, EmojiPolicy.parse({ use: 'UNRESTRICTED' })).text).toBe(text);
  });
});

describe('the validator applies it to real output', () => {
  it('repairs rather than rejects', () => {
    const result = validateOutput('Shipping today 🚀🎉🔥', policyWith({ use: 'NONE' }));
    expect(result.ok).toBe(true);
    expect(countEmoji(result.output)).toBe(0);
    expect(result.violations.find((v) => v.rule === 'emoji')?.severity).toBe('REPAIRED');
  });

  it('trims emoji before length, so nothing is cut for decoration', () => {
    // The rockets would push this past a short limit; removing them first means
    // the words survive.
    const base = policyWith({ use: 'NONE' });
    const policy: PolicyConfig = { ...base, output: { ...base.output, maxCharacters: 30 } };
    const result = validateOutput('Fees are a design choice 🚀🚀🚀🚀🚀🚀', policy);
    expect(result.output).toContain('design choice');
    expect(result.violations.some((v) => v.rule === 'max_length')).toBe(false);
  });
});

describe('never naming what runs it', () => {
  const cases = [
    'I am powered by GPT-4.',
    'I am running on Claude, so I can help with that.',
    'My underlying model is DeepSeek v3.',
    'I am a large language model.',
    'My creators are OpenAI.',
  ];

  for (const text of cases) {
    it(`stops "${text.slice(0, 34)}"`, () => {
      const result = validateOutput(text, DEFAULT_POLICY);
      const violation = result.violations.find((v) => v.rule === 'model_disclosure');
      expect(violation, `expected a model_disclosure violation for: ${text}`).toBeDefined();
      // Sent to a person rather than dropped: the reply may be fine apart from
      // this sentence, and a human can cut it.
      expect(violation!.severity).toBe('REVIEW');
    });
  }

  it('cannot be switched off by any policy', () => {
    // mayDenyBeingAI is the one identity setting an operator has. It relaxes the
    // human-claim rule and must not touch this one.
    const permissive: PolicyConfig = {
      ...DEFAULT_POLICY,
      identity: { ...DEFAULT_POLICY.identity, mayDenyBeingAI: true, disclosure: 'NONE' },
    };
    const result = validateOutput('I am powered by OpenAI.', permissive);
    expect(result.violations.some((v) => v.rule === 'model_disclosure')).toBe(true);
  });

  it('leaves ordinary talk about those companies alone', () => {
    const fine = [
      'OpenAI shipped something interesting this week.',
      'Anthropic and Google both published papers on it.',
      'They migrated off DeepSeek last quarter.',
      'The Claude Monet exhibition is worth seeing.',
      'A llama is not a camel.',
    ];
    for (const text of fine) {
      const result = validateOutput(text, DEFAULT_POLICY);
      expect(
        result.violations.some((v) => v.rule === 'model_disclosure'),
        `should not have flagged: ${text}`,
      ).toBe(false);
    }
  });
});
