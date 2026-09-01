import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agents, legacyLedger, memories, query, users } from '@xbam/database';
import { importAi4cz } from '../../tools/import-ai4cz/src/import';
import { installHarness } from '../support/harness';
import { uniqueSuffix } from '../support/db';
import { seedCatalogue } from '../support/fixtures';

installHarness();

// No default: this suite needs a real AI4CZ installation to read, and there is
// no sensible guess for where somebody keeps theirs. It skips without one.
const LEGACY_DIR = process.env.AI4CZ_LEGACY_DIR ?? '';
const available = existsSync(LEGACY_DIR);

/**
 * These run only where the legacy project is present. They assert the two
 * properties that matter for a migration: it is repeatable, and it refuses to
 * bring across identity deception or credentials.
 */
describe.skipIf(!available)('AI4CZ import', () => {
  async function owner(): Promise<string> {
    await seedCatalogue();
    const user = await users.createOwner({
      email: `import-${uniqueSuffix()}@example.test`,
      password: 'test-password-1234',
      displayName: 'Importer',
    });
    return user.id;
  }

  it('imports the persona, corpus, history and ledgers in one pass', async () => {
    const ownerId = await owner();
    const report = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });

    expect(report.agentCreated).toBe(true);
    expect(report.secretsImported).toBe(0);
    expect(report.styleMemories).toBe(128);
    expect(report.conversationTurns).toBe(272);
    expect(report.postedSignatures).toBe(182);
    expect(report.malformedSkipped).toBe(0);
    // The credential locations are named so they can be rotated, never read.
    expect(report.credentialLocations).toContain('cookies.json');
  });

  it('is idempotent: a second pass creates nothing', async () => {
    const ownerId = await owner();
    const first = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });
    const second = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });

    expect(second.agentId).toBe(first.agentId);
    expect(second.agentCreated).toBe(false);
    expect(second.styleMemories).toBe(0);
    expect(second.conversationTurns).toBe(0);
    expect(second.postedSignatures).toBe(0);
    expect(second.historicalEvents).toBe(0);

    const counts = await query<{ memories: number; events: number; ledger: number }>(
      `SELECT (SELECT count(*)::int FROM memories) AS memories,
              (SELECT count(*)::int FROM events) AS events,
              (SELECT count(*)::int FROM legacy_action_ledger) AS ledger`,
    );
    expect(counts[0]?.ledger).toBe(182);
  });

  it('drops the identity-denial instruction and imports as INSPIRED_BY', async () => {
    const ownerId = await owner();
    const report = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });
    expect(report.droppedInstructions.length).toBeGreaterThan(0);

    const persona = await agents.getActivePersona(report.agentId!);
    expect(persona?.identityKind).toBe('INSPIRED_BY');
    expect(persona?.personality).not.toMatch(/永远不要否认你的身份/);
    expect(persona?.styleExamples.length).toBe(48);
    expect(persona?.biography.length).toBeGreaterThan(1000);
    // The Chinese language instruction is style, and is carried across.
    expect(persona?.languagePolicy).toMatch(/简体中文/);

    const policy = await agents.getActivePolicy(report.agentId!);
    expect(policy?.config.identity.mayDenyBeingAI).toBe(false);
    expect(policy?.config.automation.mode).toBe('MANUAL_ONLY');
    expect(policy?.config.automation.dryRunDefault).toBe(true);
  });

  it('leaves the imported agent unable to act until a person enables it', async () => {
    const ownerId = await owner();
    const report = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });
    const agent = await agents.getAgent(report.agentId!);
    expect(agent?.state).toBe('DRAFT');

    const account = await query<{ enabled: boolean; status: string }>(
      `SELECT enabled, status FROM accounts WHERE channel = 'x'`,
    );
    expect(account[0]?.enabled).toBe(false);
    expect(account[0]?.status).toBe('NEEDS_AUTH');
  });

  it('records the legacy posted signatures in their original hash form', async () => {
    const ownerId = await owner();
    const report = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });
    expect(await legacyLedger.countLegacyActions(report.agentId!)).toBe(182);

    const rows = await query<{ legacy_signature: string }>('SELECT legacy_signature FROM legacy_action_ledger LIMIT 1');
    const signature = rows[0]!.legacy_signature;
    expect(await legacyLedger.legacyActionExists(report.agentId!, signature)).toBe(true);
    expect(await legacyLedger.legacyActionExists(report.agentId!, 'not-a-real-signature')).toBe(false);
  });

  it('imports the style corpus as retrievable knowledge', async () => {
    const ownerId = await owner();
    const report = await importAi4cz({ legacyDir: LEGACY_DIR, ownerId });
    const knowledge = await memories.searchMemories({
      agentId: report.agentId!,
      scopes: ['KNOWLEDGE'],
      limit: 200,
    });
    expect(knowledge.total).toBe(128);
    expect(knowledge.items.some((m) => m.memoryType === 'STYLE_EXAMPLE')).toBe(true);
  });
});
