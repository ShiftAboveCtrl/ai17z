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

/**
 * One shared common word is not relevance.
 *
 * Measured on a live installation with its documentation attached: "There's
 * only one. 0x..." retrieved six chunks of release notes on "there", "only"
 * and "one", and "Goated times" six more on "times". Every reply carried
 * documentation it had nothing to do with.
 */
describe('a knowledge base large enough to measure', () => {
  async function docs() {
    const fixture = await createFixture();
    const write = (content: string) =>
      memories.writeMemory({ agentId: fixture.agentId, scope: 'KNOWLEDGE', memoryType: 'DOCUMENT', content });
    await write('Providers: the gateway can point at a local Ollama endpoint.');
    await write('Pons V2 pairs launches against HOOD and routes creator fees through the hook.');
    for (let i = 0; i < 10; i += 1) {
      await write(`Release note ${i}: the installer checks the Docker engine once and waits a bounded time.`);
    }
    for (let i = 0; i < 30; i += 1) {
      await write(`Operations ${i}: one worker owns the browser and one tab reads mentions.`);
    }
    return fixture.agentId;
  }

  it('retrieves nothing for a word the corpus is full of', async () => {
    const agentId = await docs();
    // "one" is in half the rows; alone it identifies nothing.
    expect(await memories.selectRelevantMemories('KNOWLEDGE', { agentId, limit: 6, keywords: ['one'] })).toEqual([]);
  });

  it('does not take a single moderately common word as a match', async () => {
    const agentId = await docs();
    // A long post sharing one ordinary word with ten release notes.
    const found = await memories.selectRelevantMemories('KNOWLEDGE', { agentId, limit: 6, keywords: ['bounded', 'goated', 'frog'] });
    expect(found).toEqual([]);
  });

  it('still finds a passage by one rare word', async () => {
    const agentId = await docs();
    const found = await memories.selectRelevantMemories('KNOWLEDGE', { agentId, limit: 6, keywords: ['ollama'] });
    expect(found.map((m) => m.content)).toEqual(['Providers: the gateway can point at a local Ollama endpoint.']);
  });

  it('finds a passage matching two informative words', async () => {
    const agentId = await docs();
    const found = await memories.selectRelevantMemories('KNOWLEDGE', { agentId, limit: 6, keywords: ['installer', 'docker'] });
    expect(found.length).toBe(6);
    expect(found.every((m) => m.content.startsWith('Release note'))).toBe(true);
  });
});
