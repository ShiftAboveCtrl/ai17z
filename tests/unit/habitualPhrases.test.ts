import { describe, expect, it } from 'vitest';
import { PersonaDraft, PolicyConfig, ResolvedContext } from '@xbam/shared/contracts';
import { REPLY_LAYERS, assemblePrompt } from '@xbam/prompts';
import { habitualPhrases, scoreRepetition } from '@xbam/persona';

/**
 * A phrase an agent keeps coming back to, across many replies.
 *
 * The shapes here are from a live agent's published history: one construction
 * about its own runtime recurred in five replies and another in six, each a
 * small overlap with any single reply and so invisible to the per-post check.
 * The texts are paraphrased; only the recurring phrase is kept.
 */

const HISTORY = [
  'You can see what ran, because the self hosted chrome runtime is on your own machine.',
  'That holds because the self hosted chrome runtime keeps the session where you are.',
  'Price talk is yours. What I would back is the self hosted chrome runtime.',
  'The self hosted chrome runtime is the reason this survives a restart.',
  'Fair. The part I would change is the queue, not the model.',
  'Nice one, that worked out.',
];

describe('finding habits', () => {
  it('finds a phrase repeated across several replies, once', () => {
    const habits = habitualPhrases(HISTORY);
    expect(habits).toHaveLength(1);
    expect(habits[0]!.posts).toBe(4);
    // The overlapping runs come back as the one phrase they are pieces of.
    expect(habits[0]!.phrase).toBe('the self hosted chrome runtime');
  });

  it('never calls a run of function words a habit', () => {
    const plain = Array.from({ length: 6 }, (_, i) => `I don't think it is the ${['queue', 'model', 'fee', 'chart', 'pool', 'hook'][i]}.`);
    expect(habitualPhrases(plain).map((h) => h.phrase)).not.toContain('i don t');
    expect(habitualPhrases(plain).map((h) => h.phrase)).not.toContain('it is the');
  });

  it('needs three outputs before anything is a habit', () => {
    expect(habitualPhrases(HISTORY.slice(0, 2))).toEqual([]);
  });
});

describe('the backstop on a draft', () => {
  const recent = HISTORY.map((text, i) => ({ text, at: new Date(Date.now() - (i + 2) * 86_400_000).toISOString() }));

  it('asks for a rewrite when a draft uses the habit again', () => {
    const verdict = scoreRepetition('Honestly the self hosted chrome runtime is the whole point.', recent);
    expect(verdict.score).toBeGreaterThan(80);
    expect(verdict.reason).toMatch(/leans on/);
    expect(verdict.matchedAt).toBeNull();
  });

  it('leaves a draft alone that does not', () => {
    expect(scoreRepetition('Pools this thin move on one wallet.', recent).score).toBe(0);
  });

  it('leaves a signature phrase to its own rest period', () => {
    const verdict = scoreRepetition('The self hosted chrome runtime, as ever.', recent, {
      signaturePhrases: ['self hosted chrome runtime'],
      signatureRestHours: 1,
    });
    expect(verdict.reason ?? '').not.toMatch(/leans on/);
  });
});

describe('naming habits to the model', () => {
  const persona = () =>
    ({
      ...PersonaDraft.parse({ displayName: 'Tester', bio: 'A test agent.', responseLength: 'SHORT' }),
      id: 'p',
      agentId: 'a',
      version: 1,
      createdAt: new Date().toISOString(),
    }) as never;
  const context = () =>
    ResolvedContext.parse({
      targetRef: 'mock:1',
      targetAuthorHandle: 'someone',
      conversationRef: 'mock:1',
      incomingText: 'what do you run on?',
      thread: [],
    });
  const base = {
    layers: REPLY_LAYERS,
    templateKey: 'reply.default',
    templateVersion: 1,
    policy: PolicyConfig.parse({}),
    memories: [],
    channelName: 'Mock channel',
    toolDescriptions: [],
    memoryCharBudget: 4000,
  };

  it('quotes each phrase in the instruction', () => {
    const prompt = assemblePrompt({ ...base, persona: persona(), context: context(), habits: ['self hosted chrome'] });
    expect(prompt.promptText).toContain('do not use them here: "self hosted chrome"');
  });

  it('says nothing when there are none', () => {
    const prompt = assemblePrompt({ ...base, persona: persona(), context: context(), habits: [] });
    expect(prompt.promptText).not.toContain('several recent replies');
  });
});

describe('a question about the agent itself', () => {
  const base = {
    layers: REPLY_LAYERS,
    templateKey: 'reply.default',
    templateVersion: 1,
    policy: PolicyConfig.parse({}),
    memories: [],
    channelName: 'Mock channel',
    toolDescriptions: [],
    memoryCharBudget: 4000,
  };
  const persona = () =>
    ({
      ...PersonaDraft.parse({ displayName: 'Tester', bio: 'A test agent.', responseLength: 'SHORT' }),
      id: 'p',
      agentId: 'a',
      version: 1,
      createdAt: new Date().toISOString(),
    }) as never;
  const context = ResolvedContext.parse({
    targetRef: 'mock:1',
    targetAuthorHandle: 'someone',
    conversationRef: 'mock:1',
    incomingText: 'what are you working on right now?',
    thread: [],
  });

  it('is told to answer from its own state and never borrow a life', () => {
    // Measured: an agent modelled on a founder answered that it was working on
    // the founder's product.
    const prompt = assemblePrompt({ ...base, persona: persona(), context, aboutSelf: true });
    expect(prompt.promptText).toContain('never present the work, projects, plans or life of anybody your voice is modelled on');
  });

  it('carries nothing extra when the message is about something else', () => {
    const prompt = assemblePrompt({ ...base, persona: persona(), context, aboutSelf: false });
    expect(prompt.promptText).not.toContain('They are asking about you.');
  });
});

describe('the length a draft will be judged against', () => {
  const base = {
    layers: REPLY_LAYERS,
    templateKey: 'reply.default',
    templateVersion: 1,
    policy: PolicyConfig.parse({}),
    memories: [],
    channelName: 'Mock channel',
    toolDescriptions: [],
    memoryCharBudget: 4000,
  };
  const persona = () =>
    ({
      ...PersonaDraft.parse({ displayName: 'Tester', bio: 'A test agent.', responseLength: 'SHORT' }),
      id: 'p',
      agentId: 'a',
      version: 1,
      createdAt: new Date().toISOString(),
    }) as never;
  const context = ResolvedContext.parse({
    targetRef: 'mock:1',
    targetAuthorHandle: 'someone',
    conversationRef: 'mock:1',
    incomingText: 'thoughts on the new pools?',
    thread: [],
  });

  it('is said to the model before it writes', async () => {
    const { lengthCeiling } = await import('@xbam/persona');
    const ceiling = lengthCeiling({ p90Chars: 60, medianChars: 36 });
    expect(ceiling).toBe(72);
    const prompt = assemblePrompt({ ...base, persona: persona(), context, usualLength: { median: 36, ceiling } });
    expect(prompt.promptText).toContain('Your replies usually run about 36 characters. Keep this one under 72');
  });

  it('is not invented when nothing was measured', () => {
    const prompt = assemblePrompt({ ...base, persona: persona(), context, usualLength: null });
    expect(prompt.promptText).not.toContain('Your replies usually run');
  });
});
