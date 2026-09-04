import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knowledge as knowledgeRepo, memories } from '@xbam/database';
import { indexSource, refreshAll } from '@xbam/runtime';
import { retrieveMemories } from '@xbam/memory';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

const repoRoot = resolve(__dirname, '../..');

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai17z-source-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return root;
}

/**
 * Teaching an agent a subject, and keeping it taught.
 *
 * Indexing once is the easy half. The half worth testing is the second read: a
 * source changes, and an agent still answering from last month's documents is
 * confidently wrong about its own subject, which is worse than knowing nothing.
 */
describe('a knowledge source', () => {
  it('indexes a folder into retrievable chunks that know where they came from', async () => {
    const fixture = await createFixture();
    const root = await folder({
      'install.md': '# Installing\n\n## Windows\n\nRun the installer from PowerShell. It needs Node 22 and Docker.\n\n## Ubuntu\n\nRun the shell script instead. Same requirements.',
      'tools.md': '# Tools\n\nWeb research and DexScreener are available to any agent that enables them.',
    });

    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Product documentation',
      kind: 'PATH',
      location: root,
    });

    const report = await indexSource(source, { roots: [root] });
    expect(report.error).toBeNull();
    expect(report.documents).toBe(2);
    expect(report.chunks).toBeGreaterThanOrEqual(3);
    // The hash the prune step keeps must be the hash the write stored, or a
    // refresh deletes everything it has just written.
    expect(report.removed).toBe(0);

    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['KNOWLEDGE'], limit: 50 });
    expect(stored.total).toBe(report.chunks);

    // The heading trail is what tells Windows apart from Ubuntu, and it has to
    // survive into what is retrieved.
    const windows = stored.items.find((m) => m.content.includes('PowerShell'));
    expect(windows).toBeDefined();
    expect(windows!.content).toContain('Installing > Windows');

    await rm(root, { recursive: true, force: true });
  });

  it('records the revision, so an answer can say which version it describes', async () => {
    const fixture = await createFixture();
    const root = await folder({ 'a.md': '# A\n\nSomething worth knowing about the product.' });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Docs',
      kind: 'PATH',
      location: root,
    });

    await indexSource(source, { roots: [root] });
    const after = await knowledgeRepo.getSource(source.id);
    expect(after!.revision).toMatch(/modified \d{4}-\d{2}-\d{2}/);
    expect(after!.indexedAt).toBeTruthy();
    expect(after!.lastError).toBeNull();

    await rm(root, { recursive: true, force: true });
  });

  it('a refresh removes what the source no longer says', async () => {
    // The whole point. A document that was withdrawn must stop being quoted.
    const fixture = await createFixture();
    const root = await folder({
      'keep.md': '# Keep\n\nThis section stays exactly as it is across both reads.',
      'drop.md': '# Drop\n\nUbuntu is not supported in this release and will not be.',
    });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Docs',
      kind: 'PATH',
      location: root,
    });

    const first = await indexSource(source, { roots: [root] });
    expect(first.chunks).toBe(2);

    await rm(join(root, 'drop.md'));
    await writeFile(join(root, 'keep.md'), '# Keep\n\nThis section stays exactly as it is across both reads.');

    const second = await indexSource(source, { roots: [root] });
    expect(second.chunks).toBe(1);
    expect(second.removed).toBe(1);

    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['KNOWLEDGE'], limit: 50 });
    expect(stored.total).toBe(1);
    expect(stored.items[0]!.content).not.toMatch(/Ubuntu is not supported/);

    await rm(root, { recursive: true, force: true });
  });

  it('re-reading unchanged documents does not duplicate them', async () => {
    const fixture = await createFixture();
    const root = await folder({ 'a.md': '# A\n\nA paragraph that will be read twice without changing.' });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Docs',
      kind: 'PATH',
      location: root,
    });

    await indexSource(source, { roots: [root] });
    await indexSource(source, { roots: [root] });

    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['KNOWLEDGE'], limit: 50 });
    expect(stored.total).toBe(1);

    await rm(root, { recursive: true, force: true });
  });

  it('never indexes a secret written inside a document that was allowed', async () => {
    // The include-list keeps a .env out. This is the setup guide somebody
    // filled in with their real values, which is common and which the agent
    // would otherwise repeat to whoever asked something adjacent.
    const fixture = await createFixture();
    const root = await folder({
      'setup.md': '# Setup\n\nPut this in your .env file to get started with the platform:\n\nAI17Z_MASTER_KEY=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ1\n',
      'safe.md': '# Safe\n\nSet AI17Z_MASTER_KEY in your .env before starting. Run npm run setup to generate one.',
    });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Docs',
      kind: 'PATH',
      location: root,
    });

    const report = await indexSource(source, { roots: [root] });
    expect(report.withheld).toHaveLength(1);
    expect(report.withheld[0]!.reason).toMatch(/master key/i);

    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['KNOWLEDGE'], limit: 50 });
    expect(stored.items.every((m) => !m.content.includes('Zm9vYmFyYmF6'))).toBe(true);
    // The advice about the key, which contains no key, is kept.
    expect(stored.items.some((m) => m.content.includes('npm run setup'))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it('refuses a folder outside the roots this installation permits', async () => {
    const fixture = await createFixture();
    const root = await folder({ 'a.md': '# A\n\nSomething.' });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Docs',
      kind: 'PATH',
      location: root,
    });

    const report = await indexSource(source, { roots: [repoRoot] });
    expect(report.error).toMatch(/outside every folder/);
    expect(report.chunks).toBe(0);

    const after = await knowledgeRepo.getSource(source.id);
    expect(after!.lastError).toMatch(/outside every folder/);

    await rm(root, { recursive: true, force: true });
  });

  it('deleting a source removes everything it taught', async () => {
    // An agent that goes on citing documents its owner withdrew is worse than
    // one that knows nothing.
    const fixture = await createFixture();
    const root = await folder({ 'a.md': '# A\n\nA fact that should disappear with its source.' });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Docs',
      kind: 'PATH',
      location: root,
    });
    await indexSource(source, { roots: [root] });

    await knowledgeRepo.deleteSource(source.id);
    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['KNOWLEDGE'], limit: 50 });
    expect(stored.total).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it('keeps two sources apart', async () => {
    const fixture = await createFixture();
    const one = await folder({ 'a.md': '# One\n\nThe first source says this particular thing.' });
    const two = await folder({ 'b.md': '# Two\n\nThe second source says something else entirely.' });

    const first = await knowledgeRepo.createSource({ agentId: fixture.agentId, name: 'First', kind: 'PATH', location: one });
    const second = await knowledgeRepo.createSource({ agentId: fixture.agentId, name: 'Second', kind: 'PATH', location: two });
    await indexSource(first, { roots: [one] });
    await indexSource(second, { roots: [two] });

    expect(await knowledgeRepo.countChunks(first.id)).toBe(1);
    expect(await knowledgeRepo.countChunks(second.id)).toBe(1);

    // Refreshing one must not prune the other's chunks.
    await indexSource(first, { roots: [one] });
    expect(await knowledgeRepo.countChunks(second.id)).toBe(1);

    await rm(one, { recursive: true, force: true });
    await rm(two, { recursive: true, force: true });
  });

  it('documentation outranks a stale recollection, and both are still shown', async () => {
    // The hard rule. If a conversation in March said Ubuntu was unsupported and
    // the documentation installed now says it is verified, the document is the
    // one still true. Nothing is discarded, so the agent can say its
    // recollection differs -- a better answer than either alone.
    const fixture = await createFixture();
    const root = await folder({
      'platforms.md': '# Supported platforms\n\nUbuntu is verified in this release and runs the same way as Windows.',
    });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Product documentation',
      kind: 'PATH',
      location: root,
    });
    await indexSource(source, { roots: [root] });

    await memories.writeMemory({
      agentId: fixture.agentId,
      scope: 'EPISODIC',
      memoryType: 'SUMMARY',
      content: 'Ubuntu is not supported and there is no plan to support it.',
      importance: 0.9,
    });

    const outcome = await retrieveMemories({
      agentId: fixture.agentId,
      // Episodic recall is off by default, so this turns it on: the point is
      // the ordering between the two, which needs both to be present.
      policy: {
        ...DEFAULT_POLICY.memory,
        retrieval: {
          ...DEFAULT_POLICY.memory.retrieval,
          episodic: { ...DEFAULT_POLICY.memory.retrieval.episodic, enabled: true },
        },
      },
      conversationId: null,
      remoteHandle: null,
      accountId: null,
      incomingText: 'does Ubuntu work in this release?',
    });

    const scopes = outcome.memories.map((m) => m.scope);
    expect(scopes).toContain('KNOWLEDGE');
    expect(scopes).toContain('EPISODIC');
    expect(scopes.indexOf('KNOWLEDGE')).toBeLessThan(scopes.indexOf('EPISODIC'));

    await rm(root, { recursive: true, force: true });
  });

  it('a retrieved document carries the whole passage and where it came from', async () => {
    // Not just its heading. Every other scope stores a summary worth showing
    // instead of the body; a chunk's summary is its heading, and showing that
    // alone put a section title into the prompt with none of its instructions.
    const fixture = await createFixture();
    const root = await folder({
      'install.md': '# Installing\n\n## Windows\n\nRun the installer from PowerShell. It needs Node 22 and Docker Desktop.',
    });
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'Product documentation',
      kind: 'PATH',
      location: root,
    });
    await indexSource(source, { roots: [root] });

    const outcome = await retrieveMemories({
      agentId: fixture.agentId,
      policy: DEFAULT_POLICY.memory,
      conversationId: null,
      remoteHandle: null,
      accountId: null,
      incomingText: 'how do I install this on Windows?',
    });
    const chunk = outcome.memories.find((m) => m.scope === 'KNOWLEDGE');
    expect(chunk).toBeDefined();
    expect(chunk!.content).toContain('Node 22');
    expect(chunk!.origin?.sourceName).toBe('Product documentation');
    expect(chunk!.origin?.path).toBe('install.md');
    expect(chunk!.origin?.revision).toMatch(/modified \d{4}/);

    await rm(root, { recursive: true, force: true });
  });

  it('teaches an agent from pasted text with no folder at all', async () => {
    const fixture = await createFixture();
    const source = await knowledgeRepo.createSource({
      agentId: fixture.agentId,
      name: 'House rules',
      kind: 'TEXT',
      location: '# Support hours\n\nWe answer between nine and five, UK time, on working days.',
    });

    const report = await indexSource(source);
    expect(report.chunks).toBe(1);
    expect(report.revision).toMatch(/edited \d{4}-\d{2}-\d{2}/);
  });

  it('refreshes every enabled source and skips the disabled ones', async () => {
    const fixture = await createFixture();
    const on = await folder({ 'a.md': '# On\n\nThis source is enabled and should be read.' });
    const off = await folder({ 'b.md': '# Off\n\nThis source is disabled and should be left alone.' });

    const enabled = await knowledgeRepo.createSource({ agentId: fixture.agentId, name: 'On', kind: 'PATH', location: on });
    const disabled = await knowledgeRepo.createSource({ agentId: fixture.agentId, name: 'Off', kind: 'PATH', location: off });
    await knowledgeRepo.updateSource(disabled.id, { enabled: false });

    const reports = await refreshAll(fixture.agentId, { roots: [on, off] });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sourceId).toBe(enabled.id);

    await rm(on, { recursive: true, force: true });
    await rm(off, { recursive: true, force: true });
  });
});
