import { createLogger, errorMessage, loopAllowed, settledPressure, throttleFor } from '@xbam/shared';
import { z } from 'zod';
import { agents as agentsRepo, trading, tradeShadows } from '@xbam/database';
import { AssetRef, BaseUnits, TRADE_VENUE_IDS, TradeSide, assetKey } from '@xbam/shared/contracts';
import { BadRequestError, NotFoundError } from '@xbam/shared';
import { marketReadiness } from './marketData';
import type { ShadowOutcome, TradeShadowRow } from '@xbam/database';
import { runPaperTrade } from './paperTrading';

const log = createLogger('shadow');

/**
 * Shadow trading: the real pipeline, against live markets, executing nothing.
 *
 * The question it answers is the one nobody can answer from a backtest or a
 * description: given this venue, this pair and this size, what would actually
 * have happened, repeatedly, over days. Every run is a real market read, a
 * real risk verdict and a real simulated fill, journalled as an ordinary paper
 * intent. The record is the intents; the row only keeps the tally.
 *
 * ### What this is not
 *
 * **Not a strategy.** A shadow is a standing instruction an owner wrote down:
 * this pair, this size, this often. Nothing here decides what is worth
 * trading, and nothing here is or will be a signal, because a strategy worth
 * anything is not something to put in a public repository and a strategy worth
 * nothing is worse than none. What a shadow measures is execution and market
 * conditions, not alpha, and the product must never say otherwise.
 *
 * **Not a second engine.** A due shadow calls `runPaperTrade`, which is the
 * one pipeline: the same mandate, gate, two reads, simulation and journal a
 * paper trade from the website gets. If it were a path of its own it would be
 * a shadow of that path rather than of the product.
 *
 * **Not a second scheduler.** `claimDue` moves `next_run_at` forward in the
 * statement that selects the row, and this function runs on the sweep that
 * already exists. A feature that brings its own timer is the one nobody
 * remembers to stop.
 *
 * **Not able to execute.** `runPaperTrade` forces PAPER and there is no
 * argument that makes it live. No wallet, no signer, no transaction.
 */

/** How many shadows one pass will run. */
export const MAX_SHADOWS_PER_PASS = 3;

/**
 * Why a pass did nothing, when it did nothing.
 *
 * Said rather than left as an empty result, because "the shadows are not
 * running" has several causes and a screen that cannot tell them apart makes a
 * correctly paused installation look broken.
 */
export interface ShadowPass {
  ran: number;
  /** Why nothing ran, and null when something did. */
  why: 'NONE_DUE' | 'PAUSED_GLOBALLY' | 'UNDER_PRESSURE' | null;
  outcomes: { id: string; label: string; outcome: ShadowOutcome; detail: string | null }[];
}

/*
 * Written as one shape rather than a union on `ran`, because `ran: number`
 * includes zero and TypeScript cannot narrow a union on it: every caller
 * reading `why` had to be told the property existed. A discriminant that does
 * not discriminate is worse than none.
 */

/** One due shadow, run and recorded. Never throws: a pass runs the others. */
export async function runShadow(shadow: TradeShadowRow): Promise<{ outcome: ShadowOutcome; detail: string | null }> {
  try {
    const outcome = await runPaperTrade({
      agentId: shadow.agentId,
      venue: shadow.venue,
      side: shadow.side,
      assetIn: shadow.assetIn,
      assetOut: shadow.assetOut,
      subject: shadow.subject,
      maxIn: shadow.maxIn,
      maxSlippageBps: shadow.maxSlippageBps,
      maxPriceImpactBps: shadow.maxPriceImpactBps,
      maxFeeBase: shadow.maxFeeBase,
      /*
       * Keyed to the shadow and the slot it was claimed for.
       *
       * `last_run_at` is set by the claim, so a worker that died between the
       * claim and the engine and was replaced produces the same key and finds
       * the first intent rather than making a second. Without it a crash in
       * the middle of a pass is a duplicate trade in the journal, and the
       * journal is the whole output of this feature.
       */
      idempotencyKey: `shadow-${shadow.id}-${shadow.lastRunAt ?? shadow.nextRunAt}`,
    });

    switch (outcome.outcome) {
      case 'FILLED':
        return { outcome: 'FILLED', detail: `Filled ${outcome.fill.outBase} for ${outcome.fill.inBase}.` };
      case 'REFUSED':
        // The reasons, not a score. "Why did it stop filling" is a fair
        // question and a count cannot answer it.
        return { outcome: 'REFUSED', detail: outcome.verdict.reasons.map((r) => r.code).join(', ') };
      case 'NO_MARKET':
        return { outcome: 'NO_MARKET', detail: outcome.detail };
    }
  } catch (error) {
    // An error is its own outcome rather than a failed run that vanishes. A
    // shadow nobody can see failing is worse than one that is not running.
    return { outcome: 'ERROR', detail: errorMessage(error) };
  }
}

/**
 * Run whatever is due.
 *
 * Called from the worker's sweep. Usually a single indexed query that returns
 * nothing, because each shadow carries its own interval and the claim is what
 * decides whether any are due at all.
 */
export async function runDueShadows(limit = MAX_SHADOWS_PER_PASS, now: Date = new Date()): Promise<ShadowPass> {
  /*
   * A global pause stops shadows.
   *
   * The risk gate would refuse each one anyway and record PAUSED, which is
   * correct but costs a market read per shadow per interval to find out
   * something already known. Checked before the claim so a paused
   * installation spends nothing, and checked globally only: an agent-scoped
   * or venue-scoped pause is the gate's to apply, with its reasons, because
   * those are about one shadow rather than about all of them.
   */
  const paused = await trading.activePauseScopes({ agentId: '', venue: 'ROBINHOOD', walletId: null });
  if (paused.includes('GLOBAL')) return { ran: 0, why: 'PAUSED_GLOBALLY', outcomes: [] };

  /*
   * Shadow work is the agent acting on its own, so it is STANDARD: it stops
   * when memory is critical and not before. Delayed rather than dropped,
   * which is what a schedule with a claim gives for free: the row is simply
   * still due on the next pass.
   */
  if (!loopAllowed('STANDARD', throttleFor(settledPressure()).runLoopsDownTo)) {
    return { ran: 0, why: 'UNDER_PRESSURE', outcomes: [] };
  }

  const due = await tradeShadows.claimDue(limit, now);
  if (due.length === 0) return { ran: 0, why: 'NONE_DUE', outcomes: [] };

  const outcomes: { id: string; label: string; outcome: ShadowOutcome; detail: string | null }[] = [];
  for (const shadow of due) {
    const result = await runShadow(shadow);
    await tradeShadows.noteRun(shadow.id, result.outcome, result.detail).catch((error) =>
      // The run happened whatever the tally says, and the intent is the
      // record. Losing the tally must not lose the pass.
      log.warn('could not record a shadow run', { shadow: shadow.id, message: errorMessage(error) }),
    );
    outcomes.push({ id: shadow.id, label: shadow.label, outcome: result.outcome, detail: result.detail });
  }
  log.info('shadow pass', { ran: outcomes.length, outcomes: outcomes.map((o) => `${o.label}:${o.outcome}`) });
  return { ran: outcomes.length, why: null, outcomes };
}

// ── The owner's own surface ────────────────────────────────────────────────
//
// Shadows are the owner's, never a model's. There is no capability for any of
// this and there must not be: a model that could create a standing instruction
// to read a market every minute has been handed a schedule, and the whole
// point of the read budget is that nothing gets to do that.

/** What an owner may set. Parsed rather than trusted. */
export const ShadowRequest = z
  .object({
    label: z.string().trim().min(1).max(80),
    venue: z.enum(TRADE_VENUE_IDS),
    side: TradeSide,
    assetIn: AssetRef,
    assetOut: AssetRef,
    subject: AssetRef,
    maxIn: BaseUnits,
    maxSlippageBps: z.number().int().min(0).max(10_000),
    maxPriceImpactBps: z.number().int().min(0).max(10_000),
    maxFeeBase: BaseUnits,
    /*
     * A minute is the floor and a day is the ceiling, matching the database
     * CHECK rather than being looser than it. A validator that allows what the
     * table refuses turns an owner's mistake into a 500.
     */
    intervalSeconds: z.number().int().min(60).max(86_400),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (assetKey(value.assetIn) === assetKey(value.assetOut)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A shadow has to trade one asset for a different one.' });
    }
    // The subject is what gets priced, so it has to be one of the two sides or
    // the shadow would be reading a market it is not trading in.
    if (assetKey(value.subject) !== assetKey(value.assetIn) && assetKey(value.subject) !== assetKey(value.assetOut)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The asset being priced has to be one of the two being traded.', path: ['subject'] });
    }
  });
export type ShadowRequest = z.infer<typeof ShadowRequest>;

async function requireOwnedAgent(agentId: string, ownerId: string): Promise<void> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent || agent.ownerId !== ownerId) throw new NotFoundError('Agent');
}

/**
 * What an owner sees: the shadows, and whether the venue can be read at all.
 *
 * Readiness travels with them because a shadow on a venue nothing can price
 * records a column of NO_MARKET and looks like a fault. Said up front instead.
 */
export async function shadowsOf(agentId: string, ownerId: string): Promise<{
  shadows: TradeShadowRow[];
  venues: { venue: string; ready: boolean; detail: string }[];
}> {
  await requireOwnedAgent(agentId, ownerId);
  return {
    shadows: await tradeShadows.listShadows(agentId),
    venues: TRADE_VENUE_IDS.map((venue) => ({ venue, ...marketReadiness(venue) })),
  };
}

export async function putShadowFor(agentId: string, ownerId: string, request: unknown): Promise<TradeShadowRow> {
  await requireOwnedAgent(agentId, ownerId);
  const parsed = ShadowRequest.parse(request);
  /*
   * A shadow needs a mandate, and says so before it is saved.
   *
   * Without one every run records a NO_MARKET whose detail is "this agent has
   * no mandate", which is a true sentence nobody reads until they have watched
   * a column of failures and wondered what is wrong with the market.
   */
  const mandate = await trading.liveMandate(agentId);
  if (!mandate) {
    throw new BadRequestError('This agent has no trading mandate yet, so nothing can be simulated for it. Set one first.');
  }
  return tradeShadows.putShadow({ agentId, ownerId, ...parsed });
}

export async function setShadowPausedFor(id: string, ownerId: string, paused: boolean): Promise<TradeShadowRow> {
  const existing = await tradeShadows.getShadow(id);
  if (!existing) throw new NotFoundError('Shadow');
  await requireOwnedAgent(existing.agentId, ownerId);
  const updated = await tradeShadows.setShadowPaused(id, paused);
  if (!updated) throw new NotFoundError('Shadow');
  return updated;
}

export async function deleteShadowFor(id: string, ownerId: string): Promise<void> {
  const existing = await tradeShadows.getShadow(id);
  // Already gone is the outcome somebody asked for, so it is not an error.
  if (!existing) return;
  await requireOwnedAgent(existing.agentId, ownerId);
  await tradeShadows.deleteShadow(id);
}
