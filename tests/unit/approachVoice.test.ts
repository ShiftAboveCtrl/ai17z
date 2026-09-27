import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, assemblePrompt } from '@xbam/prompts';
import { discoveryQuery, watchedFragment } from '@xbam/runtime';
import { DEFAULT_POLICY } from '@xbam/shared';

/**
 * Joining somebody's conversation is not answering them.
 *
 * Every reply was told "They are speaking to you. Answer them." Under a post
 * the agent found on its own nobody spoke to it, and a model told to answer
 * writes an answer: it explained a stranger's post back to them and repeated
 * its numbers. The account it was modelled on reacts in a few words, asks one
 * pointed question, or jokes.
 */

const template = DEFAULT_TEMPLATES.find((t: { key: string }) => t.key === 'reply.default')!;

const persona = {
  id: 'p', agentId: 'a', version: 1, identityKind: 'FICTIONAL' as const, displayName: 'MEADGod',
  biography: '', personality: '', tone: '', styleGuidelines: '', styleExamples: [], topics: [],
  languagePolicy: '', responseLength: 'TERSE' as const, prohibitedBehaviors: [], customInstructions: '',
  changeNote: '', createdAt: new Date().toISOString(), createdBy: null,
};

const context = {
  targetRef: null, targetUrl: null, targetAuthorHandle: 'robinhoodbuilder', conversationRef: null,
  incomingText: 'Robinhood Chain just crossed 1M transactions in a day', parentText: null, thread: [],
  conversation: null, meta: {},
};

const promptFor = (approach?: 'STRANGER' | 'TARGET' | null) =>
  assemblePrompt({
    layers: template.layers, templateKey: template.key, templateVersion: 1, persona: persona as never,
    policy: DEFAULT_POLICY, context: context as never, memories: [], channelName: 'X', toolDescriptions: [],
    memoryCharBudget: 2_000, actionType: 'REPLY', ...(approach === undefined ? {} : { approach }),
  }).promptText;

describe('the task a reply is given', () => {
  it('tells an approach it is joining a conversation, not answering one', () => {
    const text = promptFor('STRANGER');
    expect(text).toMatch(/did not write to you/);
    // Measured: approach drafts of 138 and 193 characters against a voice
    // that rarely passes 72 went to review and cost a model call each.
    expect(text).toMatch(/One line, usually under ninety characters/);
    expect(text).toMatch(/do not explain their post back to them/i);
    expect(text).toMatch(/on behalf of a project or team/);
    expect(text).not.toMatch(/They are speaking to you/);
  });

  it('talks to a watched account as somebody the agent knows', () => {
    const text = promptFor('TARGET');
    expect(text).toMatch(/somebody you follow closely/);
    expect(text).not.toMatch(/They are speaking to you/);
  });

  it('leaves the ordinary reply exactly as it was when somebody wrote in', () => {
    expect(promptFor()).toMatch(/They are speaking to you/);
    expect(promptFor(null)).toBe(promptFor());
  });
});

describe("a watched account's fragments", () => {
  it('leaves its one-word replies to other people alone', () => {
    // Recorded verbatim by the live watch, every one a reply to somebody else.
    for (const text of ['yes', '+', 'worst ever', 'Dogs and Cats', 'we got more dw', 'Let me check rq']) {
      expect(watchedFragment(text, true), text).toMatch(/nothing here to add to/);
    }
    expect(watchedFragment('@someone lol', true)).not.toBeNull();
  });

  it('still takes anything with a thought in it', () => {
    expect(watchedFragment('Not yet. Before launching it to the market, it still needs audits.', true)).toBeNull();
    expect(watchedFragment('RBNHD SZN PNS SZN', false)).toBeNull();
    expect(watchedFragment('The Chinese are going to start the bullrun on Robinhood', false)).toBeNull();
  });

  it('treats a short question in their own post as a post', () => {
    expect(watchedFragment('echo bubble?', false)).toBeNull();
    expect(watchedFragment('gneow', false)).not.toBeNull();
  });
});

describe('a pinned search that names its own floor', () => {
  it('keeps the owner\'s floor rather than adding a second one', () => {
    expect(discoveryQuery('"Robinhood Chain" min_faves:40', 20)).toBe(
      '"Robinhood Chain" min_faves:40 lang:en -filter:replies -filter:retweets',
    );
  });
});
