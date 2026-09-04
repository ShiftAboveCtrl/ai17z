import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { AgentDiagnostics } from '@xbam/shared/contracts';
import { accounts as accountsRepo, agents as agentsRepo, providers as providersRepo, query } from '@xbam/database';
import { collectDiagnostics } from '@xbam/runtime';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

/** Every string anywhere in the document, however deeply nested. */
function everyString(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) everyString(item, found);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) everyString(item, found);
  return found;
}

/**
 * An agent asked "why aren't you replying to mentions?" should be able to
 * answer, and answering needs facts about its own runtime.
 *
 * The risk is the whole design constraint: whatever reaches this document can
 * reach a prompt, and whatever reaches a prompt can be published. So the safety
 * is structural -- there is no field here a secret fits in -- and this test
 * walks the entire document looking for anything key-shaped, so a field added
 * later that could carry one fails here rather than on somebody's timeline.
 */
describe('what an agent may know about itself', () => {
  it('carries no secret, anywhere in the document', async () => {
    const fixture = await createFixture();
    // A credential with a key that is unmistakable if it ever leaks.
    const marker = `sk-diagnostics-must-never-carry-this-${uniqueSuffix()}`;
    await providersRepo.createProvider({
      ownerId: fixture.ownerId,
      provider: 'openai',
      label: 'Live provider',
      apiKey: marker,
      availableModels: ['gpt-4o'],
      defaultModel: 'gpt-4o',
    });

    const diagnostics = await collectDiagnostics(fixture.agentId);
    const strings = everyString(diagnostics);

    expect(strings.length).toBeGreaterThan(5);
    expect(strings.join('\n')).not.toContain(marker);
    // And nothing else key-shaped either, in case a future field carries one
    // that this test did not plant.
    for (const value of strings) {
      expect(value, `a key-shaped string reached the diagnostics: ${value.slice(0, 12)}...`).not.toMatch(
        /\b(?:sk|xai|ghp|gho|BSA)[-_][A-Za-z0-9-]{16,}/,
      );
    }
  });

  it('is exactly the shape the contract describes, so nothing extra rides along', async () => {
    const fixture = await createFixture();
    const diagnostics = await collectDiagnostics(fixture.agentId);
    // strict(): an unexpected field is a failure rather than something that
    // silently travels to the prompt.
    expect(() => AgentDiagnostics.parse(diagnostics)).not.toThrow();
  });

  it('says the agent cannot work, and why, when it is paused', async () => {
    const fixture = await createFixture();
    await agentsRepo.updateAgent(fixture.agentId, { state: 'PAUSED' });

    const diagnostics = await collectDiagnostics(fixture.agentId);
    expect(diagnostics.agent.canWork).toBe(false);
    expect(diagnostics.agent.reason).toContain('paused');
  });

  it('reports each radar monitor separately, because that is how they fail', async () => {
    // The whole point of the radar is that one surface being incomplete is not
    // silence. "The account is fine" is the wrong granularity: what somebody
    // needs to hear is which one stopped and what still works.
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `diag_${uniqueSuffix()}`,
    });
    await accountsRepo.updateAccount(account.id, { status: 'CONNECTED', enabled: true });
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION'],
      actionType: 'REPLY',
    });
    await query(
      `INSERT INTO radar_sources (account_id, kind, target, label, enabled, status, consecutive_failures, last_success_at)
       VALUES ($1, 'mention_search', '@me', 'Mention search', true, 'HEALTHY', 0, now()),
              ($1, 'notifications', NULL, 'Notifications', true, 'FAILING', 4, now() - interval '11 minutes')`,
      [account.id],
    );

    const diagnostics = await collectDiagnostics(fixture.agentId);
    const byName = new Map(diagnostics.radar.map((r): [string, (typeof diagnostics.radar)[number]] => [r.name, r]));

    expect(byName.get('Mention search')?.state).toBe('HEALTHY');
    expect(byName.get('Notifications')?.state).toBe('FAILING');
    // The number that makes the answer useful: eleven minutes, not "broken".
    expect(byName.get('Notifications')?.failingForMinutes).toBeGreaterThanOrEqual(10);
  });

  it('answers even when almost nothing is set up', async () => {
    // It is asked precisely when something is already broken, so it degrades to
    // UNKNOWN rather than throwing and telling somebody nothing at all.
    const fixture = await createFixture();
    const diagnostics = await collectDiagnostics(fixture.agentId);

    expect(diagnostics.account.connected).toBe(false);
    expect(diagnostics.collectedAt).toBeTruthy();
    expect(Array.isArray(diagnostics.recentFailures)).toBe(true);
  });

  it('reports nothing at all for an agent that does not exist, rather than throwing', async () => {
    const diagnostics = await collectDiagnostics('00000000-0000-0000-0000-000000000000');
    expect(diagnostics.agent.canWork).toBe(false);
    expect(diagnostics.agent.state).toBe('MISSING');
  });
});

/**
 * The tool has to be reachable, or the whole section is a capability the
 * product does not have.
 *
 * Tools need two switches -- enabled for the agent, and permitted by the
 * policy -- and requiring both for this one is friction with no safety behind
 * it: it takes no input, reaches no network, and reads a document with nowhere
 * to put a secret, so there is nothing for a hostile message to steer.
 */
describe('an agent being allowed to describe itself', () => {
  const signIn = async (email: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
    return { authorization: `Bearer ${(r.json() as { data: { token: string } }).data.token}` };
  };

  it('is permitted on an agent created the ordinary way', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const created = await app.inject({ method: 'POST', url: '/api/agents', headers: auth, payload: { name: 'Fresh Agent' } });
    expect(created.statusCode, created.body).toBe(200);

    const agentId = (created.json() as { data: { id: string } }).data.id;
    const policy = await agentsRepo.getActivePolicy(agentId);
    expect(policy!.config.tools.allowed).toContain('agent.diagnostics');
  });

  it('permits nothing else, because nothing else is safe to permit unasked', async () => {
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const created = await app.inject({ method: 'POST', url: '/api/agents', headers: auth, payload: { name: 'Second Agent' } });
    const agentId = (created.json() as { data: { id: string } }).data.id;
    const policy = await agentsRepo.getActivePolicy(agentId);
    expect(policy!.config.tools.allowed).toEqual(['agent.diagnostics']);
  });

  it('leaves a policy the owner wrote exactly as they wrote it', async () => {
    // A supplied policy is a decision. Adding to it would be changing somebody's
    // configuration behind their back, which is the whole reason this is not in
    // DEFAULT_POLICY.
    const fixture = await createFixture();
    const auth = await signIn(fixture.ownerEmail);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: auth,
      payload: { name: 'Deliberate Agent', policy: { tools: { allowed: [] } } },
    });
    const agentId = (created.json() as { data: { id: string } }).data.id;
    const policy = await agentsRepo.getActivePolicy(agentId);
    expect(policy!.config.tools.allowed).toEqual([]);
  });

  it('names a tool that actually exists', async () => {
    // The permission is written as a constant in the contracts package. If the
    // tool is renamed, this fails rather than the permission quietly pointing
    // at nothing.
    const { getToolDefinition } = await import('@xbam/tools');
    const { SELF_DIAGNOSTICS_TOOL } = await import('@xbam/shared/contracts');
    expect(getToolDefinition(SELF_DIAGNOSTICS_TOOL)).toBeTruthy();
  });
});
