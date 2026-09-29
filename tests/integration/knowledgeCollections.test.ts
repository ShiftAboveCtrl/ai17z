import { describe, expect, it } from 'vitest';
import { knowledge as knowledgeRepo, query } from '@xbam/database';
import { indexCollection } from '@xbam/runtime';
import { knowledgeFreshness } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { docPage, fakeWeb, lorem } from '../support/fakeWeb';

installHarness();

/**
 * Knowledge collections through the real indexer and real Postgres: what a
 * refresh rewrites, what it removes, what it must not remove, and the labels
 * every chunk carries. The web is fake; every page is invented.
 */

const SITE = 'https://docs.example.com';

async function chunksByPath(sourceId: string): Promise<Record<string, number>> {
  const rows = await query<{ path: string; n: string }>(
    `SELECT origin->>'path' AS path, count(*) AS n FROM memories WHERE knowledge_source_id = $1 GROUP BY 1`,
    [sourceId],
  );
  return Object.fromEntries(rows.map((r) => [r.path, Number(r.n)]));
}

describe('a documentation site collection', () => {
  const pages = (guideBody: string, withOld = true) => ({
    // The home page keeps its link to the old page: a page deleted from a site
    // usually leaves a dead link behind, and the home page itself is unchanged.
    [`${SITE}/v2`]: docPage('Home', lorem('The home page'), ['/v2/guide', '/v2/old']),
    [`${SITE}/v2/guide`]: docPage('Guide', guideBody),
    ...(withOld ? { [`${SITE}/v2/old`]: docPage('Old', lorem('An old page')) } : {}),
  });

  it('reads every page, then on refresh rewrites only what changed and removes what went', async () => {
    const { agentId } = await createFixture();
    const source = await knowledgeRepo.createSource({
      agentId,
      name: 'Pons docs V2',
      kind: 'DOCUMENTATION_SITE',
      location: `${SITE}/v2`,
      labels: { generation: 'V2', authority: 'OFFICIAL' },
    });

    const first = await indexCollection(source, { fetch: fakeWeb(pages(lorem('The guide'))).fetch, delayMs: 0 });
    expect(first.error).toBeNull();
    expect(first.change).toMatchObject({ added: 3, changed: 0, removed: 0 });
    expect(first.documents).toBe(3);

    const refreshed = await knowledgeRepo.getSource(source.id);
    const second = await indexCollection(refreshed!, { fetch: fakeWeb(pages(lorem('The rewritten guide'), false)).fetch, delayMs: 0 });
    expect(second.change).toMatchObject({ added: 0, changed: 1, removed: 1, unchanged: 1 });
    const chunks = await chunksByPath(source.id);
    expect(Object.keys(chunks).sort()).toEqual([`${SITE}/v2`, `${SITE}/v2/guide`]);

    const after = (await knowledgeRepo.getSource(source.id))!;
    expect(after.lastChange).toMatchObject({ changed: 1, removed: 1 });
    expect(knowledgeFreshness(after)).toBe('CHANGED');
  });

  it('carries its labels on every chunk', async () => {
    const { agentId } = await createFixture();
    const source = await knowledgeRepo.createSource({
      agentId,
      name: 'Pons docs V1',
      kind: 'DOCUMENTATION_SITE',
      location: `${SITE}/v2`,
      labels: { generation: 'V1', authority: 'OFFICIAL' },
    });
    await indexCollection(source, { fetch: fakeWeb(pages(lorem('The guide'))).fetch, delayMs: 0 });
    const rows = await query<{ origin: Record<string, unknown> }>('SELECT origin FROM memories WHERE knowledge_source_id = $1', [source.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.origin.generation).toBe('V1');
      expect(row.origin.authority).toBe('OFFICIAL');
      expect(row.origin.sourceName).toBe('Pons docs V1');
    }
  });

  it('does not remove pages a stopped crawl never reached', async () => {
    const { agentId } = await createFixture();
    const source = await knowledgeRepo.createSource({ agentId, name: 'Docs', kind: 'DOCUMENTATION_SITE', location: `${SITE}/v2` });
    await indexCollection(source, { fetch: fakeWeb(pages(lorem('The guide'))).fetch, delayMs: 0 });

    const limited = await knowledgeRepo.updateSource(source.id, { config: { maxPages: 1 } });
    const report = await indexCollection(limited, { fetch: fakeWeb(pages(lorem('The guide'))).fetch, delayMs: 0 });
    expect(report.partial).toMatch(/1 pages/);
    expect(report.change.removed).toBe(0);
    expect(Object.keys(await chunksByPath(source.id))).toHaveLength(3);
  });

  it('records a site that cannot be read as unavailable, in a sentence', async () => {
    const { agentId } = await createFixture();
    const source = await knowledgeRepo.createSource({ agentId, name: 'Gone', kind: 'DOCUMENTATION_SITE', location: `${SITE}/missing` });
    const report = await indexCollection(source, { fetch: fakeWeb({}).fetch, delayMs: 0 });
    expect(report.error).toMatch(/No page could be read/);
    const after = (await knowledgeRepo.getSource(source.id))!;
    expect(after.errorKind).toBe('UNAVAILABLE');
    expect(knowledgeFreshness(after)).toBe('UNAVAILABLE');
  });
});

describe('a GitHub repository collection', () => {
  const COMMIT_A = 'a'.repeat(40);
  const COMMIT_B = 'b'.repeat(40);
  const repo = (commit: string, guideSha: string, guideText: string) =>
    fakeWeb({
      'https://api.github.com/repos/acme/pons': JSON.stringify({ default_branch: 'main' }),
      'https://api.github.com/repos/acme/pons/commits/main': JSON.stringify({ sha: commit }),
      [`https://api.github.com/repos/acme/pons/git/trees/${commit}?recursive=1`]: JSON.stringify({
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob', sha: 'readme1', size: 300 },
          { path: 'docs/guide.md', type: 'blob', sha: guideSha, size: 300 },
          { path: 'node_modules/dep/README.md', type: 'blob', sha: 'dep', size: 300 },
        ],
      }),
      [`https://raw.githubusercontent.com/acme/pons/${commit}/README.md`]: `# Pons\n\n${lorem('The project')}`,
      [`https://raw.githubusercontent.com/acme/pons/${commit}/docs/guide.md`]: `# Guide\n\n${guideText}`,
    });

  it('reads at a commit, keeps the commit on every chunk, and refreshes by changed files only', async () => {
    const { agentId } = await createFixture();
    const source = await knowledgeRepo.createSource({ agentId, name: 'Pons repo', kind: 'GITHUB_REPOSITORY', location: 'https://github.com/acme/pons' });

    const first = await indexCollection(source, { fetch: repo(COMMIT_A, 'guide1', lorem('The guide')).fetch });
    expect(first.error).toBeNull();
    expect(first.revision).toBe(COMMIT_A.slice(0, 12));
    expect(first.change.added).toBe(2);
    expect(Object.keys(await chunksByPath(source.id)).sort()).toEqual(['README.md', 'docs/guide.md']);

    const web = repo(COMMIT_B, 'guide2', lorem('The changed guide'));
    const second = await indexCollection((await knowledgeRepo.getSource(source.id))!, { fetch: web.fetch });
    expect(second.change).toMatchObject({ added: 0, changed: 1, unchanged: 1, removed: 0 });
    // The unchanged README was never fetched again.
    expect(web.requests.some((r) => r.endsWith('/README.md'))).toBe(false);
    const rows = await query<{ revision: string }>(
      `SELECT origin->>'revision' AS revision FROM memories WHERE knowledge_source_id = $1 AND origin->>'path' = 'docs/guide.md'`,
      [source.id],
    );
    expect(new Set(rows.map((r) => r.revision))).toEqual(new Set(['guide2']));
  });

  it('says a missing repository is unavailable and that only public ones can be taught', async () => {
    const { agentId } = await createFixture();
    const source = await knowledgeRepo.createSource({ agentId, name: 'Private', kind: 'GITHUB_REPOSITORY', location: 'acme/secret' });
    const report = await indexCollection(source, { fetch: fakeWeb({}).fetch });
    expect(report.error).toMatch(/Only public repositories/);
    expect((await knowledgeRepo.getSource(source.id))!.errorKind).toBe('UNAVAILABLE');
  });
});
