import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, assemblePrompt } from '@xbam/prompts';
import { DEFAULT_POLICY } from '@xbam/shared';

const template = DEFAULT_TEMPLATES.find((t: { key: string }) => t.key === 'reply.default')!;

const persona = {
  id: 'p', agentId: 'a', version: 1, identityKind: 'FICTIONAL' as const, displayName: 'Someone',
  biography: '', personality: 'Exact.', tone: '', styleGuidelines: '', styleExamples: [], topics: [],
  languagePolicy: '', responseLength: 'SHORT' as const, prohibitedBehaviors: [], customInstructions: '',
  changeNote: '', createdAt: new Date().toISOString(), createdBy: null,
};
const context = {
  targetRef: null, targetUrl: null, targetAuthorHandle: 'asker', conversationRef: null,
  incomingText: 'why is my agent not replying?', parentText: null, thread: [], conversation: null, meta: {},
};

const build = (support?: Parameters<typeof assemblePrompt>[0]['support']) =>
  assemblePrompt({
    layers: template.layers, templateKey: template.key, templateVersion: 1,
    persona: persona as never, policy: DEFAULT_POLICY, context: context as never,
    memories: [], channelName: 'X', toolDescriptions: [], memoryCharBudget: 2_000,
    actionType: 'REPLY', support,
  });

/**
 * The official agent for a project should be able to genuinely help somebody
 * diagnose it rather than quoting documentation at them. Doing that needs three
 * things an ordinary agent has no business carrying, which is exactly why this
 * is off by default.
 */
describe('support mode', () => {
  it('is off unless somebody turns it on', () => {
    // Everybody's agent becoming a support bot for the software it happens to
    // run on is a persona leak, not a feature.
    expect(DEFAULT_POLICY.support.enabled).toBe(false);
    expect(build().promptText).not.toContain('You can help people with');
  });

  it('says what the installation is running, which almost nobody volunteers', () => {
    const prompt = build({ subject: 'AI17Z', version: 'v0.1.0 (abc123)', runtime: null });
    expect(prompt.promptText).toContain('v0.1.0 (abc123)');
  });

  it('carries the live runtime state, which is the whole difference', () => {
    // "Have you checked your configuration" against "your notifications monitor
    // has been failing for eleven minutes".
    const prompt = build({
      subject: 'AI17Z',
      version: 'v0.1.0',
      runtime: 'Notifications: failing for 11 minutes.',
    });
    expect(prompt.promptText).toContain('failing for 11 minutes');
  });

  it('forbids generalising one installation to everybody', () => {
    // An agent holding a live diagnostic will happily turn "mine is broken"
    // into "the software is broken", which is a much worse statement.
    const prompt = build({ subject: 'AI17Z', version: 'v0.1.0', runtime: 'Worker: healthy.' });
    expect(prompt.promptText).toContain('this installation only');
  });

  it('says nothing about the runtime when the owner did not offer that', () => {
    // Answering questions about a project and telling people about this
    // installation are different offers.
    const prompt = build({ subject: 'AI17Z', version: 'v0.1.0', runtime: null });
    expect(prompt.promptText).toContain('You can help people with AI17Z');
    expect(prompt.promptText).not.toContain('this installation only');
  });

  it('supports something other than AI17Z without a fork', () => {
    expect(build({ subject: 'Acme Router', version: 'v2', runtime: null }).promptText).toContain('Acme Router');
  });
});
