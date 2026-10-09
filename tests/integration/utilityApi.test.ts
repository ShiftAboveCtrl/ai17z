import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { agents as agentsRepo, trading, users as usersRepo } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * The shared utility surface, over HTTP.
 *
 * This endpoint is reachable by anything that can make a request, so what is
 * proved here is the boundary rather than the arithmetic: that an unsigned
 * request gets nothing, that a signed one reaches canonical core, that two
 * callers cannot see each other's journals, and that no request shape reaches a
 * live trade.
 *
 * The paper engine, the risk gate and the market reader all have their own
 * tests. What they cannot prove is that the route in front of them is wired to
 * them at all.
 */

const SECRET = 'integration-utility-secret-not-a-real-one';
let app: FastifyInstance;

beforeAll(async () => {
  process.env.AI17Z_UTILITY_SIGNING_SECRET = SECRET;
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  delete process.env.AI17Z_UTILITY_SIGNING_SECRET;
  await app?.close();
});

/** A signed call, exactly as Studio's gateway makes one. */
async function invoke(body: Record<string, unknown>, options: { secret?: string; timestamp?: string } = {}) {
  const payload = JSON.stringify(body);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const secret = options.secret ?? SECRET;
  return app.inject({
    method: 'POST',
    url: '/api/utility/invoke',
    headers: {
      'content-type': 'application/json',
      'x-ai17z-timestamp': timestamp,
      'x-ai17z-signature': `v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`,
    },
    payload,
  });
}

const token = { kind: 'ONCHAIN' as const, network: 'ethereum' as const, address: `0x${'2'.repeat(40)}`, decimals: 18 };
const paperTrade = {
  venue: 'PONS_V2_CURVE',
  side: 'BUY',
  assetIn: { kind: 'NATIVE', network: 'ethereum' },
  assetOut: token,
  subject: token,
  maxIn: '1000000000000000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
  maxFeeBase: '5000000000000000',
};

describe('what this runtime says it offers', () => {
  it('lists its capabilities without a signature, and says whether it is configured', async () => {
    await createFixture();
    const response = await app.inject({ method: 'GET', url: '/api/utility/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json().data as { capabilities: { id: string }[]; refuses: string[]; configured: boolean };
    expect(body.capabilities.map((c) => c.id)).toContain('trading.paper_trade');
    expect(body.configured).toBe(true);
    // Reading the list must not require a key: an operator checking
    // configuration has no gateway secret to hand.
    expect(body.refuses.join(' ')).toMatch(/signs, sends, transfers or approves/i);
  });

  it('offers nothing that could move value', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/utility/capabilities' });
    for (const capability of (response.json().data as { capabilities: { id: string }[] }).capabilities) {
      expect(capability.id).not.toMatch(/sign|send|transfer|approve|live/i);
    }
  });
});

describe('an unsigned or wrongly signed request gets nothing', () => {
  it('refuses with no signature at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/utility/invoke',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ request_id: 'abcd1234', capability: 'trading.paper_trade', caller: 'caller-0001', input: paperTrade }),
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a signature from a different secret', async () => {
    const response = await invoke(
      { request_id: 'abcd1234', capability: 'trading.paper_trade', caller: 'caller-0001', input: paperTrade },
      { secret: 'not-the-shared-secret' },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    // The reason travels in the message, so a wrong key is distinguishable
    // from a stale clock without inventing a second set of codes.
    expect(response.json().error.message).toMatch(/BAD_SIGNATURE/);
  });

  it('refuses a replay from outside the clock window', async () => {
    const old = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString();
    const response = await invoke(
      { request_id: 'abcd1234', capability: 'trading.paper_trade', caller: 'caller-0001', input: paperTrade },
      { timestamp: old },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    expect(response.json().error.message).toMatch(/STALE/);
  });

  it('refuses a body that changed after signing', async () => {
    const signedBody = JSON.stringify({ request_id: 'abcd1234', capability: 'market.snapshot', caller: 'caller-0001', input: { subject: token, venue: 'PONS_V2_CURVE' } });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `v1=${createHmac('sha256', SECRET).update(`${timestamp}.${signedBody}`).digest('hex')}`;
    const response = await app.inject({
      method: 'POST',
      url: '/api/utility/invoke',
      headers: { 'content-type': 'application/json', 'x-ai17z-timestamp': timestamp, 'x-ai17z-signature': signature },
      // A different caller than the one that was signed for.
      payload: signedBody.replace('caller-0001', 'caller-9999'),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('a signed request reaches canonical core', () => {
  beforeEach(async () => {
    await createFixture();
  });

  it('refuses a capability this runtime does not offer', async () => {
    const response = await invoke({ request_id: 'abcd1234', capability: 'trading.live_trade', caller: 'caller-0001', input: {} });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(response.json().error.message).toMatch(/does not offer/);
  });

  it('refuses an input the schema does not accept, naming the field', async () => {
    const response = await invoke({
      request_id: 'abcd1234',
      capability: 'trading.paper_trade',
      caller: 'caller-0001',
      // A float amount, which is the mistake that loses base units.
      input: { ...paperTrade, maxIn: 1e18 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
    // Naming the field is the point: "invalid input" sends somebody hunting.
    expect(response.json().error.message).toMatch(/maxIn/);
  });

  it('refuses a request trying to smuggle a live mode past the envelope', async () => {
    const response = await invoke({
      request_id: 'abcd1234',
      capability: 'trading.paper_trade',
      caller: 'caller-0001',
      input: { ...paperTrade, mode: 'LIVE' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('runs a paper trade through core, creating the caller\'s own agent and mandate', async () => {
    const response = await invoke({ request_id: 'abcd1234', capability: 'trading.paper_trade', caller: 'caller-0001', input: paperTrade });
    expect(response.statusCode).toBe(200);
    const body = response.json().data as { simulated: boolean; outcome: { outcome: string; detail?: string } };

    // Every row of this says simulated, not just the envelope.
    expect(body.simulated).toBe(true);
    // No market reader is registered in this harness, so core refuses for want
    // of a market rather than inventing a price. That refusal *is* the proof
    // the call reached the engine: a route that had not would have thrown.
    expect(['FILLED', 'REFUSED', 'NO_MARKET']).toContain(body.outcome.outcome);

    // And the caller got a journal of its own, with a paper mandate.
    const owners = await usersRepo.listUsers();
    const agent = await agentsRepo.getAgentBySlug(owners[0]!.id, 'utility-caller-0001');
    expect(agent, 'the caller got no agent').not.toBeNull();
    const mandate = await trading.liveMandate(agent!.id);
    expect(mandate?.mode).toBe('PAPER');
    // The mandate it issues can never authorise an unattended live trade.
    expect(mandate?.approval).toBe('OWNER_APPROVES_EACH');
  });

  it('gives the same caller the same journal, and a different caller a different one', async () => {
    await invoke({ request_id: 'req-00000001', capability: 'trading.paper_trade', caller: 'caller-aaaa', input: paperTrade });
    await invoke({ request_id: 'req-00000002', capability: 'trading.paper_trade', caller: 'caller-aaaa', input: paperTrade });
    await invoke({ request_id: 'req-00000003', capability: 'trading.paper_trade', caller: 'caller-bbbb', input: paperTrade });

    const owners = await usersRepo.listUsers();
    const a = await agentsRepo.getAgentBySlug(owners[0]!.id, 'utility-caller-aaaa');
    const b = await agentsRepo.getAgentBySlug(owners[0]!.id, 'utility-caller-bbbb');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Two callers are two journals. This is the isolation a shared runtime
    // rests on, and it is per pseudonym rather than per owner.
    expect(a!.id).not.toBe(b!.id);
  });

  it('reads a caller\'s paper portfolio and nobody else\'s', async () => {
    await invoke({ request_id: 'req-00000010', capability: 'trading.paper_trade', caller: 'caller-cccc', input: paperTrade });
    const response = await invoke({ request_id: 'req-00000011', capability: 'trading.paper_portfolio', caller: 'caller-cccc', input: {} });
    expect(response.statusCode).toBe(200);
    const body = response.json().data as { simulated: boolean; portfolio: { trades: number; recent: { simulated: boolean }[] } };
    expect(body.simulated).toBe(true);
    for (const row of body.portfolio.recent) expect(row.simulated).toBe(true);

    // A caller who has traded nothing sees nothing, rather than seeing the
    // other caller's trades.
    const empty = await invoke({ request_id: 'req-00000012', capability: 'trading.paper_portfolio', caller: 'caller-dddd', input: {} });
    expect((empty.json().data as { portfolio: { trades: number } }).portfolio.trades).toBe(0);
  });

  it('reports a market read honestly rather than flattening it to nothing', async () => {
    const response = await invoke({
      request_id: 'req-00000020',
      capability: 'market.snapshot',
      caller: 'caller-0001',
      input: { subject: token, venue: 'PONS_V2_CURVE' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json().data as { ok: boolean; read: { outcome: string; detail?: string } };
    // No reader is registered here, so the honest answer is that it could not
    // be read, with the reason. "No liquidity" and "no reader" are different
    // facts and a caller has to tell them apart.
    expect(body.ok).toBe(false);
    expect(body.read.outcome).not.toBe('OK');
    expect(typeof body.read.detail === 'string' || body.read.outcome.length > 0).toBe(true);
  });
});

describe('an unconfigured runtime says so rather than failing authentication', () => {
  it('says it is not configured while it has no owner, and answers a trade 503 rather than 500', async () => {
    // A fresh runtime with a secret and no owner. The first live canary of a
    // real deployment answered this with INTERNAL, which a gateway reads as a
    // refusal and fails the caller's job on, instead of waiting for an
    // operator to finish setting it up.
    const listed = (await app.inject({ method: 'GET', url: '/api/utility/capabilities' })).json().data as {
      configured: boolean;
      needsOwner: boolean;
    };
    expect(listed).toMatchObject({ configured: false, needsOwner: true });
    const response = await invoke({ request_id: 'abcd1234', capability: 'trading.paper_trade', caller: 'caller-0001', input: paperTrade });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('UNSAFE_CONFIGURATION');
    expect(response.json().error.message).toMatch(/no owner yet/);
  });

  it('answers 503 with no secret set, not 401', async () => {
    const saved = process.env.AI17Z_UTILITY_SIGNING_SECRET;
    delete process.env.AI17Z_UTILITY_SIGNING_SECRET;
    try {
      const response = await invoke({ request_id: 'abcd1234', capability: 'market.snapshot', caller: 'caller-0001', input: { subject: token, venue: 'PONS_V2_CURVE' } });
      // A 401 would send an operator to check a key that was never the problem.
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('UNSAFE_CONFIGURATION');
    } finally {
      process.env.AI17Z_UTILITY_SIGNING_SECRET = saved;
    }
  });
});
