import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts as accountsRepo, agents as agentsRepo, content as contentRepo, jobs as jobsRepo, ops } from '@xbam/database';
import {
  UNSAFE_DEV_ORIGIN_ENV,
  beginStudioLink,
  disconnectStudio,
  originatePost,
  pollStudioLink,
  proposePaperRecordPost,
  registerStudioPaperCapabilities,
  setCapabilityPermission,
  studioPaperRecord,
} from '@xbam/runtime';
import { DEFAULT_POLICY, PolicyConfig } from '@xbam/shared/contracts';
import { getCapability, invokeCapability, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';
import { startPaperStudio, tradedRecord, type PaperStudio } from '../support/paperStudioServer';

installHarness();

/**
 * The paper record read, against a server that implements
 * `docs/architecture/STUDIO_PAPER_RECORD.md` and verifies DPoP for real.
 */

let studio: PaperStudio;
let previousOrigin: string | undefined;

beforeAll(async () => {
  studio = await startPaperStudio();
  previousOrigin = process.env[UNSAFE_DEV_ORIGIN_ENV];
  process.env[UNSAFE_DEV_ORIGIN_ENV] = studio.url;
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  registerStudioPaperCapabilities();
});

afterAll(async () => {
  if (previousOrigin === undefined) delete process.env[UNSAFE_DEV_ORIGIN_ENV];
  else process.env[UNSAFE_DEV_ORIGIN_ENV] = previousOrigin;
  await studio.close();
});

beforeEach(() => {
  studio.paperRequests.length = 0;
  studio.respond = (window, origin) => ({ body: tradedRecord(window, origin) });
});

async function link(): Promise<void> {
  // Several fixtures in one test share the one link.
  if ((await pollStudioLink()).state === 'LINKED') return;
  const started = await beginStudioLink({ replacePrevious: false });
  if (!started.ok) throw new Error(started.why);
  const done = await pollStudioLink();
  expect(done.state).toBe('LINKED');
}

const ask = (agentId: string, input: Record<string, unknown> = {}, audience: 'OWNER' | 'PUBLIC' = 'OWNER') =>
  invokeCapability({
    call: { id: 'studio.paper_record', input },
    context: { agentId, jobId: null, accountId: null, config: {}, audience, logger: console as never },
    permission: { stored: 'ALLOWED', paused: false },
  });

describe('the read', () => {
  it('goes to the linked origin with a DPoP proof for that exact request, and never a bearer secret', async () => {
    await link();
    const read = await studioPaperRecord('30d');
    expect(read.ok).toBe(true);
    expect(studio.paperRequests).toHaveLength(1);
    expect(studio.paperRequests[0]).toMatchObject({ scheme: 'dpop', proofValid: true, why: null });
    expect(studio.paperRequests[0]!.path).toBe('/api/v1/installation/paper-record?window=30d');
    if (read.ok) expect(read.record.simulated).toBe(true);
  });

  it('keeps no copy: a second question asks again, and an unreachable Studio is not answered from the first', async () => {
    await link();
    expect((await studioPaperRecord('30d')).ok).toBe(true);
    expect((await studioPaperRecord('30d')).ok).toBe(true);
    expect(studio.paperRequests).toHaveLength(2);

    studio.respond = () => ({ status: 503, body: { error: 'unavailable' } });
    const down = await studioPaperRecord('30d');
    expect(down.ok).toBe(false);
  });

  it('refuses a record that carries a field Studio was never meant to publish', async () => {
    await link();
    for (const extra of [{ account_email: 'someone@example.invalid' }, { linked_wallets: ['0xabc'] }, { live_balance_usd: '1000' }, { prompt: 'be bold' }]) {
      studio.respond = (window, origin) => ({ body: tradedRecord(window, origin, extra) });
      const read = await studioPaperRecord('30d');
      expect(read.ok, JSON.stringify(extra)).toBe(false);
    }
    // And one nested inside an allowed object.
    studio.respond = (window, origin) => ({
      body: tradedRecord(window, origin, { totals: { ...(tradedRecord(window, origin).totals as object), live_balance_usd: '5' } }),
    });
    expect((await studioPaperRecord('30d')).ok).toBe(false);
  });

  it('refuses a record that does not say it is simulated, a link off Studio, a stale record and the wrong window', async () => {
    await link();
    studio.respond = (window, origin) => ({ body: tradedRecord(window, origin, { simulated: false }) });
    expect((await studioPaperRecord('30d')).ok).toBe(false);

    studio.respond = (window) => ({
      body: tradedRecord(window, 'https://elsewhere.example.invalid'),
    });
    const off = await studioPaperRecord('30d');
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.why).toMatch(/not on Studio/);

    studio.respond = (window, origin) => ({
      body: tradedRecord(window, origin, { generated_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    });
    const stale = await studioPaperRecord('30d');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.why).toMatch(/not current/);

    studio.respond = (_window, origin) => ({ body: tradedRecord('7d', origin) });
    expect((await studioPaperRecord('30d')).ok).toBe(false);
  });

  it('says so when Studio does not publish a record at all, and when it is not linked', async () => {
    const unlinked = await studioPaperRecord('30d');
    expect(unlinked.ok).toBe(false);
    expect(studio.paperRequests).toHaveLength(0);

    await link();
    studio.respond = () => ({ status: 404, body: { error: 'not_found' } });
    const none = await studioPaperRecord('30d');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.why).toMatch(/does not publish a paper track record/);

    await disconnectStudio();
  });
});

describe('the capability', () => {
  it('is refused to a stranger and outside owner chat, and off until the owner enables it', async () => {
    const fixture = await createFixture();
    await link();

    const publicAsk = await ask(fixture.agentId, {}, 'PUBLIC');
    expect(publicAsk.outcome).toBe('REFUSED');
    expect(publicAsk.detail).toMatch(/only for a conversation with this agent's owner/);

    const capability = getCapability('studio.paper_record')!;
    expect(capability.unsetPermission).toBe('DISABLED');
    const unset = await invokeCapability({
      call: { id: 'studio.paper_record', input: {} },
      context: { agentId: fixture.agentId, jobId: null, accountId: null, config: {}, audience: 'OWNER', logger: console as never },
      permission: { stored: null, paused: false },
    });
    expect(unset.outcome).toBe('REFUSED');
    expect(studio.paperRequests).toHaveLength(0);
  });

  it('is UNAVAILABLE with a sentence when the installation is not linked, and makes no request', async () => {
    const fixture = await createFixture();
    const result = await ask(fixture.agentId);
    expect(result.outcome).toBe('REFUSED');
    expect(result.detail).toMatch(/not linked/i);
    expect(studio.paperRequests).toHaveLength(0);
  });

  it('says a loss is a loss, attributes it to Studio, and says simulated and paper', async () => {
    const fixture = await createFixture();
    await link();
    const result = await ask(fixture.agentId, { window: '30d' });
    expect(result.outcome).toBe('SUCCEEDED');
    const out = result.output as { state: string; outcome: string; source: string; simulated: boolean; statement: string; decisions: Array<{ url: string }> };
    expect(out).toMatchObject({ state: 'TRADED', outcome: 'LOSS', source: 'AI17Z Studio', simulated: true });
    expect(out.statement).toMatch(/According to Studio/);
    expect(out.statement).toMatch(/simulated/);
    expect(out.statement).toMatch(/paper/);
    expect(out.statement).toMatch(/net loss of 42\.50 USD/);
    expect(out.statement).toMatch(/30 bps in fees and 50 bps of slippage/);
    expect(out.statement).toMatch(/marked to market/);
    expect(out.statement).not.toMatch(/gain/);
    expect(out.decisions[0]!.url.startsWith(studio.url)).toBe(true);
  });

  it('has honest states for no trades and for a missing window, never a fabricated win', async () => {
    const fixture = await createFixture();
    await link();

    studio.respond = (window, origin) => ({
      body: tradedRecord(window, origin, {
        state: 'NO_TRADES',
        totals: { trades: 0, closed_trades: 0, winning_trades: 0, losing_trades: 0, net_pnl_usd: '0', return_pct: null, max_drawdown_pct: null },
        open_positions: { count: 0, treatment: 'EXCLUDED', note: 'Nothing was open.' },
        decisions: [],
      }),
    });
    const none = (await ask(fixture.agentId)).output as { state: string; outcome: string | null; statement: string };
    expect(none.state).toBe('NO_TRADES');
    expect(none.outcome).toBeNull();
    expect(none.statement).toMatch(/made no trades/);
    expect(none.statement).toMatch(/simulated paper/);
    expect(none.statement).not.toMatch(/gain|loss|\bwin(s|ning)?\b/i);

    studio.respond = (window, origin) => ({
      body: tradedRecord(window, origin, {
        state: 'MISSING',
        reason: 'No paper agent was running in that window',
        window: { ...(tradedRecord(window, origin).window as object), complete: false },
        totals: null,
        costs: null,
        open_positions: null,
        decisions: [],
      }),
    });
    const missing = (await ask(fixture.agentId)).output as { state: string; outcome: string | null; statement: string };
    expect(missing.state).toBe('MISSING');
    expect(missing.outcome).toBeNull();
    expect(missing.statement).toMatch(/no simulated paper record/);
    expect(missing.statement).toMatch(/will not guess/);
    expect(missing.statement).not.toMatch(/gain|loss|\bwin(s|ning)?\b/i);
  });

  it('returns UNAVAILABLE and says it cannot check when Studio is unreachable, with nothing from before', async () => {
    const fixture = await createFixture();
    await link();
    expect(((await ask(fixture.agentId)).output as { state: string }).state).toBe('TRADED');

    studio.respond = () => ({ status: 500, body: { error: 'server_error' } });
    const down = (await ask(fixture.agentId)).output as { state: string; outcome: string | null; window: unknown; statement: string; decisions: unknown[] };
    expect(down.state).toBe('UNAVAILABLE');
    expect(down.outcome).toBeNull();
    expect(down.window).toBeNull();
    expect(down.decisions).toEqual([]);
    expect(down.statement).toMatch(/cannot check/);
    expect(down.statement).not.toMatch(/42\.50|loss|gain/);
  });
});

describe('posting the record', () => {
  const on = (extra: Record<string, unknown> = {}) =>
    PolicyConfig.parse({ ...DEFAULT_POLICY, studio: { ...DEFAULT_POLICY.studio, postPaperRecord: true, ...extra } });

  async function ready(policyStudio: Record<string, unknown> | null) {
    const fixture = await createFixture(policyStudio ? { policy: { studio: on(policyStudio).studio } } : {});
    await link();
    await setCapabilityPermission({ agentId: fixture.agentId, capabilityId: 'studio.paper_record', permission: 'ALLOWED' });
    return fixture;
  }

  it('is off by default: nothing is asked of Studio and nothing is proposed', async () => {
    expect(DEFAULT_POLICY.studio).toEqual({ postPaperRecord: false, postPaperPnl: false, paperRecordWindow: '7d', postTraderDna: false, traderDnaStudyId: null });
    const fixture = await ready(null);
    const outcome = await proposePaperRecordPost(fixture.agentId);
    expect(outcome.proposed).toBe(false);
    expect(studio.paperRequests).toHaveLength(0);
    expect(await contentRepo.listIdeas(fixture.agentId)).toHaveLength(0);
  });

  it('needs the capability to be on for this agent as well', async () => {
    const fixture = await createFixture({ policy: { studio: on().studio } });
    await link();
    const outcome = await proposePaperRecordPost(fixture.agentId);
    expect(outcome.proposed).toBe(false);
    expect(outcome.why).toMatch(/switched off/);
    expect(studio.paperRequests).toHaveLength(0);
  });

  it('adds one idea for a finished window, once, and without any money outcome unless PnL is allowed', async () => {
    const fixture = await ready({});
    const first = await proposePaperRecordPost(fixture.agentId);
    expect(first).toMatchObject({ proposed: true });

    const ideas = await contentRepo.listIdeas(fixture.agentId);
    expect(ideas).toHaveLength(1);
    const idea = ideas[0]!;
    expect(idea.source).toBe('studio_paper_record');
    expect(idea.summary).toMatch(/simulated paper record/);
    expect(idea.summary).toMatch(/12 paper trades/);
    expect(idea.summary).not.toMatch(/gain|loss|\bwin(s|ning)?\b|lost|\bwon\b|%|\$|42\.5/i);
    expect(idea.detail).toMatch(/simulated paper trading/);
    expect(idea.detail).toMatch(/No money moved and no position is live/);

    // Asked again at once: Studio is not asked, and nothing is duplicated.
    const requests = studio.paperRequests.length;
    expect((await proposePaperRecordPost(fixture.agentId)).proposed).toBe(false);
    expect(studio.paperRequests).toHaveLength(requests);
    expect(await contentRepo.listIdeas(fixture.agentId)).toHaveLength(1);

    // Hours later a rolling window ends somewhere new, but it is the same
    // seven days: one proposal per period, not one per reading.
    const later = await proposePaperRecordPost(fixture.agentId, new Date(Date.now() + 8 * 3_600_000));
    expect(later).toMatchObject({ proposed: false, why: expect.stringMatching(/already proposed/) });
    expect(studio.paperRequests).toHaveLength(requests);

    // A period later Studio is asked again.
    await proposePaperRecordPost(fixture.agentId, new Date(Date.now() + 8 * 86_400_000));
    expect(studio.paperRequests.length).toBeGreaterThan(requests);
  });

  it('states a loss as plainly as a gain when the owner allowed PnL', async () => {
    const fixture = await ready({ postPaperPnl: true });
    expect((await proposePaperRecordPost(fixture.agentId)).proposed).toBe(true);
    const idea = (await contentRepo.listIdeas(fixture.agentId))[0]!;
    expect(idea.summary).toMatch(/Net simulated loss: 42\.50 USD, 6 winning and 4 losing of 10 closed/);
    expect(idea.detail).toMatch(/A loss is stated as plainly as a gain/);
  });

  it('proposes nothing for a window still running, a window with no trades, a missing window, or an unreachable Studio', async () => {
    const cases: Array<(window: string, origin: string) => { status?: number; body: unknown }> = [
      (window, origin) => ({ body: tradedRecord(window, origin, { window: { ...(tradedRecord(window, origin).window as object), complete: false } }) }),
      (window, origin) => ({
        body: tradedRecord(window, origin, {
          state: 'NO_TRADES',
          totals: { trades: 0, closed_trades: 0, winning_trades: 0, losing_trades: 0, net_pnl_usd: '0', return_pct: null, max_drawdown_pct: null },
          decisions: [],
        }),
      }),
      (window, origin) => ({
        body: tradedRecord(window, origin, { state: 'MISSING', reason: 'No paper agent.', totals: null, costs: null, open_positions: null, decisions: [] }),
      }),
      () => ({ status: 502, body: { error: 'bad_gateway' } }),
    ];
    for (const respond of cases) {
      const fixture = await ready({});
      studio.respond = respond;
      expect((await proposePaperRecordPost(fixture.agentId)).proposed).toBe(false);
      expect(await contentRepo.listIdeas(fixture.agentId)).toHaveLength(0);
    }
  });

  it('is taken up by the posting engine, which carries the source into the job so the send check can find it', async () => {
    const fixture = await ready({});
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
    expect(outcome.reason).toMatch(/^Posting:/);
    expect(outcome.jobId).not.toBeNull();
    const job = await jobsRepo.requireJob(outcome.jobId!);
    expect(job.dryRun).toBe(true);
    await drainAgentJobs(fixture.agentId);
    const after = await jobsRepo.requireJob(outcome.jobId!);
    // End to end: the mock model's text does not say simulated, paper or Studio,
    // so the check on the finished text sends this post to the owner. Nothing
    // went out, and the reason is a sentence.
    expect(after.status).toBe('REVIEW_REQUIRED');
    expect(after.lastError).toMatch(/needs the owner: It does not say the trading was simulated/);
    const policy = await agentsRepo.getActivePolicy(fixture.agentId);
    expect(policy?.config.studio.postPaperRecord).toBe(true);
    // A rehearsal does not spend the idea.
    const ideas = await contentRepo.listIdeas(fixture.agentId);
    expect(ideas.map((i) => i.source)).toEqual(['studio_paper_record']);
    expect(await ops.getSetting(`studio.paper_record.proposed.${fixture.agentId}`)).toMatchObject({ windowEnd: expect.any(String) });
  });
});
