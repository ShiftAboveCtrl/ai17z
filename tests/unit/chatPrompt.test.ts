import { describe, expect, it } from 'vitest';
import { assemblePrompt, CHAT_LAYERS } from '@xbam/prompts';
import { DEFAULT_POLICY, PersonaDraft, PolicyConfig } from '@xbam/shared/contracts';
import { chatContextMeta } from '@xbam/runtime';

/*
  Found on a live installation: owner chat looked something up, found an
  answer, and the model was shown nothing, because the result reached the
  prompt in a shape the prompt engine does not render.
*/
describe('the owner chat prompt', () => {
  const persona = { ...PersonaDraft.parse({ displayName: 'Shift' }), id: 'p', version: 1, identityKind: 'SELF' } as never;
  const build = (meta: Record<string, unknown>) =>
    assemblePrompt({
      layers: CHAT_LAYERS,
      templateKey: 'chat.owner',
      templateVersion: 1,
      persona,
      policy: PolicyConfig.parse(DEFAULT_POLICY),
      context: { incomingText: 'What changed in Chrome this week?', thread: [], meta } as never,
      memories: [],
      channelName: 'AI17Z',
      toolDescriptions: [],
      memoryCharBudget: 2_000,
      actionType: 'CHAT',
    }).promptText;

  it('carries what was looked up, with its source', () => {
    const text = build(
      chatContextMeta(null, {
        findings: [{ kind: 'search', query: 'q', source: 'Web search', title: 'Chrome 153', summary: 'Chrome 153 shipped tab groups sync.', url: 'https://example.test', retrievedAt: 'now' }],
        failed: [],
        note: '',
      }),
    );
    expect(text).toContain('LOOKED UP JUST NOW');
    expect(text).toContain('Chrome 153 shipped tab groups sync.');
    expect(text).toContain('YOUR OWNER SAYS');
  });

  it('adds nothing when nothing was looked up', () => {
    expect(build(chatContextMeta(null, null))).not.toContain('LOOKED UP JUST NOW');
  });
});
