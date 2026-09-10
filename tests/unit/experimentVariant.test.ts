import { describe, expect, it } from 'vitest';
import { PersonaDraft, PolicyConfig, ResolvedContext } from '@xbam/shared/contracts';
import { REPLY_LAYERS, assemblePrompt } from '@xbam/prompts';

/**
 * How an experiment's arm reaches what the agent writes.
 *
 * It joins the output rules and nothing else. That is the whole of the
 * mechanism, and it is deliberately the smallest one available: an arm that
 * rewrote the persona, or added a layer, or changed the task would be a second
 * agent rather than the same agent writing differently, and no comparison
 * between the two would mean anything.
 *
 * The control arm carries an empty instruction and must leave the prompt byte
 * for byte as it was. If it does not, both arms differ from the baseline and
 * the experiment measures the harness.
 */

const persona = (overrides = {}) => ({
  ...PersonaDraft.parse({ displayName: 'Nova', ...overrides }),
  id: 'p1',
  personaId: 'pp1',
  agentId: 'a1',
  version: 3,
  createdAt: new Date().toISOString(),
});

const context = (): ResolvedContext =>
  ResolvedContext.parse({ incomingText: 'What do you think?', targetAuthorHandle: 'alice' });

const base = {
  layers: REPLY_LAYERS,
  templateKey: 'reply.default',
  templateVersion: 1,
  policy: PolicyConfig.parse({}),
  memories: [],
  channelName: 'Mock channel',
  toolDescriptions: [],
  memoryCharBudget: 4000,
  persona: persona(),
  context: context(),
};

describe('an experiment arm in the prompt', () => {
  it('adds its instruction to the output rules', () => {
    const result = assemblePrompt({
      ...base,
      actionType: 'POST',
      experiment: { label: 'Shorter', instruction: 'Keep this post under 120 characters.' },
    });
    const rules = result.layers.find((layer) => layer.key === 'OUTPUT_CONTRACT');
    expect(rules!.content).toContain('Keep this post under 120 characters.');
  });

  it('leaves the prompt exactly as it was for the control arm', () => {
    // An empty instruction has to be indistinguishable from no experiment. Any
    // difference here is a difference in both arms, which is the harness
    // measuring itself.
    const without = assemblePrompt({ ...base, actionType: 'POST' });
    const control = assemblePrompt({
      ...base,
      actionType: 'POST',
      experiment: { label: 'As usual', instruction: '' },
    });
    expect(control.promptText).toBe(without.promptText);
  });

  it('changes nothing but the output rules', () => {
    const without = assemblePrompt({ ...base, actionType: 'POST' });
    const varied = assemblePrompt({
      ...base,
      actionType: 'POST',
      experiment: { label: 'Shorter', instruction: 'Keep this post under 120 characters.' },
    });
    const differing = varied.layers.filter((layer) => {
      const before = without.layers.find((other) => other.key === layer.key);
      return before?.content !== layer.content;
    });
    expect(differing.map((layer) => layer.key)).toEqual(['OUTPUT_CONTRACT']);
  });
});
