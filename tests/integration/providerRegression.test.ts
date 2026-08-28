import { describe, expect, it } from 'vitest';
import { EngagementPolicy, VoicePolicy } from '@xbam/shared/contracts';
import { actions, jobs as jobsRepo, providers, voice as voiceRepo } from '@xbam/database';
import { ingestNormalizedEvent, refreshFingerprint } from '@xbam/runtime';
import { scoreGeneric, scoreVoice } from '@xbam/persona';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainJobs } from '../support/runner';

installHarness();

/**
 * The regression test the whole social layer exists to pass (§103).
 *
 * Two mock providers with deliberately opposite house styles — one breezy and
 * apologetic, one stiff and corporate — carrying identical substance. After the
 * voice compiler, both should read as the same agent.
 *
 * Not identical text: that would be a different requirement, and an impossible
 * one. What has to hold is the measurable voice — length, register, the habits
 * the agent has and does not have.
 */

/** The terse voice both providers have to be pulled towards. */
const TERSE_SAMPLES = [
  'Builders keep building.',
  'People vote with their money.',
  'Markets shake out the weak hands.',
  'Adoption compounds. Noise does not.',
  'Focus on users, not politics.',
  'Execution beats announcements.',
  'Fees matter more than narratives.',
  'Most of this is noise.',
  'Risk shows up where attention leaves.',
  'Watch what they build.',
  'Time will sort it.',
  'Fundamentals, not headlines.',
  'Nothing here is new.',
  'Users decide.',
  'Ship first.',
  'Slow is fine.',
  'Patience compounds too.',
  'Simplicity survives.',
  'Early still.',
  'That is the whole point.',
  'The foundation is stronger without them.',
  'Not predicting anything.',
];

/** Seeds the agent's published history, which is what a fingerprint is built from. */
async function teachVoice(agentId: string) {
  for (const text of TERSE_SAMPLES) {
    await voiceRepo.recordOutput({ agentId, text });
  }
  return refreshFingerprint(agentId, true);
}

async function replyUsing(model: string) {
  const fixture = await createFixture({
    policy: {
      voice: VoicePolicy.parse({}),
      engagement: EngagementPolicy.parse({ strategy: 'ALWAYS_REPLY' }),
    },
    model,
  });
  const fingerprint = await teachVoice(fixture.agentId);

  const outcome = await ingestNormalizedEvent({
    accountId: null,
    onlyAgentId: fixture.agentId,
    event: mockEvent('What actually matters here in the long run?'),
  });
  await drainJobs();

  const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
  const performed = await actions.listJobActions(job.id);
  return {
    fixture,
    fingerprint,
    status: job.status,
    // What the model produced, before the voice pass.
    draft: job.generatedOutput ?? '',
    // What was actually published.
    published: (performed[0]?.payload as { text?: string })?.text ?? job.validatedOutput ?? '',
  };
}

describe('the same agent, whichever model wrote the draft', () => {
  it('starts from two genuinely different house styles', async () => {
    const chatty = await replyUsing('mock-chatty');
    const formal = await replyUsing('mock-formal');

    // The premise of the test: the drafts really are different registers.
    expect(chatty.draft).toMatch(/great question|hope that helps/i);
    expect(formal.draft).toMatch(/important to note|in order to|leverage/i);
    expect(scoreGeneric(chatty.draft).score).toBeGreaterThan(20);
    expect(scoreGeneric(formal.draft).score).toBeGreaterThan(20);
  });

  it('publishes something that sounds like the agent in both cases', async () => {
    const chatty = await replyUsing('mock-chatty');
    const formal = await replyUsing('mock-formal');

    expect(chatty.status).toBe('EXECUTED');
    expect(formal.status).toBe('EXECUTED');

    const chattyVoice = scoreVoice(chatty.published, chatty.fingerprint);
    const formalVoice = scoreVoice(formal.published, formal.fingerprint);

    // Both land close to the same voice. Not the same text — the same voice.
    expect(chattyVoice.score).toBeGreaterThan(scoreVoice(chatty.draft, chatty.fingerprint).score);
    expect(formalVoice.score).toBeGreaterThan(scoreVoice(formal.draft, formal.fingerprint).score);
    expect(Math.abs(chattyVoice.score - formalVoice.score)).toBeLessThan(30);
  });

  it('strips each provider\'s tells rather than leaving one to show through', async () => {
    const chatty = await replyUsing('mock-chatty');
    const formal = await replyUsing('mock-formal');

    expect(chatty.published).not.toMatch(/great question/i);
    expect(chatty.published).not.toMatch(/hope that helps/i);
    expect(chatty.published).not.toMatch(/let me know if/i);
    expect(formal.published).not.toMatch(/in order to/i);
    expect(formal.published).not.toMatch(/leverage/i);
  });

  it('brings both within the length this agent actually writes', async () => {
    const chatty = await replyUsing('mock-chatty');
    const formal = await replyUsing('mock-formal');

    const ceiling = Math.max(chatty.fingerprint.p90Chars * 2, 200);
    expect(chatty.published.length).toBeLessThanOrEqual(ceiling);
    expect(formal.published.length).toBeLessThanOrEqual(ceiling);
    // And both got shorter than what the model handed over.
    expect(chatty.published.length).toBeLessThan(chatty.draft.length);
    expect(formal.published.length).toBeLessThan(formal.draft.length);
  });

  it('leaves both reading less like generic assistant prose than they arrived', async () => {
    const chatty = await replyUsing('mock-chatty');
    const formal = await replyUsing('mock-formal');

    expect(scoreGeneric(chatty.published).score).toBeLessThan(scoreGeneric(chatty.draft).score);
    expect(scoreGeneric(formal.published).score).toBeLessThan(scoreGeneric(formal.draft).score);
  });

  it('does not require the two to say the same words', async () => {
    const chatty = await replyUsing('mock-chatty');
    const formal = await replyUsing('mock-formal');
    // Stated explicitly so nobody later "fixes" this into a string comparison.
    expect(chatty.published).not.toBe(formal.published);
  });
});

describe('what the fingerprint is built from', () => {
  it('measures published replies rather than what somebody wrote down', async () => {
    const fixture = await createFixture();
    const fingerprint = await teachVoice(fixture.agentId);
    expect(fingerprint.sampleCount).toBe(TERSE_SAMPLES.length);
    expect(fingerprint.sources.join(' ')).toMatch(/published replies/i);
  });

  it('is not fooled into thinking the agent uses punctuation it never uses', async () => {
    const fixture = await createFixture();
    const fingerprint = await teachVoice(fixture.agentId);
    expect(fingerprint.exclamationRate).toBe(0);
    expect(fingerprint.emojiRate).toBe(0);
    expect(fingerprint.hashtagRate).toBe(0);
  });

  it('is available to every agent, whichever provider it is configured with', async () => {
    const fixture = await createFixture({ model: 'mock-formal' });
    await teachVoice(fixture.agentId);
    const configs = await providers.listModelConfigs(fixture.agentId);
    // The fingerprint belongs to the agent, not to the model behind it.
    expect(configs.find((c) => c.role === 'primary')?.model).toBe('mock-formal');
    expect((await voiceRepo.getFingerprint(fixture.agentId))?.sampleCount).toBe(TERSE_SAMPLES.length);
  });
});
