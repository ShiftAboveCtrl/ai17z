import { describe, expect, it } from 'vitest';
import { reticenceReason, reticentSubjects, unpromptedSubject } from '@xbam/runtime';

/**
 * What an agent will not bring up by itself.
 *
 * The cases that matter here are the two kinds of mistake, and they are not
 * equally bad. A subject that slips through becomes an unprompted public
 * opinion on somebody's real account; a sentence about software that is refused
 * becomes an idea that never got posted and that nobody misses. So the list
 * leans towards refusing -- and the tests below pin both halves, because a list
 * that refuses everything protects nothing anybody would keep switched on.
 */
describe('subjects an agent does not raise on its own', () => {
  it('declines an opinion about an election', () => {
    const found = unpromptedSubject('The election result says more about turnout than about policy.');
    expect(found?.subject).toBe('party politics and elections');
    expect(found?.matched).toBe('election');
  });

  it('declines a position on a war', () => {
    expect(unpromptedSubject('Nobody is talking about the ceasefire terms.')?.subject).toBe('war and armed conflict');
  });

  it('declines volunteering what somebody should do with their money', () => {
    expect(unpromptedSubject('Honestly you should buy the dip here.')?.subject).toBe(
      'what somebody should do with their money',
    );
  });

  it('declines medical advice', () => {
    expect(unpromptedSubject('Half that dosage would have been plenty.')?.subject).toBe('medical advice');
  });

  it('says which word it found, so a wrong refusal can be argued with', () => {
    const found = unpromptedSubject('The lawsuit is the interesting part.');
    expect(found).toEqual({ subject: 'legal advice', matched: 'lawsuit' });
  });

  it('explains itself in a sentence an owner can read', () => {
    const found = unpromptedSubject('The referendum changed nothing.')!;
    expect(reticenceReason(found)).toContain('does not start the conversation');
    expect(reticenceReason(found)).toContain('party politics and elections');
  });

  /*
    The false-positive half. Every sentence below is ordinary vocabulary for an
    agent whose whole subject is software, and each one contains a word that
    sits inside a subject above or looks like it should. An agent that cannot
    say "the worker died mid-job" is not safer, it is broken, and an owner
    switches it off -- which protects nothing.
  */
  it.each([
    'The worker died mid-job and the recovery sweep resumed it.',
    'My diagnosis was that esbuild renamed the function.',
    'The side effects of that change are all in one module.',
    'Release Candidate 1.0.0 is the next tag.',
    'I woke up to a green build for once.',
    'Warranty on this laptop ran out months ago.',
    'Two alarms fired before anybody looked at the dashboard.',
    'We settled on Postgres because the unique indexes carry the guarantees.',
  ])('does not refuse ordinary engineering talk: %s', (sentence) => {
    expect(unpromptedSubject(sentence)).toBeNull();
  });

  it('matches on word boundaries rather than substrings', () => {
    // "war" inside "warranty", "arms" inside "alarms" -- the failure mode
    // subjectsIn already names.
    expect(unpromptedSubject('The warranty covers it.')).toBeNull();
    expect(unpromptedSubject('The war is the story.')?.subject).toBe('war and armed conflict');
  });

  it('says nothing about empty text', () => {
    expect(unpromptedSubject('')).toBeNull();
    expect(unpromptedSubject('   ')).toBeNull();
  });

  it('lists its subjects for the screen that explains the rule', () => {
    const subjects = reticentSubjects();
    expect(subjects.length).toBeGreaterThan(4);
    expect(subjects).toContain('party politics and elections');
    // Read by a person, so they are sentences rather than constant names.
    for (const subject of subjects) expect(subject).toBe(subject.toLowerCase());
  });
});
