import type { FastifyInstance } from 'fastify';
import { agents as agentsRepo, capabilityInvocations, trading, users as usersRepo } from '@xbam/database';
import { getCapability, invokeCapability } from '@xbam/tools';
import {
  UTILITY_CAPABILITIES,
  UTILITY_CAPABILITY_IDS,
  UTILITY_BRIDGE,
  UTILITY_REFUSALS,
  bridgeRefusal,
  zodToDescription,
  UtilityRequest,
  inputSchemaFor,
  isUtilityCapability,
  marketReadiness,
  readMarket,
  runBacktest,
  runPaperTrade,
  utilityAgentName,
  utilityPaperMandate,
  widenedUtilitySandbox,
  verifyUtilitySignature,
  type BacktestInput,
  type Candle,
  type PaperTradeInput,
  type UtilityCapability,
} from '@xbam/runtime';
import { PersonaDraft, TRADE_VENUE_IDS, type AssetRef, type TradeVenue } from '@xbam/shared/contracts';
import { BadRequestError, NotFoundError, UnauthorizedError, XbamError, createLogger } from '@xbam/shared';
import { handler } from '../http';

/**
 * A runtime that has no signing secret cannot authenticate anybody.
 *
 * 503 rather than 401, because that is this runtime failing to be configured
 * rather than the caller failing to prove who they are, and a 401 would send
 * an operator to check a key that was never the problem. The code is
 * UNSAFE_CONFIGURATION, which is the existing name for exactly this: a
 * deployment that cannot safely do what it was asked.
 */
class UtilityNotConfiguredError extends XbamError {
  constructor(message: string) {
    super('UNSAFE_CONFIGURATION', message, 503);
  }
}

const bridgeLog = createLogger('utility.bridge');

/** The same class of answer for a runtime with no owner, which cannot keep a journal for anybody. */
const NO_OWNER = "This runtime has no owner yet, so it cannot keep a caller's paper journal. Create one with POST /api/bootstrap/owner.";

/**
 * The shared utility surface: one signed endpoint a gateway calls on a website
 * caller's behalf.
 *
 * This is Class 1 compute and holds nothing anybody would mind losing: no
 * provider credential, no wallet, no browser session, no X cookie. That is why
 * one runtime can serve many callers, and why none of it waits on confidential
 * hardware.
 *
 * **The caller is a pseudonym and stays one.** The gateway sends an opaque
 * string, so this runtime cannot learn whose request it is running. It keeps a
 * separate agent, mandate and journal per pseudonym, so two callers' paper
 * trades are as separate as two agents on one owner's machine.
 *
 * **Nothing here can move value.** No capability signs, sends, transfers or
 * approves; none takes a wallet or a key; and `runPaperTrade` forces PAPER in
 * core rather than reading a mode from the request. A live trade is a different
 * surface with a different authorisation, and putting one behind a shared HMAC
 * would mean an HTTP request could spend money.
 */
export async function utilityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What this runtime offers, so a gateway can check its own list against the
   * truth rather than against a document.
   *
   * Unauthenticated on purpose: it is capability names and descriptions, the
   * same information a published manifest carries, and needing a signature to
   * read it would stop an operator checking configuration.
   */
  app.get(
    '/api/utility/capabilities',
    handler(async () => ({
      capabilities: UTILITY_CAPABILITY_IDS.map((id) => ({ id, ...UTILITY_CAPABILITIES[id] })),
      refuses: UTILITY_REFUSALS,
      /*
       * Configured means able to serve, which takes an owner as well as a
       * secret: every caller's journal is an agent, and an agent belongs to
       * an owner. Reported here so a gateway can say so before anybody waits
       * on a trade that cannot run.
       */
      configured: (process.env.AI17Z_UTILITY_SIGNING_SECRET ?? '') !== '' && (await usersRepo.countUsers()) > 0,
      needsOwner: (await usersRepo.countUsers()) === 0,
      /**
       * Which venues can actually be priced here.
       *
       * Reported rather than discovered by trying: without this, a caller
       * submits a paper trade, waits, and gets NO_MARKET, which reads as the
       * product being broken rather than as this runtime having no market data
       * provider. A gateway can refuse up front instead, and say why.
       */
      venues: TRADE_VENUE_IDS.map((venue) => ({ venue, ...marketReadiness(venue) })),
      /** Nothing can be priced at all, which is worth saying in one word. */
      priceable: TRADE_VENUE_IDS.some((venue) => marketReadiness(venue).ready),
      /*
       * What `capability.invoke` will run, each with what it answers and the
       * shape of its input, in the same words an agent's own menu uses. Only
       * what is on the list and installed and still passes its own
       * declaration, so a gateway never offers something this runtime would
       * refuse.
       */
      bridge: UTILITY_BRIDGE.flatMap((id) => {
        const declared = getCapability(id);
        if (declared === null || bridgeRefusal(id, declared) !== null) return [];
        return [{ id, name: declared.name, description: declared.description, input: zodToDescription(declared.input as never) }];
      }),
    })),
  );

  app.post(
    '/api/utility/invoke',
    handler(async (request) => {
      // The raw body, byte for byte, because the signature covers exactly what
      // was sent. Re-serialising a parsed object changes key order and
      // whitespace and would fail against an honest signature.
      const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? {});
      const headers = request.headers as Record<string, string | undefined>;

      const signed = verifyUtilitySignature({
        secret: process.env.AI17Z_UTILITY_SIGNING_SECRET,
        timestamp: headers['x-ai17z-timestamp'],
        signature: headers['x-ai17z-signature'],
        body: raw,
      });
      if (!signed.ok) {
        // Thrown rather than returned with a status: `handler` answers 200 with
        // whatever a handler returns, so a set code is ignored. The error
        // classes are what carry a status here.
        if (signed.why === 'NO_SECRET') throw new UtilityNotConfiguredError(signed.detail);
        throw new UnauthorizedError(`${signed.detail} (${signed.why})`);
      }

      const envelopeInput: unknown = typeof request.body === 'string' ? JSON.parse(raw) : request.body;
      const parsedEnvelope = UtilityRequest.safeParse(envelopeInput);
      if (!parsedEnvelope.success) {
        throw new BadRequestError(parsedEnvelope.error.issues[0]?.message ?? 'That request is not the right shape.');
      }
      const envelope = parsedEnvelope.data;

      if (!isUtilityCapability(envelope.capability)) {
        throw new NotFoundError(`This runtime does not offer ${envelope.capability}.`);
      }
      const capability: UtilityCapability = envelope.capability;

      const parsedInput = inputSchemaFor(capability).safeParse(envelope.input);
      if (!parsedInput.success) {
        throw new BadRequestError(parsedInput.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
      }

      const started = Date.now();
      const result = await runUtilityCapability(capability, envelope.caller, parsedInput.data);
      return { request_id: envelope.request_id, capability, latencyMs: Date.now() - started, ...result };
    }),
  );
}

/**
 * The agent a pseudonym's work runs as, created on first use.
 *
 * Owned by this runtime's own owner rather than by the caller, because a shared
 * utility runtime is operated by AI17Z and a caller has no account here. The
 * isolation that matters is per pseudonym, not per owner: a separate agent
 * means a separate mandate, separate intents and a separate journal.
 *
 * The slug is derived from the pseudonym, so the same caller reaches the same
 * agent every time without this runtime recording who they are.
 */
async function utilityAgentFor(caller: string): Promise<string> {
  const owners = await usersRepo.listUsers();
  const ownerId = owners[0]?.id;
  if (ownerId === undefined) {
    // A deployment that has not finished being set up, not a fault in the
    // request: classified so a gateway waits rather than failing the caller's
    // job, and so an operator reads a sentence instead of a 500. Found by the
    // first live canary of a fresh runtime, which answered INTERNAL.
    throw new UtilityNotConfiguredError(NO_OWNER);
  }

  const name = utilityAgentName(caller);
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const existing = await agentsRepo.getAgentBySlug(ownerId, slug);
  if (existing) return existing.id;

  const created = await agentsRepo.createAgent({
    ownerId,
    name,
    slug,
    description: 'A shared-utility caller\'s paper trading journal. Holds no credential and signs nothing.',
    // Parsed through the contract rather than hand-listed, so every default
    // this build defines is applied. Listing the fields by hand missed
    // `customInstructions`, which the database requires, and the agent could
    // not be created at all: a persona has more required columns than a
    // reasonable guess produces, and the schema is the only thing that knows
    // which.
    persona: PersonaDraft.parse({ displayName: 'Paper journal' }),
  });
  await trading.putMandate({ agentId: created.id, ownerId, mandate: utilityPaperMandate() as never });
  return created.id;
}

/**
 * Adds this request's assets to the caller's paper sandbox, if they are new.
 *
 * The decision is `widenedUtilitySandbox`, which is pure and tested on what it
 * may not change. This is only the read and the write around it, so the rule
 * lives in one place and the route holds no judgement of its own.
 */
async function widenSandboxFor(agentId: string, assets: readonly AssetRef[]): Promise<void> {
  const current = await trading.liveMandate(agentId);
  if (!current) return;
  const widened = widenedUtilitySandbox(current, assets);
  if (widened === null) return;
  await trading.putMandate({ agentId, ownerId: current.ownerId, mandate: widened as never });
}

/** A caller's paper standing, read from the journal this runtime already keeps. */
async function paperPortfolio(agentId: string): Promise<Record<string, unknown>> {
  const intents = await trading.listIntents(agentId, 200);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const exposure = await trading.exposureOf(agentId, since);
  // PAPER_FILLED, not FILLED: core names a simulated fill differently from a
  // real one on purpose, and reading the wrong one would have reported every
  // paper trade as never having filled.
  const filled = intents.filter((i) => i.status === 'PAPER_FILLED' || i.status === 'SIMULATED');
  return {
    // Named rather than counted where it matters: "how many trades" says less
    // than which ones reached a fill and which stopped at a refusal.
    trades: intents.length,
    simulatedOrFilled: filled.length,
    refused: intents.filter((i) => i.status === 'RISK_REJECTED' || i.status === 'FAILED').length,
    exposure,
    recent: intents.slice(0, 20).map((i) => ({
      id: i.id,
      venue: i.venue,
      side: i.side,
      status: i.status,
      maxIn: i.maxIn,
      minOut: i.minOut,
      createdAt: i.createdAt,
      // Simulated throughout. Said on every row rather than once at the top,
      // because a row copied out of a response must carry it too.
      simulated: true,
    })),
  };
}

async function runUtilityCapability(
  capability: UtilityCapability,
  caller: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  switch (capability) {
    case 'trading.paper_trade': {
      const agentId = await utilityAgentFor(caller);
      const i = input as PaperTradeInput;
      /*
       * The sandbox records what this caller has looked at.
       *
       * A standing mandate has to be written before anybody says what they
       * want to trade, so its asset list cannot name the thing being asked
       * about now. Widened here, before the engine reads it, rather than by
       * the engine, because the engine's mandate check is the thing being
       * relied on and must not be the thing that moves.
       */
      await widenSandboxFor(agentId, [i.assetIn, i.assetOut, i.subject]);
      // Straight through to canonical core. The website calculates no financial
      // semantics of its own: the mandate, market read, risk, quote, simulation
      // and journal are core's, and PAPER is forced there rather than passed in.
      const outcome = await runPaperTrade({
        agentId,
        venue: i.venue,
        side: i.side,
        assetIn: i.assetIn,
        assetOut: i.assetOut,
        subject: i.subject,
        maxIn: i.maxIn,
        maxSlippageBps: i.maxSlippageBps,
        maxPriceImpactBps: i.maxPriceImpactBps,
        maxFeeBase: i.maxFeeBase,
        ...(i.idempotencyKey === undefined ? {} : { idempotencyKey: i.idempotencyKey }),
      });
      return { ok: outcome.outcome === 'FILLED', simulated: true, outcome };
    }
    case 'trading.backtest': {
      const i = input as BacktestInput;
      const agentId = await utilityAgentFor(caller);
      /*
       * History is read once, through the same capability an agent reads it
       * with, and every rule replays that one series. Recorded like any
       * invocation, so the market read behind a backtest is on the record.
       */
      const read = await invokeCapability({
        call: { id: 'market.ohlcv', input: { chain: i.chain, poolAddress: i.poolAddress, timeframe: i.timeframe, limit: i.candles } },
        context: { agentId, jobId: null, accountId: null, config: {}, audience: 'PUBLIC', logger: bridgeLog },
        permission: { stored: null, paused: false },
      });
      await capabilityInvocations
        .recordInvocation({
          agentId,
          jobId: null,
          accountId: null,
          capabilityId: 'market.ohlcv',
          step: 0,
          outcome: read.outcome,
          detail: read.detail,
          input: read.input,
          output: null,
          durationMs: read.durationMs,
        })
        .catch((error: unknown) => bridgeLog.warn('could not record a backtest read', { error: String(error) }));
      if (read.outcome !== 'SUCCEEDED') return { ok: false, simulated: true, detail: read.detail };

      const history = read.output as { candles: Candle[]; unreadableRows: number; note: string; provenance: unknown };
      return {
        ok: true,
        simulated: true,
        history: {
          chain: i.chain,
          poolAddress: i.poolAddress,
          timeframe: i.timeframe,
          unreadableRows: history.unreadableRows,
          // Said, because an unlabelled unit is how a backtest gets misread:
          // the indexer reports candles in dollars per unit of the pool's
          // base token, so every rule's spend is in dollars too.
          priceUnit: "US dollars per unit of the pool's base token, as the market indexer reports it",
          note: history.note,
          provenance: history.provenance,
        },
        results: i.rules.map((rule) => runBacktest({ candles: history.candles, rule, costs: i.costs })),
      };
    }
    case 'capability.invoke': {
      const i = input as { id: string; input: Record<string, unknown> };
      const declared = getCapability(i.id);
      const refusal = bridgeRefusal(i.id, declared ?? undefined);
      // Refused before an agent is made or anything reached the network: a
      // caller probing ids learns which are offered, which is public, and
      // nothing else.
      if (refusal !== null) throw new NotFoundError(refusal);
      const agentId = await utilityAgentFor(caller);
      /*
       * The same path an agent's own call takes: the capability's input and
       * output schemas, its timeout, its readiness and the upstream budgets
       * every caller of this runtime shares, so one caller asking hard cannot
       * spend everybody's quota faster than the limiter allows.
       */
      const result = await invokeCapability({
        call: { id: i.id, input: i.input },
        context: { agentId, jobId: null, accountId: null, config: {}, audience: 'PUBLIC', logger: bridgeLog },
        permission: { stored: null, paused: false },
      });
      // Recorded as any agent's invocation is, so "what did this runtime reach
      // for whom" has one answer. Losing the row does not lose the answer.
      await capabilityInvocations
        .recordInvocation({
          agentId,
          jobId: null,
          accountId: null,
          capabilityId: i.id,
          step: 0,
          outcome: result.outcome,
          detail: result.detail,
          input: result.input,
          output: result.output,
          durationMs: result.durationMs,
        })
        .catch((error: unknown) => bridgeLog.warn('could not record a utility invocation', { capability: i.id, error: String(error) }));
      return {
        ok: result.outcome === 'SUCCEEDED',
        capability: i.id,
        outcome: result.outcome,
        detail: result.detail,
        output: result.output,
        durationMs: result.durationMs,
      };
    }
    case 'trading.paper_portfolio': {
      const agentId = await utilityAgentFor(caller);
      return { ok: true, simulated: true, portfolio: await paperPortfolio(agentId) };
    }
    case 'market.snapshot': {
      const i = input as { subject: AssetRef; venue: TradeVenue; quote?: AssetRef };
      const read = await readMarket(i.subject, i.venue, i.quote);
      // The outcome travels rather than being flattened to null: "no reader for
      // this venue" and "the venue answered with no liquidity" are different
      // facts and a caller has to be able to tell them apart.
      return { ok: read.outcome === 'OK', read };
    }
  }
}
