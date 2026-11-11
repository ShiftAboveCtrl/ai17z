import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  CHANNELS,
  APPROVAL_MODES,
  PIPELINE_NODE_KINDS,
  PROVIDER_KINDS,
  TELEGRAM_OUTBOX_STATES,
  TRACE_EVENT_TYPES,
  TRADE_INTENT_STATUSES,
  TRADE_MODES,
  TRADE_PAUSE_SCOPES,
  TRADE_SIDES,
  SHADOW_OUTCOMES,
  AssetRef,
} from '@xbam/shared/contracts';
import {
  BROWSER_TASK_KINDS,
  accounts as accountsRepo,
  browserTasks,
  knowledge,
  observability,
  ops,
  pipelines,
  providers,
  query,
  trading,
  tradeShadows,
  users,
} from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

describe('every channel the contract names is accepted by the database', () => {
  it('creates each channel and refuses an unknown channel', async () => {
    const fixture = await createFixture();
    for (const channel of CHANNELS) {
      const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel, handle: uniqueSuffix() });
      expect(account.channel).toBe(channel);
    }
    await expect(accountsRepo.createAccount({ ownerId: fixture.ownerId,
      channel: 'not_a_channel' as never, handle: uniqueSuffix() })).rejects.toThrow();
  });
});

/**
 * The enum and the CHECK constraint have to agree.
 *
 * They did not: migration 0020 added seven account states and taught the code to
 * write them while the constraint still listed the old five. Every sign-in died
 * at the database with a constraint error, and no test noticed because the unit
 * tests never touched Postgres and the integration tests only wrote old values.
 */
describe('every account status the code can produce is one the database accepts', () => {
  it('writes each status in the contract without violating the constraint', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `status_${uniqueSuffix()}`,
    });

    for (const status of ACCOUNT_STATUSES) {
      const updated = await accountsRepo.updateAccount(account.id, { status });
      expect(updated.status).toBe(status);
    }
  });

  it('still refuses a status that is not in the contract', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `status_${uniqueSuffix()}`,
    });

    await expect(
      accountsRepo.updateAccount(account.id, { status: 'DEFINITELY_NOT_A_STATUS' as never }),
    ).rejects.toThrow();
  });
});

describe('every channel the code can name is one the database accepts', () => {
  /*
    `accounts.channel` is the only column with a CHECK on the channel name, and
    it was last written when X was the second channel. Adding 'bluesky' to the
    contract without widening it would fail at the database on the first link,
    and no unit test would have noticed.
  */
  it('writes each channel in the contract', async () => {
    const fixture = await createFixture();
    for (const channel of CHANNELS) {
      const account = await accountsRepo.createAccount({
        ownerId: fixture.ownerId,
        channel,
        handle: `channel_${channel}_${uniqueSuffix()}`,
      });
      expect(account.channel).toBe(channel);
    }
  });

  it('still refuses a channel that is not in the contract', async () => {
    const fixture = await createFixture();
    await expect(
      accountsRepo.createAccount({
        ownerId: fixture.ownerId,
        channel: 'definitely_not_a_channel' as never,
        handle: `channel_${uniqueSuffix()}`,
      }),
    ).rejects.toThrow();
  });
});

describe('every trace type the code can emit is one the database accepts', () => {
  it('writes each type in the contract', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('trace constraint check'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    for (const type of TRACE_EVENT_TYPES) {
      await observability.emitTrace({ jobId, agentId: fixture.agentId, type, message: type });
    }
    const trace = await observability.listTrace(jobId);
    for (const type of TRACE_EVENT_TYPES) {
      expect(trace.map((t) => t.type)).toContain(type);
    }
    expect(trace.some(t => t.type === 'POST_MEDIA_DECIDED')).toBe(true);
  });
});

describe('every pipeline node kind the code can produce is one the database accepts', () => {
  it('saves a pipeline containing every node kind', async () => {
    const fixture = await createFixture();

    // A trigger and an end are structurally required; the rest hang off the
    // trigger so the graph stays valid while covering every kind.
    const nodes = PIPELINE_NODE_KINDS.map((kind, index) => ({
      key: `n${index}`,
      kind,
      label: kind,
      config: {},
      x: 0,
      y: index,
    }));

    const saved = await pipelines.savePipelineVersion(
      fixture.agentId,
      { name: 'every kind', nodes, edges: [], changeNote: 'constraint coverage' },
      null,
    );
    expect(saved.nodes.map((n) => n.kind).sort()).toEqual([...PIPELINE_NODE_KINDS].sort());
  });
});

/**
 * Provider kinds have a CHECK too, and this file did not cover them.
 *
 * The same trap the account statuses fell into: adding a provider to the
 * contract and forgetting the constraint passes every unit test and fails at
 * the database the first time somebody saves a key for it, which is the worst
 * possible moment to find out.
 */
describe('every provider kind the code offers is one the database accepts', () => {
  it('saves a credential for each kind in the contract', async () => {
    const owner = await users.createOwner({
      email: `providers-${uniqueSuffix()}@example.test`,
      password: 'test-password-1234',
      displayName: 'Provider owner',
    });

    for (const kind of PROVIDER_KINDS) {
      const created = await providers.createProvider({
        ownerId: owner.id,
        provider: kind,
        label: `${kind}-${uniqueSuffix()}`,
        availableModels: [],
        defaultModel: null,
      });
      expect(created.provider, `the database refused the ${kind} provider`).toBe(kind);
    }
  });

  it('still refuses a provider that is not in the contract', async () => {
    const owner = await users.createOwner({
      email: `providers-${uniqueSuffix()}@example.test`,
      password: 'test-password-1234',
      displayName: 'Provider owner',
    });
    await expect(
      providers.createProvider({
        ownerId: owner.id,
        provider: 'not_a_provider' as never,
        label: 'nope',
        availableModels: [],
        defaultModel: null,
      }),
    ).rejects.toThrow();
  });
});

/**
 * A fifth enum with a CHECK behind it, added when websites became a source.
 *
 * The same trap as the other four: growing the list in TypeScript passes every
 * unit test and fails at the database, in production, on the one path nobody
 * exercised.
 */
describe('every knowledge source kind the code can create is one the database accepts', () => {
  const KINDS = ['UPLOAD', 'PATH', 'TEXT', 'URL'] as const;

  it('accepts all of them', async () => {
    const fixture = await createFixture();
    for (const kind of KINDS) {
      const source = await knowledge.createSource({
        agentId: fixture.agentId,
        name: `${kind}-${uniqueSuffix()}`,
        kind,
        location: kind === 'URL' ? 'https://example.com/docs' : '/tmp/docs',
      });
      expect(source.kind, `the database refused a ${kind} source`).toBe(kind);
    }
  });

  it('still refuses a kind that is not in the contract', async () => {
    const fixture = await createFixture();
    await expect(
      knowledge.createSource({
        agentId: fixture.agentId,
        name: `bogus-${uniqueSuffix()}`,
        kind: 'CRAWL' as never,
        location: 'https://example.com',
      }),
    ).rejects.toThrow();
  });

  it('refuses a refresh interval too short to be a schedule', async () => {
    // Fifteen minutes is the floor. Anything under it is a poller wearing a
    // knowledge source's clothes.
    const fixture = await createFixture();
    await expect(
      knowledge.createSource({
        agentId: fixture.agentId,
        name: `fast-${uniqueSuffix()}`,
        kind: 'URL',
        location: 'https://example.com/docs',
        refreshIntervalMinutes: 1,
      }),
    ).rejects.toThrow();
  });
});


/**
 * Browser task kinds have a CHECK too, and this file did not cover them.
 *
 * The constraint has been widened three times -- 0014 for PREFLIGHT, 0021 for
 * CANCEL_AUTH, 0043 for SHUTDOWN_BROWSER -- each time by hand, each time
 * alongside a TypeScript union that nothing checked it against. Adding
 * CREDENTIAL_SIGN_IN was the fourth, so the list is a value now and this asks
 * the database about every entry in it.
 */
describe('every browser task kind the code can record is one the database accepts', () => {
  it('queues one of each kind', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `tasks_${uniqueSuffix()}`,
    });

    for (const kind of BROWSER_TASK_KINDS) {
      // PREFLIGHT belongs to the machine rather than to an account, and each
      // task is settled before the next so the one-active-task index -- which
      // is a different guarantee -- does not get in the way of this one.
      const task = await browserTasks.enqueueBrowserTask({
        accountId: kind === 'PREFLIGHT' ? null : account.id,
        kind,
        requestedBy: fixture.ownerId,
      });
      expect(task.kind, `the database refused a ${kind} task`).toBe(kind);
      await browserTasks.finishBrowserTask(task.id, 'COMPLETED', null);
    }
  });

  it('still refuses a kind that is not in the list', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({
      ownerId: fixture.ownerId,
      channel: 'x',
      handle: `tasks_${uniqueSuffix()}`,
    });
    await expect(
      browserTasks.enqueueBrowserTask({
        accountId: account.id,
        kind: 'TYPE_A_PASSWORD_SOMEWHERE_ELSE' as never,
        requestedBy: fixture.ownerId,
      }),
    ).rejects.toThrow();
  });
});

/**
 * The trading enums and their CHECK constraints have to agree.
 *
 * Five of them arrived with migration 0104: a mandate's mode and approval, an
 * intent's mode, side and status, and a pause scope. Each is a CHECK, so
 * growing one in the contract without widening the constraint fails at the
 * database and passes every unit test, which is the failure this file exists
 * for.
 */
describe('every trading value the code can produce is one the database accepts', () => {
  const token = {
    kind: 'ONCHAIN' as const,
    network: 'robinhood' as const,
    address: '0x00000000000000000000000000000000000000aa',
    decimals: 18,
  };
  const quote = {
    venue: 'PONS_V2_CURVE' as const,
    network: 'robinhood' as const,
    asset: token,
    quoteAsset: { kind: 'NATIVE' as const, network: 'robinhood' as const },
    atBlock: '1',
    observedAt: new Date().toISOString(),
    priceBaseUnits: '1',
    liquidityBase: '1',
    feeMicroBps: 0,
    phase: 'CURVE' as const,
    source: 'constraint-test',
  };

  const mandateFor = (agentId: string, mode: string, approval: string) => ({
    agentId,
    ownerId: null,
    mandate: {
      mode,
      approval,
      venues: ['PONS_V2_CURVE'],
      networks: ['robinhood'],
      allowedAssets: [token],
      maxPerTrade: '1',
      maxPerDay: '1',
      maxOpenExposure: '1',
      maxOpenPositions: 1,
      maxSlippageBps: 1,
      maxPriceImpactBps: 1,
      minLiquidityBase: '1',
      maxFeeBase: '1',
      quoteMaxAgeMs: 1000,
      expiresAt: null,
      paused: false,
    },
  }) as never;

  it('writes every mandate mode and approval mode', async () => {
    const fixture = await createFixture();
    for (const mode of TRADE_MODES) {
      for (const approval of APPROVAL_MODES) {
        const row = await trading.putMandate(mandateFor(fixture.agentId, mode, approval));
        expect(row.mode).toBe(mode);
        expect(row.approval).toBe(approval);
      }
    }
  });

  it('writes every intent status and both sides', async () => {
    const fixture = await createFixture();
    const mandate = await trading.putMandate(mandateFor(fixture.agentId, 'LIVE', 'OWNER_APPROVES_EACH'));
    let n = 0;
    for (const status of TRADE_INTENT_STATUSES) {
      for (const side of ['BUY', 'SELL'] as const) {
        const { row } = await trading.createIntent({
          agentId: fixture.agentId,
          mandateId: mandate.id,
          walletId: null,
          mode: 'LIVE',
          venue: 'PONS_V2_CURVE',
          network: 'robinhood',
          side,
          assetIn: side === 'BUY' ? { kind: 'NATIVE', network: 'robinhood' } : token,
          assetOut: side === 'BUY' ? token : { kind: 'NATIVE', network: 'robinhood' },
          maxIn: '1',
          minOut: '1',
          maxSlippageBps: 1,
          maxPriceImpactBps: 1,
          maxFeeBase: '1',
          quote,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: `constraint-${fixture.agentId}-${n += 1}`,
        });
        // Straight to the status under test: this is about the constraint
        // accepting the value, not about the lifecycle being walked.
        const moved = await trading.transitionIntent(row.id, 'DRAFTED', status);
        expect(moved?.status, status).toBe(status);
      }
    }
  });

  it('writes every pause scope', async () => {
    const fixture = await createFixture();
    for (const scope of TRADE_PAUSE_SCOPES) {
      const row = await trading.pauseTrading({
        scope,
        target: scope === 'GLOBAL' ? null : `${scope}-${fixture.agentId}`,
        reason: 'constraint test',
        createdBy: null,
      });
      expect(row.scope).toBe(scope);
      await trading.liftPause(row.id, null);
    }
  });

  it('still refuses values that are not in the contract', async () => {
    const fixture = await createFixture();
    await expect(trading.putMandate(mandateFor(fixture.agentId, 'WHATEVER_I_LIKE', 'OWNER_APPROVES_EACH'))).rejects.toThrow();
    await expect(
      trading.pauseTrading({ scope: 'EVERYTHING' as never, target: null, reason: 'no', createdBy: null }),
    ).rejects.toThrow();
  });

  it('writes every shadow side and outcome the contract names', async () => {
    const fixture = await createFixture();
    const draft = {
      agentId: fixture.agentId,
      ownerId: fixture.ownerId,
      venue: 'PONS_V2_CURVE' as const,
      assetIn: AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' }),
      assetOut: AssetRef.parse({
        kind: 'ONCHAIN',
        network: 'robinhood',
        address: '0x00000000000000000000000000000000000000aa',
        decimals: 18,
      }),
      subject: AssetRef.parse({
        kind: 'ONCHAIN',
        network: 'robinhood',
        address: '0x00000000000000000000000000000000000000aa',
        decimals: 18,
      }),
      maxIn: '1',
      maxSlippageBps: 1,
      maxPriceImpactBps: 1,
      maxFeeBase: '1',
      intervalSeconds: 300,
    };
    for (const side of TRADE_SIDES) {
      const row = await tradeShadows.putShadow({ ...draft, label: `side ${side}`, side });
      expect(row.side).toBe(side);
      for (const outcome of SHADOW_OUTCOMES) {
        expect((await tradeShadows.noteRun(row.id, outcome, 'constraint test'))!.lastOutcome).toBe(outcome);
      }
      await expect(tradeShadows.noteRun(row.id, 'NEITHER' as never, null)).rejects.toThrow();
    }
    await expect(tradeShadows.putShadow({ ...draft, label: 'sideways', side: 'SIDEWAYS' as never })).rejects.toThrow();
  });
});

/**
 * Telegram as an agent channel.
 *
 * `accounts.channel` has admitted 'telegram' since migration 0004, long before
 * any adapter, so nothing was widened for it; this holds that to the contract
 * rather than to a memory of it. The one new constrained column is the state of
 * an outgoing send, and it is the thing that stops a reply being sent twice.
 */
describe('every value the Telegram channel can write is one the database accepts', () => {
  it('creates an account on every channel the contract names, Telegram included', async () => {
    expect(CHANNELS).toContain('telegram');
    const fixture = await createFixture();
    for (const channel of CHANNELS) {
      const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel, handle: uniqueSuffix() });
      expect(account.channel, `the database refused a ${channel} account`).toBe(channel);
    }
  });

  it('writes each send state and refuses one that is not in the contract', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'telegram', handle: uniqueSuffix() });
    for (const state of TELEGRAM_OUTBOX_STATES) {
      await query(
        `INSERT INTO telegram_outbox (account_id, idempotency_key, request_digest, state, chat_id, remote_message_id)
         VALUES ($1, $2, 'digest', $3, '-1001234567890', 'telegram:-1001234567890:5')`,
        [account.id, `key-${state}`, state],
      );
    }
    await expect(
      query(
        `INSERT INTO telegram_outbox (account_id, idempotency_key, request_digest, state, chat_id)
         VALUES ($1, 'key-bogus', 'digest', 'DELIVERED', '-1001234567890')`,
        [account.id],
      ),
    ).rejects.toThrow();
  });

  it('will not call a send SENT without the message it produced', async () => {
    const fixture = await createFixture();
    const account = await accountsRepo.createAccount({ ownerId: fixture.ownerId, channel: 'telegram', handle: uniqueSuffix() });
    await expect(
      query(
        `INSERT INTO telegram_outbox (account_id, idempotency_key, request_digest, state, chat_id)
         VALUES ($1, 'key', 'digest', 'SENT', '-1001234567890')`,
        [account.id],
      ),
    ).rejects.toThrow();
  });
});

/**
 * Migration 0129 added POST_MEDIA, the kind of a file that goes out with a post.
 * The registry test proves the column and the declared list agree; this writes
 * a real row, because a kind the code can produce and the column refuses fails
 * on the path that writes the first attachment, which nothing else exercises.
 */
describe('every artifact kind the code can write is one the database accepts', () => {
  it('writes POST_MEDIA, and still refuses a kind that is not declared', async () => {
    const fixture = await createFixture();
    for (const kind of ['SCREENSHOT', 'PORTRAIT', 'UPLOAD', 'EXPORT', 'HTML_SNAPSHOT', 'POST_MEDIA'] as const) {
      const row = await ops.createArtifact({ kind, agentId: fixture.agentId, mimeType: 'image/png', relPath: `kinds/${kind}.png`, bytes: 1 });
      expect(row.kind).toBe(kind);
    }
    await expect(
      ops.createArtifact({ kind: 'NOT_A_KIND' as never, agentId: fixture.agentId, mimeType: 'image/png', relPath: 'kinds/x.png', bytes: 1 }),
    ).rejects.toThrow();
  });
});
