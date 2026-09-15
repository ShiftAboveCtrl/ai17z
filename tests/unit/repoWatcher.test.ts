import { describe, expect, it } from 'vitest';
import { worthNoticing } from '@xbam/runtime';

/**
 * What a project did, and what an agent should never mention.
 *
 * The failure everybody predicts of a project-aware agent is the changelog bot:
 * one that tweets every commit. Most of what a repository does in a day is
 * mechanical and interests nobody outside it -- a typo, a lockfile bump, a test
 * fixture -- and the entire difference between an agent that knows its project
 * and a feed reader is what it declines.
 *
 * Deterministic, and that is deliberate. "Is this interesting" asked of a model
 * for every commit is both a cost and an answer nobody can inspect, and the
 * cheap rules are right about the overwhelming majority.
 */

const event = (over: Partial<Parameters<typeof worthNoticing>[0]> = {}) =>
  worthNoticing({ kind: 'COMMIT', title: '', body: '', state: null, ...over });

describe('what is worth an agent knowing', () => {
  it('always notices a release', () => {
    expect(event({ kind: 'RELEASE', title: 'AI17Z Beta 3.1' }).worth).toBe(true);
  });

  it('notices a merged pull request', () => {
    expect(event({ kind: 'PULL_REQUEST', title: 'Read X through one layer everywhere', state: 'merged' }).worth).toBe(true);
  });

  it('notices somebody raising an issue', () => {
    expect(event({ kind: 'ISSUE', title: 'Browser reads time out when the mentions tab is busy', state: 'open' }).worth).toBe(
      true,
    );
  });

  it('notices a build that went red', () => {
    expect(event({ kind: 'WORKFLOW', title: 'CI', state: 'failure' }).worth).toBe(true);
  });

  it('notices a substantive commit', () => {
    expect(event({ title: 'Stop force-killing Chrome before its cookies are flushed' }).worth).toBe(true);
  });
});

describe('what it declines', () => {
  it('declines a build doing what builds do', () => {
    // Green is the expected case and is not news.
    expect(event({ kind: 'WORKFLOW', title: 'CI', state: 'success' }).worth).toBe(false);
  });

  it('declines a pull request that is only proposed', () => {
    // A proposal is not a thing the project does. Describing one as though it
    // were is how an agent announces a feature that never landed.
    const verdict = event({ kind: 'PULL_REQUEST', title: 'Try a different scheduling approach', state: 'open' });
    expect(verdict.worth).toBe(false);
    expect(verdict.why).toMatch(/Proposed rather than merged/);
  });

  it('declines the mechanical majority', () => {
    for (const title of [
      'chore: bump dependencies',
      'ci: cache the node modules',
      'docs: fix typo in the readme',
      'style(web): whitespace',
      'test: add a fixture for the parser',
      'build: update the lockfile',
      'Bump actions/checkout from 4 to 5',
    ]) {
      expect(event({ title }).worth, title).toBe(false);
    }
  });

  it('declines a commit too terse to be about anything', () => {
    expect(event({ title: 'wip' }).worth).toBe(false);
    expect(event({ title: 'fix the thing' }).worth).toBe(false);
  });

  it('gives a reason for every refusal, because an owner may disagree', () => {
    const verdict = event({ title: 'chore: bump dependencies' });
    expect(verdict.worth).toBe(false);
    expect(verdict.why.length).toBeGreaterThan(10);
  });

  it('does not let a mechanical prefix hide behind a long subject', () => {
    // The prefix is the claim. A long chore is still a chore.
    expect(
      event({ title: 'chore: rename every internal variable for consistency across the whole package' }).worth,
    ).toBe(false);
  });
});
