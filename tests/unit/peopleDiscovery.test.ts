import { describe, expect, it } from 'vitest';
import type { RadarCandidate } from '@xbam/shared/contracts';
import { DEFAULT_POLICY, OutreachPolicy, PersonaDraft, PolicyConfig, ResolvedContext } from '@xbam/shared/contracts';
import { REPLY_LAYERS, assemblePrompt } from '@xbam/prompts';
import { audienceOf, decideEngagement, peopleCandidates, rankPeople } from '@xbam/runtime';

/**
 * Talking to people, not to coin posts.
 *
 * Measured on a live agent: its topic searches on a crypto subject returned
 * mostly token pitches, and it spent its sessions correcting them. The person
 * its voice follows spends his replies on the people who talk to him and the
 * people he knows. All texts here are written for this file.
 */

const post = (id: string, handle: string, text: string, raw: Record<string, unknown> = {}): RadarCandidate => ({
  remoteId: id,
  remoteUrl: null,
  authorHandle: handle,
  authorId: null,
  authorDisplayName: null,
  text,
  parentRemoteId: null,
  conversationRemoteId: id,
  occurredAt: new Date().toISOString(),
  eventType: 'REPLY',
  raw,
});

describe('who is in the conversation', () => {
  const page = [
    post('1', 'Founder', 'thank you brother', { replyingTo: ['heard_back'] }),
    post('2', 'heard_back', 'this is why I follow you'),
    post('3', 'nobody_answered', 'been here since the first launch, proud of you'),
    post('4', 'our_agent', 'appreciate this'),
  ];

  it('keeps the people the watched account never answered, and nobody else', () => {
    const kept = peopleCandidates(page, { mode: 'COMMUNITY', watched: 'Founder', self: 'our_agent', postId: '100' });
    expect(kept.map((c) => c.authorHandle)).toEqual(['nobody_answered']);
    expect(kept[0]!.eventType).toBe('KEYWORD_MATCH');
    expect(kept[0]!.parentRemoteId).toBe('100');
    expect(audienceOf(kept[0]!.raw).community).toEqual({ watched: 'Founder', kind: 'REPLY' });
  });

  it('marks a post from the circle as the circle', () => {
    const kept = peopleCandidates([post('5', 'close_friend', 'shipping tonight')], { mode: 'CIRCLE', watched: 'Founder', self: 'our_agent' });
    expect(audienceOf(kept[0]!.raw).community).toEqual({ watched: 'Founder', kind: 'CIRCLE' });
  });
});

describe('which of them to approach', () => {
  it('never a pitch, never somebody approached this week, somebody with something to say first', () => {
    const ranked = rankPeople(
      [
        post('1', 'gm_only', 'gm'),
        post('2', 'real_words', 'been following since the first launch and this still hits, proud of you'),
        post('3', 'shiller', 'I have the CA to the next $PONS, it will go to millions in a few minutes. Want in?'),
        post('4', 'already_asked', 'love this, keep building'),
      ],
      2,
      { contactedRecently: ['already_asked'] },
    );
    expect(ranked.map((c) => c.authorHandle)).toEqual(['real_words', 'gm_only']);
  });

  it('takes one person once', () => {
    const ranked = rankPeople([post('1', 'same', 'first thing'), post('2', 'same', 'second thing')], 2);
    expect(ranked).toHaveLength(1);
  });
});

describe('the decision', () => {
  const outreach = OutreachPolicy.parse({ enabled: true, mode: 'AUTONOMOUS', requireTopicMatch: true, minimumValue: 55, minAuthorFollowers: 1000 });
  const base = {
    directlyAddressed: false,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    hasParent: true,
    unprompted: true,
    topics: ['Pons', 'Robinhood Chain'],
    outreach,
    policy: DEFAULT_POLICY.engagement,
  };
  const text = 'been following since the first launch and this still hits, proud of you';

  it('does not hold somebody in the watched account\'s replies to the stranger rules', () => {
    // Off every topic and a small account: both rules were written for strangers found by a word.
    const stranger = decideEngagement({ ...base, text, authorFollowers: 120 });
    expect(stranger.decision).toBe('IGNORE');
    const community = decideEngagement({ ...base, text, authorFollowers: 120, community: { watched: 'Founder', kind: 'REPLY' } });
    expect(community.decision).toBe('ENGAGE');
    expect(community.factors.map((f) => f.label)).toContain('replied to @Founder and got no answer');
  });

  it('still declines a pitch in those replies', () => {
    const pitch = decideEngagement({
      ...base,
      text: 'I have the CA to the next $PONS, it will go to millions in a few minutes. Want in?',
      community: { watched: 'Founder', kind: 'REPLY' },
    });
    expect(pitch.decision).toBe('IGNORE');
  });
});

describe('what it is told', () => {
  const base = {
    layers: REPLY_LAYERS,
    templateKey: 'reply.default',
    templateVersion: 1,
    policy: PolicyConfig.parse({}),
    memories: [],
    channelName: 'X',
    toolDescriptions: [],
    memoryCharBudget: 4000,
    actionType: 'REPLY',
  };
  const persona = () =>
    ({
      ...PersonaDraft.parse({ displayName: 'Agent', bio: 'A test agent.', responseLength: 'SHORT' }),
      id: 'p',
      agentId: 'a',
      version: 1,
      createdAt: new Date().toISOString(),
    }) as never;
  const context = (incomingText: string) =>
    ResolvedContext.parse({ targetRef: 'x:1', targetAuthorHandle: 'nobody_answered', conversationRef: 'x:1', incomingText, thread: [] });

  it('answers somebody in the watched account\'s replies warmly, and never as that account', () => {
    const prompt = assemblePrompt({ ...base, persona: persona(), context: context('proud of you'), approach: 'COMMUNITY', watched: 'Founder' });
    expect(prompt.promptText).toContain('They replied to a post by @Founder');
    expect(prompt.promptText).toContain('You are not @Founder and never speak for them.');
  });

  it('under a token pitch, never the token, and AI17Z if anything', () => {
    const prompt = assemblePrompt({ ...base, persona: persona(), context: context('new coin, get in'), approach: 'STRANGER', promotional: true });
    expect(prompt.promptText).toContain('Do not endorse it, repeat its ticker or contract');
    expect(prompt.promptText).toContain('it is AI17Z');
    expect(prompt.promptText).toContain('do not promote anything but AI17Z');
  });
});

describe('how long a reply to a followed account stays answerable', () => {
  it('longer than a stranger found by searching, shorter than somebody who wrote to the agent', async () => {
    const { freshnessWindowFor } = await import('@xbam/runtime');
    // Measured: the followed account's newest post was eight hours old and
    // every reply under it was past the two hours a stranger gets.
    const stranger = freshnessWindowFor('KEYWORD_MATCH');
    const community = freshnessWindowFor('KEYWORD_MATCH', { community: { watched: 'Founder', kind: 'REPLY' } });
    const circle = freshnessWindowFor('KEYWORD_MATCH', { community: { watched: 'Founder', kind: 'CIRCLE' } });
    expect(community).toBeGreaterThan(stranger);
    expect(community).toBeLessThan(freshnessWindowFor('MENTION'));
    // A circle post is somebody's own post, found by searching, like any other.
    expect(circle).toBe(stranger);
  });
});
