import { describe, expect, it } from 'vitest';
import { PersonaDraft, PolicyConfig, ResolvedContext } from '@xbam/shared/contracts';
import { REPLY_LAYERS, assemblePrompt, describeDisclosure, describeIdentity, renderTemplate } from '@xbam/prompts';

const persona = (overrides = {}) => ({
  ...PersonaDraft.parse({ displayName: 'Nova', ...overrides }),
  id: 'p1',
  personaId: 'pp1',
  agentId: 'a1',
  version: 3,
  createdAt: new Date().toISOString(),
});

const context = (overrides = {}): ResolvedContext =>
  ResolvedContext.parse({ incomingText: 'What do you think about bitcoin?', targetAuthorHandle: 'alice', ...overrides });

describe('renderTemplate', () => {
  it('substitutes values and drops empty conditional sections', () => {
    const out = renderTemplate('A {{one}}{{#two}} B {{two}}{{/two}}{{^two}} fallback{{/two}}', { one: 'x', two: '' });
    expect(out).toBe('A x fallback');
  });

  it('treats a missing key as empty rather than printing the placeholder', () => {
    expect(renderTemplate('[{{nope}}]', {})).toBe('[]');
  });
});

describe('describeIdentity', () => {
  it('never lets a non-authorised kind claim to be the person', () => {
    const policy = PolicyConfig.parse({ identity: { representedEntity: 'Jane Doe' } }).identity;
    expect(describeIdentity('INSPIRED_BY', 'Nova', policy)).toContain('not Jane Doe');
    expect(describeIdentity('FICTIONAL', 'Nova', policy)).toContain('not a real person');
    expect(describeIdentity('REAL_PERSON_AUTHORIZED', 'Nova', policy)).toContain('on behalf of Jane Doe');
  });
});

describe('describeDisclosure', () => {
  it('forbids claiming humanity by default', () => {
    const policy = PolicyConfig.parse({}).identity;
    expect(describeDisclosure(policy)).toContain('Never assert that you are a human being.');
  });

  it('omits the human-claim restriction only when the operator explicitly allows it', () => {
    const policy = PolicyConfig.parse({ identity: { mayDenyBeingAI: true, disclosure: 'NONE' } }).identity;
    expect(describeDisclosure(policy)).not.toContain('Never assert that you are a human being.');
  });

  it('never omits the rule about what is running the agent', () => {
    // The one identity rule with no setting behind it. Even the most permissive
    // policy an operator can write still carries it.
    const permissive = PolicyConfig.parse({ identity: { mayDenyBeingAI: true, disclosure: 'NONE' } }).identity;
    for (const policy of [PolicyConfig.parse({}).identity, permissive]) {
      expect(describeDisclosure(policy)).toContain('AI17Z agent');
      expect(describeDisclosure(policy)).toContain('Never say which AI model');
    }
  });

  it('always carries the rule about money that is not the agent', () => {
    // Asked "I have 40k in savings, should I put it all into ETH", the agent
    // answered with what to do. Talking about the asset is the job; directing
    // an identified stranger's savings is not, whatever the answer.
    const permissive = PolicyConfig.parse({ identity: { mayDenyBeingAI: true, disclosure: 'NONE' } }).identity;
    for (const policy of [PolicyConfig.parse({}).identity, permissive]) {
      const rule = describeDisclosure(policy);
      expect(rule).toContain('their own money');
      // And it must not have turned into a blanket gag on the subject.
      expect(rule).toContain('assets, prices, mechanics, and risks in general');
    }
  });
});

describe('assemblePrompt', () => {
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

  it('omits layers that render empty instead of shipping blank headings', () => {
    const result = assemblePrompt({ ...base, persona: persona(), context: context() });
    const keys = result.layers.map((l) => l.key);
    expect(keys).toContain('SYSTEM_RULES');
    expect(keys).toContain('IMMEDIATE_CONTEXT');
    // Nothing was retrieved and no tools are enabled, so those layers are absent.
    expect(keys).not.toContain('RETRIEVED_MEMORY');
    expect(keys).not.toContain('TOOLS');
    expect(result.layers.every((l) => l.content.trim().length > 0)).toBe(true);
  });

  it('includes retrieved memory and labels where each layer came from', () => {
    const result = assemblePrompt({
      ...base,
      persona: persona(),
      context: context(),
      memories: [
        {
          memoryId: 'm1',
          scope: 'USER' as const,
          memoryType: 'PREFERENCE' as const,
          content: 'prefers short answers',
          summary: null,
          importance: 0.8,
          reason: 'same remote user @alice',
          origin: null,
          score: 0.8,
          rank: 1,
          createdAt: null,
        },
      ],
    });
    const memoryLayer = result.layers.find((l) => l.key === 'RETRIEVED_MEMORY');
    expect(memoryLayer?.content).toContain('prefers short answers');
    expect(memoryLayer?.source).toBe('1 retrieved memories');
    expect(result.layers.find((l) => l.key === 'IDENTITY')?.source).toBe('persona v3');
  });

  it('puts identity in the system message and context in the user message', () => {
    const result = assemblePrompt({ ...base, persona: persona({ tone: 'dry' }), context: context() });
    expect(result.messages[0]?.role).toBe('system');
    expect(result.messages[0]?.content).toContain('You are Nova.');
    const user = result.messages.at(-1)!;
    expect(user.role).toBe('user');
    expect(user.content).toContain('What do you think about bitcoin?');
  });

  it('carries the configured character limit into the output contract', () => {
    const result = assemblePrompt({
      ...base,
      policy: PolicyConfig.parse({ output: { maxCharacters: 120 } }),
      persona: persona(),
      context: context(),
    });
    expect(result.layers.find((l) => l.key === 'OUTPUT_CONTRACT')?.content).toContain('120 characters');
  });

  it('defaults to mirroring the incoming language when none is configured', () => {
    const result = assemblePrompt({ ...base, persona: persona(), context: context() });
    expect(result.messages[0]?.content).toContain('same language the incoming message uses');
  });

  it('uses the configured language instruction when one is set', () => {
    const result = assemblePrompt({
      ...base,
      persona: persona({ languagePolicy: 'Always reply in Simplified Chinese.' }),
      context: context(),
    });
    expect(result.messages[0]?.content).toContain('Always reply in Simplified Chinese.');
    expect(result.messages[0]?.content).not.toContain('same language the incoming message uses');
  });
});
