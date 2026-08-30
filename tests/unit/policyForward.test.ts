import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';

/**
 * A stored policy older than the schema must read forward.
 *
 * Policy rows are jsonb written on the day they were saved. A row from before
 * `engagement` existed simply has no `engagement` key, and every reader would
 * otherwise have to guard for a whole section being undefined — which is what
 * crashed the Easy Mode view on an agent created a week earlier.
 *
 * Parsing through the schema fills those gaps with the same defaults a new
 * agent gets, which is what "the configuration is versioned" has to mean.
 */
describe('reading a policy written before the schema grew', () => {
  it('fills in a section that did not exist yet', () => {
    // What a row looked like before the social layer was added.
    const old = {
      automation: { mode: 'REVIEW_BEFORE_ACTION', dryRunDefault: true },
      output: { maxCharacters: 240 },
      content: { blockedTopics: [], blockedRemoteHandles: [], allowedRemoteHandles: [], selfHandles: [] },
    };
    const parsed = PolicyConfig.parse(old);

    expect(parsed.engagement.strategy).toBe(DEFAULT_POLICY.engagement.strategy);
    expect(parsed.voice).toEqual(DEFAULT_POLICY.voice);
    expect(parsed.stance).toEqual(DEFAULT_POLICY.stance);
    expect(parsed.relationships).toEqual(DEFAULT_POLICY.relationships);
    expect(parsed.media).toEqual(DEFAULT_POLICY.media);
    // And the fields it did carry survive.
    expect(parsed.output.maxCharacters).toBe(240);
    expect(parsed.automation.dryRunDefault).toBe(true);
  });

  it('fills in a field added to a section that already existed', () => {
    const parsed = PolicyConfig.parse({
      content: { blockedTopics: [], blockedRemoteHandles: [], allowedRemoteHandles: [], selfHandles: [] },
    });
    // requireVerifiedAuthor is newer than the rest of ContentPolicy.
    expect(parsed.content.requireVerifiedAuthor).toBe(false);
  });

  it('reads an empty config as the full default rather than throwing', () => {
    expect(PolicyConfig.parse({})).toEqual(DEFAULT_POLICY);
  });
});
