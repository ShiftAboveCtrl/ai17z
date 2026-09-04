import { describe, expect, it } from 'vitest';
import { memories } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Which passage answers the question.
 *
 * ts_rank rewards how often a term appears in a chunk and has no sense of how
 * common that term is across the corpus. So a common word in the question can
 * outrank the rare one that actually identifies the answer, and asking an agent
 * "can I use Ollama?" returned six passages about Docker sign-in while the one
 * paragraph naming Ollama went unretrieved.
 */
describe('the rarest word in a question decides what is retrieved', () => {
  async function corpus() {
    const fixture = await createFixture();
    const write = (content: string) =>
      memories.writeMemory({ agentId: fixture.agentId, scope: 'KNOWLEDGE', memoryType: 'DOCUMENT', content });

    // One paragraph names the thing asked about, once.
    await write('Providers: you can point the gateway at a local Ollama endpoint and use it like any other.');
    // Several repeat the common word instead.
    for (let i = 0; i < 12; i += 1) {
      await write(`Docker note ${i}: use the compose file, use the same ports, and use the storage volume as configured.`);
    }
    return fixture.agentId;
  }

  it('retrieves the passage that names it, not the ones repeating a common word', async () => {
    const agentId = await corpus();
    const found = await memories.selectRelevantMemories('KNOWLEDGE', {
      agentId,
      limit: 6,
      keywords: ['ollama', 'use'],
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.content).toContain('Ollama');
  });

  it('still returns the common matches behind it, rather than dropping them', () => {
    // The rare term orders the results; it does not filter them. A question
    // whose rare word appears nowhere must still find what it can.
    return (async () => {
      const agentId = await corpus();
      const found = await memories.selectRelevantMemories('KNOWLEDGE', {
        agentId,
        limit: 6,
        keywords: ['ollama', 'use'],
      });
      expect(found.length).toBeGreaterThan(1);
      expect(found.slice(1).some((m) => m.content.includes('Docker note'))).toBe(true);
    })();
  });

  it('falls back cleanly when no term is rare', async () => {
    const agentId = await corpus();
    const found = await memories.selectRelevantMemories('KNOWLEDGE', { agentId, limit: 3, keywords: ['use'] });
    expect(found.length).toBe(3);
  });

  it('returns nothing when the question names something the agent has never seen', async () => {
    const agentId = await corpus();
    const found = await memories.selectRelevantMemories('KNOWLEDGE', {
      agentId,
      limit: 6,
      keywords: ['kubernetes'],
    });
    expect(found).toEqual([]);
  });
});
