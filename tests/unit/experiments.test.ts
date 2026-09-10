import { describe, expect, it } from 'vitest';
import { assignVariant, readExperiment, type ExperimentDefinition } from '@xbam/runtime';

/**
 * Trying one thing against another at the rate an agent actually posts.
 *
 * Two posts a day means every honest verdict for the first fortnight is "not
 * yet", and a tool that instead announces a winner on Thursday is worse than no
 * tool: the owner acts on it and the agent's voice drifts on the strength of
 * eleven posts. So the usual verdict is TOO_EARLY, and these tests pin that it
 * stays that way.
 */

const experiment: ExperimentDefinition = {
  id: 'length-2026-09',
  hypothesis: 'Shorter posts get more replies.',
  variants: [
    { key: 'short', label: 'Short posts' },
    { key: 'long', label: 'Longer posts' },
  ],
};

const rates = (n: number, value: number) => Array.from({ length: n }, () => value);

describe('assigning a variant', () => {
  it('gives the same answer every time it is asked', () => {
    // A restart between generating a post and publishing it must not change
    // which arm it belonged to -- that silently mixes the groups, and nothing
    // downstream would ever notice.
    const first = assignVariant(experiment, '1900000000000000001');
    const again = assignVariant(experiment, '1900000000000000001');
    expect(again.key).toBe(first.key);
  });

  it('does not put everything in one arm', () => {
    const keys = new Set(
      Array.from({ length: 200 }, (_, i) => assignVariant(experiment, `post-${i}`).key),
    );
    expect(keys).toEqual(new Set(['short', 'long']));
  });

  it('assigns differently in a different experiment', () => {
    // Otherwise every experiment splits the same posts the same way, and two
    // experiments running at once are one experiment.
    const other = { ...experiment, id: 'media-2026-09' };
    const sameKey = Array.from({ length: 40 }, (_, i) => `post-${i}`).filter(
      (key) => assignVariant(experiment, key).key !== assignVariant(other, key).key,
    );
    expect(sameKey.length).toBeGreaterThan(0);
  });
});

describe('reading an experiment', () => {
  it('refuses to answer early, and says how much more is needed', () => {
    const reading = readExperiment(experiment, [
      { key: 'short', rates: rates(4, 40) },
      { key: 'long', rates: rates(3, 5) },
    ]);
    expect(reading.verdict).toBe('TOO_EARLY');
    expect(reading.needed).toBe(8 + 9);
    expect(reading.detail).toMatch(/4 of 12/);
  });

  it('is still too early when only one arm has enough', () => {
    const reading = readExperiment(experiment, [
      { key: 'short', rates: rates(30, 40) },
      { key: 'long', rates: rates(2, 5) },
    ]);
    expect(reading.verdict).toBe('TOO_EARLY');
  });

  it('will not call a small difference a difference', () => {
    const reading = readExperiment(experiment, [
      { key: 'short', rates: rates(12, 21) },
      { key: 'long', rates: rates(12, 20) },
    ]);
    expect(reading.verdict).toBe('NO_DIFFERENCE');
    expect(reading.winner).toBeUndefined();
  });

  it('names a winner once there is one', () => {
    const reading = readExperiment(experiment, [
      { key: 'short', rates: rates(12, 40) },
      { key: 'long', rates: rates(12, 10) },
    ]);
    expect(reading.verdict).toBe('DIFFERENCE');
    expect(reading.winner).toBe('short');
    expect(reading.detail).toMatch(/300% better/);
  });

  it('is not decided by one post that got picked up', () => {
    // The reason this is a median rather than a mean.
    const reading = readExperiment(experiment, [
      { key: 'short', rates: rates(12, 20) },
      { key: 'long', rates: [...rates(11, 20), 5_000] },
    ]);
    expect(reading.verdict).toBe('NO_DIFFERENCE');
  });

  it('reports both arms whatever the verdict', () => {
    const reading = readExperiment(experiment, [{ key: 'short', rates: rates(2, 40) }]);
    expect(reading.perArm.map((arm) => arm.key)).toEqual(['short', 'long']);
    expect(reading.perArm[1]!.posts).toBe(0);
  });
});
