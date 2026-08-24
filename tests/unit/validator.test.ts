import { describe, expect, it } from 'vitest';
import { PolicyConfig } from '@xbam/shared/contracts';
import { validateOutput } from '@xbam/runtime';

const policy = (overrides: Record<string, unknown> = {}) => PolicyConfig.parse(overrides);

describe('validateOutput', () => {
  it('strips wrapping quotes and records the repair', () => {
    const result = validateOutput('"Just a reply."', policy());
    expect(result.ok).toBe(true);
    expect(result.output).toBe('Just a reply.');
    expect(result.violations.map((v) => v.rule)).toContain('wrapping_quotes');
    expect(result.violations.every((v) => v.severity === 'REPAIRED')).toBe(true);
  });

  it('removes a leading label the model added despite instructions', () => {
    const result = validateOutput('Reply: markets do what they do.', policy());
    expect(result.output).toBe('markets do what they do.');
    expect(result.violations.map((v) => v.rule)).toContain('label_prefix');
  });

  it('rejects empty output rather than dropping the job silently', () => {
    const result = validateOutput('   \n  ', policy());
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.rule).toBe('empty_output');
    expect(result.violations[0]?.severity).toBe('REJECT');
  });

  it('trims over-length output at a sentence boundary and says so', () => {
    const text = 'First sentence here. Second sentence that pushes it over the configured limit entirely.';
    const result = validateOutput(text, policy({ output: { maxCharacters: 40 } }));
    expect(result.ok).toBe(true);
    expect(result.output).toBe('First sentence here.');
    const violation = result.violations.find((v) => v.rule === 'max_length');
    expect(violation?.severity).toBe('REPAIRED');
    expect(violation?.message).toContain('40');
  });

  it('escalates when trimming would destroy the message', () => {
    const result = validateOutput('A single very long unbroken statement without punctuation at all', policy({
      output: { maxCharacters: 12, minCharacters: 30 },
    }));
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === 'max_length' && v.severity === 'REVIEW')).toBe(true);
  });

  it('rejects a claim of being human unless the policy explicitly permits it', () => {
    const claim = 'I am not a bot, I promise.';
    const strict = validateOutput(claim, policy());
    expect(strict.ok).toBe(false);
    expect(strict.violations.some((v) => v.rule === 'identity_claim' && v.severity === 'REJECT')).toBe(true);

    const permitted = validateOutput(claim, policy({ identity: { mayDenyBeingAI: true } }));
    expect(permitted.violations.some((v) => v.rule === 'identity_claim')).toBe(false);
  });

  it('flags a missing disclosure when the policy requires one every time', () => {
    const result = validateOutput('Markets move.', policy({ identity: { disclosure: 'ALWAYS' } }));
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === 'disclosure_missing')).toBe(true);
  });

  it('accepts output that carries the required disclosure', () => {
    const result = validateOutput('As an AI agent: markets move.', policy({ identity: { disclosure: 'ALWAYS' } }));
    expect(result.ok).toBe(true);
  });

  it('removes hashtag markers when the policy forbids them', () => {
    const result = validateOutput('Bullish on #bitcoin today', policy({ output: { forbidHashtags: true } }));
    expect(result.output).toBe('Bullish on bitcoin today');
    expect(result.ok).toBe(true);
  });

  it('rejects banned phrases outright', () => {
    const result = validateOutput('This is financial advice.', policy({ output: { bannedPhrases: ['financial advice'] } }));
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.severity === 'REJECT')).toBe(true);
  });
});
