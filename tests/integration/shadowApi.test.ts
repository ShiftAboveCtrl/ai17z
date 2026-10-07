import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server';
import { tradeShadows, trading } from '@xbam/database';
import { AssetRef, type TradeMandate } from '@xbam/shared/contracts';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Shadow trading over HTTP, which is where the ownership rule lives.
 *
 * The runner, the claim and the outcomes have their own tests. What those
 * cannot prove is that an id is not a way to reach somebody else's standing
 * instruction to read a market, and that nothing here answers a request that
 * is not signed in at all.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

async function signIn(email: string): Promise<{ authorization: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'test-password-1234' } });
  expect(response.statusCode, response.body).toBe(200);
  const { data } = response.json() as { data: { token: string } };
  return { authorization: `Bearer ${data.token}` };
}

const TOKEN = AssetRef.parse({
  kind: 'ONCHAIN',
  network: 'robinhood',
  address: '0x00000000000000000000000000000000000000aa',
  decimals: 18,
});
const NATIVE = AssetRef.parse({ kind: 'NATIVE', network: 'robinhood' });

const request = (over: Record<string, unknown> = {}) => ({
  label: 'fixture pair',
  venue: 'PONS_V2_CURVE',
  side: 'BUY',
  assetIn: NATIVE,
  assetOut: TOKEN,
  subject: TOKEN,
  maxIn: '1000000000000000000',
  maxSlippageBps: 50,
  maxPriceImpactBps: 100,
  maxFeeBase: '100000000000000000',
  intervalSeconds: 300,
  ...over,
});

async function withMandate() {
  const fixture = await createFixture();
  await trading.putMandate({
    agentId: fixture.agentId,
    ownerId: fixture.ownerId,
    mandate: {
      mode: 'PAPER',
      approval: 'OWNER_APPROVES_EACH',
      venues: ['PONS_V2_CURVE'],
      networks: ['robinhood'],
      allowedAssets: [TOKEN, NATIVE],
      maxPerTrade: '10000000000000000000',
      maxPerDay: '50000000000000000000',
      maxOpenExposure: '40000000000000000000',
      maxOpenPositions: 5,
      maxSlippageBps: 100,
      maxPriceImpactBps: 200,
      minLiquidityBase: '1',
      maxFeeBase: '100000000000000000',
      quoteMaxAgeMs: 30_000,
      expiresAt: null,
      paused: false,
    } as unknown as Omit<TradeMandate, 'id' | 'agentId'>,
  });
  return { fixture, headers: await signIn(fixture.ownerEmail) };
}

describe('setting up a shadow', () => {
  it('creates one, and says which venues can actually be priced', async () => {
    const { fixture, headers } = await withMandate();
    const made = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/shadows`, headers, payload: request() });
    expect(made.statusCode, made.body).toBe(200);

    const listed = await app.inject({ method: 'GET', url: `/api/agents/${fixture.agentId}/shadows`, headers });
    const { data } = listed.json() as { data: { shadows: unknown[]; venues: { venue: string; ready: boolean }[] } };
    expect(data.shadows).toHaveLength(1);
    // Readiness travels with the list, because a shadow on a venue nothing can
    // price records a column of NO_MARKET and reads as a fault.
    expect(data.venues.some((v) => v.venue === 'AMM_POOL_EVM')).toBe(true);
  });

  it('refuses a shadow for an agent with no mandate, and says why', async () => {
    const fixture = await createFixture();
    const headers = await signIn(fixture.ownerEmail);
    const made = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/shadows`, headers, payload: request() });
    // Said before it is saved rather than once a column of failures has
    // accumulated whose detail nobody read.
    expect(made.statusCode).toBe(400);
    expect(made.body).toMatch(/no trading mandate/);
  });

  it('refuses a request that is not a trade', async () => {
    const { fixture, headers } = await withMandate();
    for (const bad of [
      // The same asset on both sides.
      request({ assetIn: TOKEN, assetOut: TOKEN }),
      // Pricing something neither side of the trade.
      request({ subject: AssetRef.parse({ kind: 'NATIVE', network: 'solana' }) }),
      // Faster than the floor, which the database refuses too.
      request({ intervalSeconds: 5 }),
      // An amount that is not a whole number of base units.
      request({ maxIn: '1.5' }),
      // A field nobody defined, which a strict schema refuses rather than
      // silently ignoring: a typo in a limit is a limit that is not applied.
      request({ maxInn: '1' }),
    ]) {
      const made = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/shadows`, headers, payload: bad });
      // 422 rather than 400: a request that parsed but said something
      // impossible is this API's unprocessable, and 400 is kept for a request
      // the system could not act on for a reason outside the body, such as an
      // agent with no mandate. Both are refusals; which one says which.
      expect(made.statusCode, JSON.stringify(bad)).toBe(422);
    }
  });

  it('updates the shadow with the same label rather than adding a second', async () => {
    const { fixture, headers } = await withMandate();
    await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/shadows`, headers, payload: request() });
    await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/shadows`, headers, payload: request({ intervalSeconds: 900 }) });
    const shadows = await tradeShadows.listShadows(fixture.agentId);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.intervalSeconds).toBe(900);
  });
});

describe('a shadow belongs to its owner', () => {
  it('answers nothing to a request that is not signed in', async () => {
    const { fixture } = await withMandate();
    for (const call of [
      { method: 'GET' as const, url: `/api/agents/${fixture.agentId}/shadows` },
      { method: 'POST' as const, url: `/api/agents/${fixture.agentId}/shadows` },
    ]) {
      const response = await app.inject({ ...call, payload: request() });
      expect(response.statusCode).toBe(401);
    }
  });

  it('does not find somebody else\'s agent, rather than refusing it', async () => {
    const mine = await withMandate();
    const theirs = await withMandate();
    // Not found rather than forbidden, so an id tells a stranger nothing about
    // what exists.
    const listed = await app.inject({ method: 'GET', url: `/api/agents/${theirs.fixture.agentId}/shadows`, headers: mine.headers });
    expect(listed.statusCode).toBe(404);
    const made = await app.inject({
      method: 'POST',
      url: `/api/agents/${theirs.fixture.agentId}/shadows`,
      headers: mine.headers,
      payload: request(),
    });
    expect(made.statusCode).toBe(404);
  });

  it('does not let somebody else pause or delete a shadow', async () => {
    const mine = await withMandate();
    const theirs = await withMandate();
    const made = await app.inject({
      method: 'POST',
      url: `/api/agents/${theirs.fixture.agentId}/shadows`,
      headers: theirs.headers,
      payload: request(),
    });
    const { data } = made.json() as { data: { shadow: { id: string } } };

    const paused = await app.inject({ method: 'POST', url: `/api/shadows/${data.shadow.id}/paused`, headers: mine.headers, payload: { paused: true } });
    expect(paused.statusCode).toBe(404);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/shadows/${data.shadow.id}`, headers: mine.headers });
    expect(deleted.statusCode).toBe(404);
    // Untouched, which is the thing being proved rather than the status code.
    const still = await tradeShadows.getShadow(data.shadow.id);
    expect(still).not.toBeNull();
    expect(still!.paused).toBe(false);
  });

  it('pauses and deletes for the owner, and deleting twice is the same answer', async () => {
    const { fixture, headers } = await withMandate();
    const made = await app.inject({ method: 'POST', url: `/api/agents/${fixture.agentId}/shadows`, headers, payload: request() });
    const { data } = made.json() as { data: { shadow: { id: string } } };

    const paused = await app.inject({ method: 'POST', url: `/api/shadows/${data.shadow.id}/paused`, headers, payload: { paused: true } });
    expect(paused.statusCode).toBe(200);
    expect((await tradeShadows.getShadow(data.shadow.id))!.paused).toBe(true);

    expect((await app.inject({ method: 'DELETE', url: `/api/shadows/${data.shadow.id}`, headers })).statusCode).toBe(200);
    expect(await tradeShadows.getShadow(data.shadow.id)).toBeNull();
    // Already gone is the outcome somebody asked for.
    expect((await app.inject({ method: 'DELETE', url: `/api/shadows/${data.shadow.id}`, headers })).statusCode).toBe(200);
  });
});
