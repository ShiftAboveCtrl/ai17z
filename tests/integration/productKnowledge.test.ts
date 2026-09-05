import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knowledge as knowledgeRepo } from '@xbam/database';
import { builtInSources, indexSource } from '@xbam/runtime';
import { retrieveMemories } from '@xbam/memory';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const repoRoot = resolve(__dirname, '../..');
const docs = resolve(repoRoot, 'docs');

async function taughtAgent(): Promise<string> {
  const fixture = await createFixture();
  const source = await knowledgeRepo.createSource({
    agentId: fixture.agentId,
    name: 'AI17Z documentation',
    kind: 'PATH',
    location: docs,
  });
  const report = await indexSource(source, { roots: [repoRoot] });
  expect(report.error).toBeNull();
  return fixture.agentId;
}

async function ask(agentId: string, question: string) {
  return retrieveMemories({
    agentId,
    policy: DEFAULT_POLICY.memory,
    conversationId: null,
    remoteHandle: null,
    accountId: null,
    incomingText: question,
  });
}

/**
 * The proving case: this project's own documentation, indexed by the general
 * mechanism and asked the questions people actually ask.
 *
 * Nothing here is AI17Z-specific machinery. It is a folder attached as a source,
 * which is the point -- if teaching an agent about AI17Z needs anything the
 * mechanism does not already do, then teaching it about somebody else's project
 * would need it too.
 *
 * These assert that the right passage is *retrieved*. Whether the sentence built
 * from it is any good is the model's business and cannot be pinned in a test.
 */
describe('an agent taught from the documentation shipped with it', () => {
  it('indexes the real documentation without choking on any of it', async () => {
    const fixture = await createFixture();
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'AI17Z documentation',
      kind: 'PATH',
      location: docs,
    });

    const report = await indexSource(source, { roots: [repoRoot] });
    expect(report.error).toBeNull();
    // Five: the Windows install and uninstall pages, the trust page, privacy
    // and the code signing policy. It was twenty-odd until the architecture
    // notes were taken out of the repository -- see the note above the
    // question list for what that cost.
    expect(report.documents).toBeGreaterThanOrEqual(5);
    expect(report.chunks).toBeGreaterThan(20);
    // Nothing it read looked like a credential. If this ever fires, something
    // went into the documentation that should not be there.
    expect(report.withheld).toEqual([]);
    // And the second read must not delete the first read's work.
    expect(report.removed).toBe(0);
  });

  it('offers itself as a source without being told where anything is', async () => {
    const offered = await builtInSources();
    expect(offered).toHaveLength(1);
    expect(offered[0]!.name).toBe('AI17Z documentation');
    expect(offered[0]!.location).toContain('docs');
  });

  /**
   * What the shipped documentation can answer.
   *
   * This list used to be ten questions and is now six. The architecture notes
   * -- memory, Easy Mode, posting, capabilities, the social layer -- were
   * removed from the repository, and with them went the agent's ability to
   * answer four of the questions people most often ask about it:
   *
   *     what is Easy Mode?        how does memory work?
   *     how does posting work?    why is my tool blocked?
   *
   * Nothing is broken; the feature has less to read. Putting `docs/architecture`
   * and `docs/operations` back restores all four, and this list should grow
   * again if that happens. Recorded here rather than in a commit message
   * because this file is where somebody would notice.
   */
  it.each([
    ['how do I install AI17Z on Windows?', /install/i],
    ['why does it use real Chrome?', /chrome/i],
    ['how does mention search work?', /mention|search|radar/i],
    ['can I use Ollama?', /ollama|provider|model/i],
    ['where are API keys stored?', /key|secret|encrypt/i],
    ['what happens when a job fails?', /job|retry|fail/i],
  ])('retrieves something relevant for %j', async (question, expected) => {
    const agentId = await taughtAgent();
    const outcome = await ask(agentId, question);
    const documents = outcome.memories.filter((m) => m.scope === 'KNOWLEDGE');
    expect(documents.length, `nothing retrieved for: ${question}`).toBeGreaterThan(0);
    expect(documents.map((d) => d.content).join('\n')).toMatch(expected);
  });

  it('every retrieved passage says which document and which revision it came from', async () => {
    // Without this an answer cannot say which version it describes, and section
    // 25's rule -- current documentation beats stale recollection -- has nothing
    // to compare.
    const agentId = await taughtAgent();
    const outcome = await ask(agentId, 'how do I install this and what does it need?');
    const documents = outcome.memories.filter((m) => m.scope === 'KNOWLEDGE');
    expect(documents.length).toBeGreaterThan(0);

    for (const chunk of documents) {
      expect(chunk.origin?.sourceName).toBe('AI17Z documentation');
      expect(chunk.origin?.path).toMatch(/\.md$/);
      expect(chunk.origin?.revision).toBeTruthy();
    }
  });

  it('reads the revision from git, so it names a commit rather than a date', async () => {
    // This repository is a git checkout, which is the case that matters: a
    // commit is the exact answer to "which version does this describe".
    const fixture = await createFixture();
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'AI17Z documentation',
      kind: 'PATH',
      location: docs,
    });
    await indexSource(source, { roots: [repoRoot] });

    const after = await knowledgeRepo.getSource(source.id);
    expect(after!.revision).toMatch(/^[0-9a-f]{7,}( \(with local changes\))?$/);
  });

  it('retrieves nothing for a question the documentation does not answer', async () => {
    // An empty result is the honest one, and is what lets the agent say it does
    // not know rather than reaching for the nearest paragraph.
    const agentId = await taughtAgent();
    const outcome = await ask(agentId, 'what is the capital of Portugal?');
    expect(outcome.memories.filter((m) => m.scope === 'KNOWLEDGE')).toHaveLength(0);
  });
});
