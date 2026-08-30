import { describe, expect, it } from 'vitest';
import { CHARACTER_QUESTIONS, CharacterAnswers } from '@xbam/shared/contracts';
import {
  answersToCharacter,
  answersToProhibited,
  characterTemplate,
  describePrompt,
  parseCharacterJson,
  parseFilledTemplate,
  scoreCharacter,
} from '@xbam/runtime';

/**
 * Three ways in, one shape out.
 *
 * A character typed by hand, one a model built from a paragraph, and one
 * brought back on a filled-in template have to be the same depth, or the easy
 * routes quietly produce worse agents than the tedious one. That is what the
 * shared question list and the completeness score are for.
 */

const FULL = CharacterAnswers.parse({
  name: 'Atlas',
  description: 'Watches protocol governance and says what changed.',
  personality: 'Sceptical, patient, allergic to hype and to being managed.',
  tone: 'Dry and unhurried. Never performs enthusiasm.',
  caresAbout: ['governance', 'token distribution', 'incentives'],
  speaksLike: 'Two sentences. States the fact, then the consequence. No hedging.',
  examples: ['Distribution changed. The vote did not.', 'That number is annualised. It should not be.'],
  opinions: ['Most governance votes are theatre.', 'Fees are a design choice, not a law of nature.'],
  avoids: ['Never give price predictions.', 'Never call anything a rug.'],
  audience: 'People who already read the forum posts.',
});

describe('scoring how complete a character is', () => {
  it('gives a full answer set a high score and nothing missing', () => {
    const result = scoreCharacter(FULL);
    expect(result.score).toBeGreaterThan(90);
    expect(result.missing).toEqual([]);
  });

  it('scores an empty one at zero and names every question', () => {
    const result = scoreCharacter({});
    expect(result.score).toBe(0);
    expect(result.missing).toHaveLength(CHARACTER_QUESTIONS.length);
    // The missing entries say why, not just what.
    expect(result.missing[0]!.why.length).toBeGreaterThan(10);
  });

  it('does not count a two-word answer as an answer', () => {
    // "Funny" is a field somebody skipped, and scoring it as complete helps
    // nobody: the agent that results is the one that reads like everything else.
    const thin = scoreCharacter({ ...FULL, personality: 'funny' });
    expect(thin.missing.some((m) => m.key === 'personality')).toBe(true);
    expect(thin.score).toBeLessThan(scoreCharacter(FULL).score);
  });

  it('weighs examples most heavily', () => {
    const withoutExamples = scoreCharacter({ ...FULL, examples: [] });
    const withoutAudience = scoreCharacter({ ...FULL, audience: '' });
    // A model imitates examples and only approximates adjectives, so losing
    // them has to cost more than losing anything else.
    expect(withoutExamples.score).toBeLessThan(withoutAudience.score);
  });
});

describe('reading what a model sent back', () => {
  it('accepts clean JSON', () => {
    const result = parseCharacterJson(JSON.stringify(FULL));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.name).toBe('Atlas');
  });

  it('accepts JSON in a code fence, which is what models actually do', () => {
    const result = parseCharacterJson('```json\n' + JSON.stringify(FULL) + '\n```');
    expect(result.ok).toBe(true);
  });

  it('accepts a sentence of preamble before the object', () => {
    const result = parseCharacterJson(`Here is the character you asked for:\n${JSON.stringify(FULL)}\nHope that helps!`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.examples).toHaveLength(2);
  });

  it('turns a comma-separated string into the array that was asked for', () => {
    // Models return this often enough that rejecting it is pedantry.
    const result = parseCharacterJson(
      JSON.stringify({ ...FULL, caresAbout: 'governance, token distribution, incentives' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.caresAbout).toEqual(['governance', 'token distribution', 'incentives']);
  });

  it('strips list markers from a pasted list', () => {
    const result = parseCharacterJson(JSON.stringify({ ...FULL, opinions: '1. First one\n2. Second one' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.opinions).toEqual(['First one', 'Second one']);
  });

  it('says so rather than guessing when there is no JSON', () => {
    const result = parseCharacterJson('I would be happy to help you build a character!');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('looks like JSON');
  });

  it('reports broken JSON as broken JSON', () => {
    const result = parseCharacterJson('{ "name": "Atlas", }{{{');
    expect(result.ok).toBe(false);
  });
});

describe('the template somebody hands to another assistant', () => {
  const template = characterTemplate();

  it('asks every question the system actually reads', () => {
    // Generated from the same list, so it cannot drift from what AI17Z uses.
    for (const question of CHARACTER_QUESTIONS) {
      expect(template).toContain(question.key);
      expect(template).toContain(question.ask);
    }
  });

  it('ends with a JSON block that parses back', () => {
    const result = parseFilledTemplate(template);
    // Empty, but the right shape: this is what gets filled in.
    expect(result.ok).toBe(true);
  });

  it('tells whoever fills it in that examples matter most', () => {
    expect(template.toLowerCase()).toContain('examples');
    expect(template).toContain('not descriptions of what they');
  });

  it('reads a filled-in one back', () => {
    const filled = template.replace(/```json[\s\S]*?```/, '```json\n' + JSON.stringify(FULL, null, 2) + '\n```');
    const result = parseFilledTemplate(filled);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answers.name).toBe('Atlas');
      expect(result.answers.examples).toHaveLength(2);
    }
  });
});

describe('the instruction given to the model', () => {
  const prompt = describePrompt('A dry comedian who talks about airports and refuses to explain jokes.');

  it('carries what the person wrote', () => {
    expect(prompt).toContain('airports');
  });

  it('asks for every field, with the reason', () => {
    for (const question of CHARACTER_QUESTIONS) expect(prompt).toContain(question.key);
  });

  it('insists examples are sentences rather than descriptions', () => {
    expect(prompt).toContain('Not descriptions of what they would say');
  });

  it('forbids inventing checkable biography', () => {
    expect(prompt).toContain('biographical facts');
  });
});

describe('turning answers into a character', () => {
  it('keeps the fields Easy Mode and the persona both use', () => {
    const character = answersToCharacter(FULL);
    expect(character.name).toBe('Atlas');
    expect(character.caresAbout).toEqual(['governance', 'token distribution', 'incentives']);
    expect(character.examples).toHaveLength(2);
    expect(character.tone).toContain('Dry');
  });

  it('folds opinions into the style guidance, where they change what gets said', () => {
    const character = answersToCharacter(FULL);
    expect(character.speaksLike).toContain('governance votes are theatre');
  });

  it('folds the audience into the personality', () => {
    expect(answersToCharacter(FULL).personality).toContain('forum posts');
  });

  it('turns "would never" into the prohibited list the validator enforces', () => {
    // Not a prompt suggestion: prohibited behaviours are checked on the output.
    expect(answersToProhibited(FULL)).toEqual(['Never give price predictions.', 'Never call anything a rug.']);
  });

  it('survives a half-filled answer set', () => {
    const character = answersToCharacter(CharacterAnswers.parse({ name: 'Half' }));
    expect(character.name).toBe('Half');
    expect(character.examples).toEqual([]);
  });
});
