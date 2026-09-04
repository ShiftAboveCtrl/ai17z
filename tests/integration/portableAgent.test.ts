import { describe, expect, it } from 'vitest';
import { NEVER_EXPORTED, PortableAgent } from '@xbam/shared/contracts';
import { agents as agentsRepo, providers as providersRepo, query } from '@xbam/database';
import { describeDuplicateScope, duplicateAgent, exportAgent, importAgent } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

/** Every key and every string anywhere in a document, however deep. */
function walk(value: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (typeof value === 'string') strings.push(value);
  else if (Array.isArray(value)) for (const item of value) walk(item, keys, strings);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      walk(item, keys, strings);
    }
  }
  return { keys, strings };
}

/**
 * The line runs between what somebody decided and what happened.
 *
 * A persona, a policy, which model role does what: decided, and portable. A
 * session, a browser profile, a memory, a relationship: happened, and not. It is
 * not a matter of degree -- a shared preset carrying somebody's browser profile
 * is a shared login.
 */
describe('writing an agent down', () => {
  it('carries no secret, under any key, anywhere', async () => {
    const fixture = await createFixture();
    const marker = `sk-must-never-be-exported-${uniqueSuffix()}`;
    await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'Live provider',
      apiKey: marker,
      availableModels: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });

    const document = await exportAgent(fixture.agentId);
    const { keys, strings } = walk(document);

    expect(strings.join('\n')).not.toContain(marker);
    for (const banned of NEVER_EXPORTED) {
      expect(keys.map((k) => k.toLowerCase()), `an exported document must have no "${banned}" key`).not.toContain(
        banned.toLowerCase(),
      );
    }
  });

  it('names the provider but never the credential', async () => {
    // Enough for an importer to say "this wants an Anthropic model and you have
    // none", and not enough to be a credential.
    const fixture = await createFixture();
    const document = await exportAgent(fixture.agentId);
    for (const role of document.models) {
      expect(role.provider).toBeTruthy();
      expect(Object.keys(role)).not.toContain('providerCredentialId');
    }
  });

  it('is a document this version can read back', async () => {
    const fixture = await createFixture();
    const document = await exportAgent(fixture.agentId);
    expect(PortableAgent.safeParse(document).success).toBe(true);
  });

  it('refuses an unknown field rather than letting it ride along', async () => {
    const fixture = await createFixture();
    const document = { ...(await exportAgent(fixture.agentId)), somethingElse: 'from somewhere' };
    await expect(importAgent({ ownerId: fixture.ownerId, document })).rejects.toThrow();
  });

  it('refuses a file from a newer version, saying so', async () => {
    const fixture = await createFixture();
    const document = { ...(await exportAgent(fixture.agentId)), version: 99 };
    await expect(importAgent({ ownerId: fixture.ownerId, document })).rejects.toThrow(/newer AI17Z/);
  });
});

describe('reading an agent back in', () => {
  it('makes a new agent rather than overwriting one', async () => {
    const fixture = await createFixture();
    const document = await exportAgent(fixture.agentId);
    const report = await importAgent({ ownerId: fixture.ownerId, document, name: 'Imported' });

    expect(report.agentId).not.toBe(fixture.agentId);
    expect((await agentsRepo.getAgent(fixture.agentId))!.name).not.toBe('Imported');
  });

  it('brings the persona and the policy across', async () => {
    const fixture = await createFixture();
    const original = await agentsRepo.getActivePersona(fixture.agentId);
    const report = await importAgent({ ownerId: fixture.ownerId, document: await exportAgent(fixture.agentId) });
    const copy = await agentsRepo.getActivePersona(report.agentId);
    expect(copy!.personality).toBe(original!.personality);
  });

  it('says what could not be carried, rather than dropping it in silence', async () => {
    const fixture = await createFixture();
    const report = await importAgent({ ownerId: fixture.ownerId, document: await exportAgent(fixture.agentId) });
    expect(report.notes.join(' ')).toContain('No account, session or browser profile');
  });

  it('never arrives posting', async () => {
    // An imported agent that begins posting before anybody has looked at it is
    // the worst possible first impression.
    const fixture = await createFixture();
    const document = { ...(await exportAgent(fixture.agentId)), posting: { enabled: true, intervalSeconds: 3_600, jitterPercent: 25 } };
    const report = await importAgent({ ownerId: fixture.ownerId, document });

    const [row] = await query<{ enabled: boolean }>('SELECT enabled FROM agent_posting WHERE agent_id = $1', [report.agentId]);
    expect(row?.enabled ?? false).toBe(false);
    expect(report.notes.join(' ')).toContain('Posting was on in the file');
  });
});

describe('copying an agent', () => {
  it('gives the copy its own identity', async () => {
    const fixture = await createFixture();
    const report = await duplicateAgent({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      name: 'A copy',
      scope: 'EVERYTHING',
    });
    expect(report.agentId).not.toBe(fixture.agentId);
  });

  it('leaves the original alone when the copy is renamed', async () => {
    const fixture = await createFixture();
    const before = (await agentsRepo.getAgent(fixture.agentId))!.name;
    const report = await duplicateAgent({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      name: 'Renamed copy',
      scope: 'EVERYTHING',
    });
    await agentsRepo.updateAgent(report.agentId, { name: 'Changed again' });
    expect((await agentsRepo.getAgent(fixture.agentId))!.name).toBe(before);
  });

  it('never brings memories or relationships', async () => {
    // A copy that inherited them would be an agent that believes it has met
    // people it has never spoken to.
    const fixture = await createFixture();
    await query(
      `INSERT INTO memories (agent_id, scope, scope_key, memory_type, content, summary, importance, content_hash)
       VALUES ($1,'USER','alice','FACT','They dislike emoji.','Dislikes emoji',0.8,$2)`,
      [fixture.agentId, `dup-${uniqueSuffix()}`],
    );

    const report = await duplicateAgent({
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      name: 'A copy',
      scope: 'EVERYTHING',
    });

    const [row] = await query<{ n: number }>('SELECT count(*)::int AS n FROM memories WHERE agent_id = $1', [report.agentId]);
    expect(row!.n).toBe(0);
    expect(report.notes.join(' ')).toContain('stay with the original');
  });

  it('says what each choice will and will not bring, before it is made', async () => {
    for (const scope of ['PERSONA_ONLY', 'PERSONA_AND_MODELS', 'EVERYTHING'] as const) {
      const described = describeDuplicateScope(scope);
      expect(described.copies.length).toBeGreaterThan(0);
      // Every scope leaves the session and the memories behind, and every one
      // of them says so.
      expect(described.leaves.join(' ')).toContain('browser session');
      expect(described.leaves.join(' ')).toContain('Memories');
    }
  });
});
