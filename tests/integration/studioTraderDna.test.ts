import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts as accountsRepo, agents as agentsRepo, content as contentRepo, jobs as jobsRepo, ops } from '@xbam/database';
import { originatePost, proposeTraderDnaPost, registerStudioTraderDnaCapabilities, setCapabilityPermission } from '@xbam/runtime';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';
import { invokeCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';
import { EVM_WALLET, studyFixture } from '../support/traderDnaStudy';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../packages/runtime/src/studioLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/runtime/src/studioLink')>()),
  studioInstallationRequest: request,
  studioInstallationReady: async () => ({ linked: true as const }),
}));

installHarness();

/**
 * Trader DNA against a real database and the real posting engine. Studio is
 * stood in for at the one function that talks to it, because the transport
 * (DPoP, linking) is proved elsewhere and this file is about what the agent does
 * with an answer.
 */

const answer = (body: unknown, status = 200) => ({ ok: true as const, status, body, sentence: `Studio answered ${status}.` });
const policyWith = (studio: Record<string, unknown>) => PolicyConfig.parse({ ...DEFAULT_POLICY, studio: { ...DEFAULT_POLICY.studio, ...studio } });

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    const id = path.split('/').pop();
    return id === 'early-entry-study' ? answer(studyFixture()) : answer({ error: 'not_found' }, 404);
  });
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  registerStudioTraderDnaCapabilities();
});

async function ready(studio: Record<string, unknown> | null, permission: 'ALLOWED' | null = 'ALLOWED') {
  const fixture = await createFixture(studio ? { policy: { studio: policyWith(studio).studio } } : {});
  if (permission) await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'studio.trader_dna', permission });
  return fixture;
}

const ask = (agentId: string, input: Record<string, unknown>, audience: 'OWNER' | 'PUBLIC' = 'OWNER') =>
  invokeCapability({
    call: { id: 'studio.trader_dna', input },
    context: { agentId, jobId: null, accountId: null, config: {}, audience, logger: console as never },
    permission: { stored: 'ALLOWED', paused: false },
  });

describe('owner chat', () => {
  it('is refused outside owner chat', async () => {
    const fixture = await ready(null);
    const result = await ask(fixture.agentId, { study: 'early-entry-study' }, 'PUBLIC');
    expect(JSON.stringify(result)).toMatch(/owner/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('answers for a published study and for an unpublished id without a figure', async () => {
    const fixture = await ready(null);
    const ok = (await ask(fixture.agentId, { study: 'early-entry-study' })).output as { state: string; sample: unknown };
    expect(ok.state).toBe('AVAILABLE');
    expect(ok.sample).toEqual({ wallets: 41, trades: 1530 });
    const gone = (await ask(fixture.agentId, { study: 'unpublished-run-9' })).output as { state: string; sample: unknown; wallets: unknown[]; statement: string };
    expect(gone.state).toBe('UNAVAILABLE');
    expect(gone.sample).toBeNull();
    expect(gone.wallets).toEqual([]);
    expect(gone.statement).toMatch(/Nothing was traded/);
  });
});

describe('posting a study', () => {
  const on = { postTraderDna: true, traderDnaStudyId: 'early-entry-study' };

  it('is off by default: Studio is not asked and nothing is proposed', async () => {
    const fixture = await ready(null);
    const outcome = await proposeTraderDnaPost(fixture.agentId);
    expect(outcome.proposed).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(await contentRepo.listIdeas(fixture.agentId)).toHaveLength(0);
  });

  it('needs a chosen study and the capability on for this agent', async () => {
    const noStudy = await ready({ postTraderDna: true });
    expect((await proposeTraderDnaPost(noStudy.agentId)).why).toMatch(/No published study was chosen/);
    const noPermission = await ready(on, null);
    expect((await proposeTraderDnaPost(noPermission.agentId)).why).toMatch(/switched off/);
    expect(request).not.toHaveBeenCalled();
  });

  it('adds one idea for a published study, once, without a wallet in it', async () => {
    const fixture = await ready(on);
    expect(await proposeTraderDnaPost(fixture.agentId)).toMatchObject({ proposed: true });
    const ideas = await contentRepo.listIdeas(fixture.agentId);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.source).toBe('studio_trader_dna');
    expect(ideas[0]!.summary).not.toContain(EVM_WALLET);
    expect(ideas[0]!.detail).toMatch(/Do not name, quote or describe any wallet address/);

    // Asked again at once, and after the pause: nothing more is added.
    const calls = request.mock.calls.length;
    expect((await proposeTraderDnaPost(fixture.agentId)).proposed).toBe(false);
    expect(request).toHaveBeenCalledTimes(calls);
    // Hours later Studio is asked again; its answer is stamped then, and it is the same study.
    const later = new Date(Date.now() + 8 * 3_600_000);
    const published = (await ops.getSetting(`studio.trader_dna.proposed.${fixture.agentId}`)) as { proposedKey: string };
    const publishedAt = published.proposedKey.split('@')[1]!;
    request.mockImplementation(async () => answer(studyFixture({ published_at: publishedAt, generated_at: later.toISOString() })));
    expect((await proposeTraderDnaPost(fixture.agentId, later)).why).toMatch(/already proposed/);
    expect(await contentRepo.listIdeas(fixture.agentId)).toHaveLength(1);
    expect(request.mock.calls.length).toBe(calls + 1);
  });

  it('proposes nothing for an unpublished id, a study with no sample, or an unreachable Studio', async () => {
    const cases: Array<() => ReturnType<typeof answer> | { ok: false; why: string }> = [
      () => answer({ error: 'not_found' }, 404),
      () => answer(studyFixture({ sample: { wallets: 0, trades: 0 } })),
      () => answer(studyFixture({ evidence_level: 'RECONSTRUCTED', behaviours: [] })),
      () => ({ ok: false, why: 'Studio could not be reached: down' }),
    ];
    for (const respond of cases) {
      const fixture = await ready(on);
      request.mockImplementation(async () => respond());
      expect((await proposeTraderDnaPost(fixture.agentId)).proposed).toBe(false);
      expect(await contentRepo.listIdeas(fixture.agentId)).toHaveLength(0);
    }
  });

  it('is taken up by the posting engine, and the send check holds a post that makes no claim about being a study', async () => {
    const fixture = await ready(on);
    await agentsRepo.updateAgent(fixture.agentId, { state: 'ACTIVE' });
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'mock',
      handle: `poster_${Date.now().toString(36).slice(-6)}`,
      displayName: 'Poster',
    });
    await accountsRepo.linkAgentAccount({
      agentId: fixture.agentId,
      accountId: account.id,
      triggerEventTypes: ['MENTION'],
      actionType: 'POST',
      enabled: true,
    });
    const outcome = await originatePost({ agentId: fixture.agentId, accountId: account.id, dryRun: true });
    expect(outcome.jobId).not.toBeNull();
    expect((await jobsRepo.requireJob(outcome.jobId!)).dryRun).toBe(true);
    await drainAgentJobs(fixture.agentId);
    const after = await jobsRepo.requireJob(outcome.jobId!);
    // The mock model's text does not mention a study, Studio or that nothing was
    // traded, so the check on the finished text sends it to the owner.
    expect(after.status).toBe('REVIEW_REQUIRED');
    expect(after.lastError).toMatch(/needs the owner: It does not say this is a study/);
    expect((await contentRepo.listIdeas(fixture.agentId)).map((i) => i.source)).toEqual(['studio_trader_dna']);
    expect(await ops.getSetting(`studio.trader_dna.proposed.${fixture.agentId}`)).toMatchObject({ proposedKey: expect.stringMatching(/^early-entry-study@/) });
  });
});
