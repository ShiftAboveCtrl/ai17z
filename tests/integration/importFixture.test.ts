import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { memories, users } from '@xbam/database';
import { importAi4cz } from '../../tools/import-ai4cz/src/import';
import { installHarness } from '../support/harness';
import { uniqueSuffix } from '../support/db';

installHarness();

it('imports owner-selected style lines as pinned knowledge without changing the source', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'import-fixture-'));
  const corpus = JSON.stringify({ cz_speaking: ['Build something useful.'] });
  try {
    await writeFile(join(legacyDir, 'cz_speaking.json'), corpus);
    const owner = await users.createOwner({ email: `import-${uniqueSuffix()}@example.test`, password: 'test-password-1234', displayName: 'Importer' });
    const first = await importAi4cz({ legacyDir, ownerId: owner.id });
    expect(first.styleMemories).toBe(1);
    const page = await memories.searchMemories({ agentId: first.agentId!, scopes: ['KNOWLEDGE'] });
    expect(page.items).toEqual([expect.objectContaining({ content: 'Build something useful.', memoryType: 'STYLE_EXAMPLE', pinned: true })]);
    const second = await importAi4cz({ legacyDir, ownerId: owner.id });
    expect(second.agentId).toBe(first.agentId);
    expect(second.styleMemories).toBe(0);
    expect((await memories.searchMemories({ agentId: first.agentId!, scopes: ['KNOWLEDGE'] })).total).toBe(1);
  } finally {
    expect(await readdir(legacyDir)).toEqual(['cz_speaking.json']);
    expect(await readFile(join(legacyDir, 'cz_speaking.json'), 'utf8')).toBe(corpus);
    await rm(legacyDir, { recursive: true, force: true });
  }
});
