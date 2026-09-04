import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, assemblePrompt } from '@xbam/prompts';
import { DEFAULT_POLICY } from '@xbam/shared';

const template = DEFAULT_TEMPLATES.find((t: { key: string }) => t.key === 'reply.default')!;

const persona = {
  id: 'p',
  agentId: 'a',
  version: 1,
  identityKind: 'FICTIONAL' as const,
  displayName: 'Someone',
  biography: '',
  personality: 'Exact.',
  tone: '',
  styleGuidelines: '',
  styleExamples: [],
  topics: [],
  languagePolicy: '',
  responseLength: 'SHORT' as const,
  prohibitedBehaviors: [],
  customInstructions: '',
  changeNote: '',
  createdAt: new Date().toISOString(),
  createdBy: null,
};

const context = {
  targetRef: null,
  targetUrl: null,
  targetAuthorHandle: 'asker',
  conversationRef: null,
  incomingText: 'what happened with the launch today?',
  parentText: null,
  thread: [],
  conversation: null,
  meta: {},
};

const build = (evidence?: Parameters<typeof assemblePrompt>[0]['evidence']) =>
  assemblePrompt({
    layers: template.layers,
    templateKey: template.key,
    templateVersion: 1,
    persona: persona as never,
    policy: DEFAULT_POLICY,
    context: context as never,
    memories: [],
    channelName: 'X',
    toolDescriptions: [],
    memoryCharBudget: 2_000,
    actionType: 'REPLY',
    evidence,
  });

/**
 * A model with no evidence writes exactly as confidently as one with plenty.
 * That is the sentence that gets somebody a wrong answer stated as fact, and it
 * is the only case worth spending a prompt layer on.
 */
describe('telling the model when there is nothing behind an answer', () => {
  it('says so when nothing was found', () => {
    const prompt = build({
      evidence: 'UNCERTAIN',
      reason: '2 lookup(s) were tried and none of them worked.',
      shouldAdmitUncertainty: true,
    });
    expect(prompt.promptText).toContain('EVIDENCE');
    expect(prompt.promptText).toContain('none of them worked');
    expect(prompt.promptText).toContain('do not know');
  });

  it('says nothing at all when the answer is well founded', () => {
    // A note on every message is one the model reads past within a few layers.
    const prompt = build({
      evidence: 'CURRENT_RESEARCH',
      reason: 'Rests on something looked up a moment ago.',
      shouldAdmitUncertainty: false,
    });
    expect(prompt.promptText).not.toContain('EVIDENCE');
  });

  it('says nothing when no classification was made at all', () => {
    expect(build().promptText).not.toContain('EVIDENCE');
  });

  it('does not leak the category into the message the model is asked to write', () => {
    // The instruction is for the model, not something to repeat.
    const prompt = build({
      evidence: 'UNCERTAIN',
      reason: 'Nothing was retrieved.',
      shouldAdmitUncertainty: true,
    });
    expect(prompt.promptText).not.toContain('UNCERTAIN');
  });
});
