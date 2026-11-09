import { z } from 'zod';
import { capabilityInvocations, capabilityPermissions, events, jobs, socialPaper, trading, type TradeMandateRow } from '@xbam/database';
import { AssetRef, BaseUnits, TradeVenueId, assetKey, type AssetRef as Asset } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { defineCapability, registerCapability, type AnyCapability, type CapabilityContext } from '@xbam/tools';
import { normaliseChain, parseTokenReference, resolveToken } from './token';
import { readPoolAsset } from './poolMarketReader';
import { runPaperTrade, type PaperOutcome } from './paperTrading';
import { pauseState } from './killSwitch';
import { removeEmDashes } from './punctuation';
import { paperPositions } from './paperPositions';
import type { RiskReason } from './tradingRisk';

/** Owner configuration only. No part of this object is a model argument. */
export const SocialPaperConfig = z.object({
  mandateId: z.string().uuid(),
  venue: TradeVenueId,
  quoteAsset: AssetRef,
  maxInBase: BaseUnits.refine((v) => BigInt(v) > 0n, 'Choose a positive paper size.'),
  maxPerDayBase: BaseUnits.refine((v) => BigInt(v) > 0n, 'Choose a positive paper daily limit.').optional(),
  maxRequestsPerRequesterPerDay: z.number().int().min(1).max(100).default(3),
}).strict().transform((config) => ({
  ...config,
  maxPerDayBase: config.maxPerDayBase ?? (BigInt(config.maxInBase) * 10n).toString(),
}));

const Reason = z.object({ code: z.string(), detail: z.string() });
const Verdict = z.object({ allowed: z.boolean(), needsOwnerApproval: z.boolean(), reasons: z.array(Reason) });
const Result = z.object({
  simulated: z.literal(true),
  outcome: z.enum(['FILLED', 'REFUSED', 'NO_MARKET', 'PENDING']),
  asset: AssetRef.nullable(),
  quoteAsset: AssetRef.nullable(),
  intentId: z.string().nullable(),
  fill: z.object({
    simulated: z.literal(true), inBase: z.string(), outBase: z.string(), feeBase: z.string(),
    slippageBps: z.number(), priceImpactBps: z.number(), impactModel: z.string(), observedAt: z.string(), source: z.string(),
  }).nullable(),
  verdict: Verdict.nullable(),
  reply: z.string(),
}).strict();
type Result = z.infer<typeof Result>;

/** A closed grammar makes extra assets and instructions a refusal, not context. */
export function parseSocialPaperRequest(text: string): { token: string; amount: string | null } | null {
  const request = text.trim().replace(/^(?:@[A-Za-z0-9_]+\s+)+/, '');
  const hasVerb = /^paper\s+(?:long|buy)\s+/i.test(request);
  const body = request.replace(/^paper\s+(?:long|buy)\s+/i, '');
  const match = /^(\$[A-Za-z][A-Za-z0-9]{0,9}|0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+on\s+([A-Za-z]{2,12}))?(?:\s+for\s+([0-9]{1,78})\s+base\s+units)?[.!]?$/.exec(body);
  if (!match) return null;
  // Tickers require an explicit paper verb. A bare address is already exact.
  if (match[1]!.startsWith('$') && !hasVerb) return null;
  return { token: `${match[1]}${match[2] ? ` on ${match[2]}` : ''}`, amount: match[3] ?? null };
}

function refusal(reason: string, code = 'REQUEST_REFUSED', outcome: 'REFUSED' | 'NO_MARKET' | 'PENDING' = 'REFUSED'): Result {
  return {
    simulated: true, outcome, asset: null, quoteAsset: null, intentId: null, fill: null,
    verdict: { allowed: false, needsOwnerApproval: false, reasons: [{ code, detail: reason }] },
    reply: removeEmDashes(`Simulated paper ${outcome === 'NO_MARKET' ? 'no market' : outcome === 'PENDING' ? 'pending' : 'refused'}: ${reason}`).text,
  };
}

export function isSocialPaperMandate(row: TradeMandateRow | null, id: string, agentId: string): row is TradeMandateRow {
  return Boolean(row && row.id === id && row.agentId === agentId && row.ownerId && !row.retiredAt
    && row.mode === 'PAPER' && row.approval === 'OWNER_APPROVES_EACH' && row.protectiveExits === null);
}

/** Read the actual incoming message, never model-provided text or thread context. */
async function incoming(ctx: CapabilityContext): Promise<{ key: string; text: string; requester: string } | null> {
  if (ctx.jobId) {
    const job = await jobs.getJob(ctx.jobId);
    if (!job || job.agentId !== ctx.agentId || job.accountId !== ctx.accountId || job.actionType !== 'REPLY') return null;
    const event = await events.getEvent(job.eventId);
    if (!event || !['MENTION', 'REPLY', 'DM'].includes(event.type)) return null;
    return { key: `event:${event.id}`, text: event.text ?? '', requester: `${event.channel}:${event.remoteAuthorId ?? 'unknown'}` };
  }
  if (ctx.audience === 'OWNER' && ctx.origin?.messageId && ctx.origin.text) {
    return { key: `chat:${ctx.origin.messageId}`, text: ctx.origin.text, requester: `owner:${ctx.origin.ownerId}` };
  }
  return null;
}

function label(asset: Asset): string {
  const symbol = asset.kind === 'NATIVE' ? asset.network : asset.symbol;
  const safe = symbol && /^[A-Za-z0-9]{1,12}$/.test(symbol) ? symbol : null;
  if (asset.kind !== 'ONCHAIN') return safe ?? 'asset';
  const address = `${asset.address.slice(0, 6)}...${asset.address.slice(-4)}`;
  return safe ? `${safe} (${address})` : address;
}

function report(out: PaperOutcome, asset: Asset, quoteAsset: Asset): Result {
  if (out.outcome === 'NO_MARKET') return {
    ...refusal(out.detail, 'NO_MARKET', 'NO_MARKET'), asset, quoteAsset,
    reply: `Simulated paper no market for ${label(asset)}. No readable quote; no fill.`,
  };
  // Full explanations remain on the structured verdict and journal. The public
  // receipt uses named causes so multiple failures still fit a normal reply.
  const reasons = out.verdict.reasons.map((r) => r.code).join(', ');
  const base = { simulated: true as const, asset, quoteAsset, intentId: out.intent.id, verdict: out.verdict };
  if (out.outcome === 'REFUSED') return { ...base, outcome: 'REFUSED', fill: null, reply: `Simulated paper refused for ${label(asset)}. Risk ${reasons}. No fill.` };
  const f = out.fill;
  return {
    ...base, outcome: 'FILLED',
    fill: { simulated: true, inBase: f.inBase, outBase: f.outBase, feeBase: f.feeBase, slippageBps: f.slippageBps, priceImpactBps: f.priceImpactBps, impactModel: f.impactModel, observedAt: f.at.observedAt, source: f.at.source },
    reply: `Simulated paper BUY: ${f.inBase} ${label(quoteAsset)} base units for ${f.outBase} ${label(asset)} base units; fee ${f.feeBase} input base units. Risk ${reasons}.`,
  };
}

const paperTrade = defineCapability({
  id: 'paper.trade', name: 'Paper trade',
  description: 'Simulate one paper long or paper buy when the incoming message asks, or gives an exact mint or address. Reports a simulated fill, fee and risk verdict. Uses only the original message and the owner\'s pinned PAPER mandate. Never predicts returns. Ambiguous tickers are refused. Call with no arguments.',
  category: 'READ', effect: 'READ', risk: 'LOW', unsetPermission: 'DISABLED',
  input: z.object({}).strict(), output: Result, modelCallable: true, timeoutMs: 90_000,
  async run(_input, ctx) {
    const message = await incoming(ctx);
    if (!message) return refusal('Only a direct incoming request can ask for a paper trade.');
    const claim = await socialPaper.claim(ctx.agentId, message.key);
    if (!claim.claimed) {
      const previous = Result.safeParse(claim.result);
      return previous.success ? previous.data : refusal('This request is already claimed. Its journal must be checked before anything else is simulated.', 'REQUEST_PENDING', 'PENDING');
    }
    let settled: Result | null = null;
    const finish = (result: Result) => { settled = result; return result; };
    const uncertain = () => refusal('This simulation needs owner review before a receipt can be sent.', 'REQUEST_PENDING', 'PENDING');
    try {
      const request = parseSocialPaperRequest(message.text);
      if (!request) return finish(refusal('Ask for one paper long with a ticker, mint or address. Extra instructions and multiple assets are refused.'));

      // Fresh persistent settings at admission and at the fill boundary. A menu
      // assembled before revocation grants nothing here.
      const settings = (await capabilityPermissions.listForAgent(ctx.agentId)).find((p) => p.capability_id === 'paper.trade');
      if (settings?.permission !== 'ALLOWED' || (await pauseState()).paused) return finish(refusal('Paper trading is not enabled for this agent, or everything is paused.', 'SOCIAL_PAPER_REVOKED'));
      const parsed = SocialPaperConfig.safeParse(settings.config);
      if (!parsed.success) return finish(refusal('The owner must configure a pinned PAPER mandate, venue, quote asset and maximum size.'));
      const config = parsed.data;
      const mandate = await trading.liveMandate(ctx.agentId);
      if (!isSocialPaperMandate(mandate, config.mandateId, ctx.agentId)) return finish(refusal('The pinned mandate must be current, owner-authored, PAPER and owner-approved, with no protective exits. Studio modes are not inherited.'));
      const maxIn = request.amount ?? config.maxInBase;
      if (BigInt(maxIn) <= 0n || BigInt(maxIn) > BigInt(config.maxInBase) || BigInt(maxIn) > BigInt(mandate.maxPerTrade)) return finish(refusal('The requested size exceeds the owner\'s paper ceiling or is not positive.', 'SIZE_ABOVE_MANDATE'));
      const reference = parseTokenReference(request.token);
      const namedChain = request.token.match(/\son\s+([A-Za-z]+)$/i)?.[1];
      if (namedChain) reference.chain = normaliseChain(namedChain);
      if (reference.chain && !mandate.networks.includes(reference.chain)) return finish(refusal('The requested chain is not supported by this paper mandate.', 'NETWORK_NOT_ALLOWED'));
      // Infinite dominance prevents the resolver's liquidity heuristic choosing
      // between two contracts. Paper requires one identity rather than a guess.
      const resolved = await resolveToken(reference, { dominanceRatio: Infinity });
      if (resolved.status !== 'RESOLVED' || !resolved.facts) return finish(refusal(resolved.status === 'AMBIGUOUS' ? 'That ticker is ambiguous. Give one exact mint or address.' : `Could not resolve that token: ${resolved.how}.`));
      const facts = resolved.facts;
      const sameAddress = (a: string, b: string) => facts.chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();
      if ((reference.address && !sameAddress(reference.address, facts.contract)) || (reference.chain && reference.chain !== facts.chain)) return finish(refusal('The resolved asset differs from the asset named in the message.'));
      let asset: Asset | undefined = mandate.allowedAssets.find((a) => a.kind === 'ONCHAIN' && a.network === facts.chain && sameAddress(a.address, facts.contract));
      if (!asset && mandate.assetScope === 'ANY_SOLANA_TOKEN' && facts.chain === 'solana') {
        try { asset = await readPoolAsset('solana', facts.contract) ?? undefined; }
        catch { return finish(refusal('The token metadata could not be read, so its amount cannot be simulated.', 'NO_MARKET', 'NO_MARKET')); }
      }
      if (!asset) return finish(refusal('This token is not in the owner\'s paper mandate, or its exact decimals are unavailable.', 'ASSET_NOT_ALLOWED'));
      const limits = async (): Promise<RiskReason | null> => {
        const fills = await trading.paperFillsOf(ctx.agentId);
        const quoteKey = assetKey(config.quoteAsset);
        const today = new Date().toISOString().slice(0, 10);
        const spent = fills.filter((f) => f.side === 'BUY' && assetKey(f.assetIn) === quoteKey && f.recordedAt.slice(0, 10) === today)
          .reduce((sum, f) => sum + BigInt(f.inBase), 0n);
        if (spent + BigInt(maxIn) > BigInt(config.maxPerDayBase) || spent + BigInt(maxIn) > BigInt(mandate.maxPerDay)) return { code: 'PAPER_DAILY_LIMIT', detail: 'The paper daily amount ceiling would be exceeded.' };
        if (await socialPaper.requesterFillsToday(ctx.agentId, message.requester) >= config.maxRequestsPerRequesterPerDay) return { code: 'PAPER_REQUESTER_LIMIT', detail: 'This requester has reached the daily paper fill limit.' };
        const positions = paperPositions(fills).filter((p) => BigInt(p.quantityBase) > 0n);
        const sameQuote = positions.filter((p) => assetKey(p.quote) === quoteKey);
        const exposure = sameQuote.reduce((sum, p) => sum + BigInt(p.costBase), 0n);
        if (exposure + BigInt(maxIn) > BigInt(mandate.maxOpenExposure)) return { code: 'PAPER_EXPOSURE_LIMIT', detail: 'The open paper cost would exceed the mandate ceiling.' };
        if (!sameQuote.some((p) => assetKey(p.asset) === assetKey(asset)) && positions.length >= mandate.maxOpenPositions) return { code: 'PAPER_POSITION_LIMIT', detail: 'The mandate allows no additional open paper position.' };
        return null;
      };
      const limit = await limits();
      if (limit) return finish(refusal(limit.detail, limit.code));
      const guard = async (): Promise<string | RiskReason | null> => {
        if (ctx.signal.aborted) return 'This paper request timed out before its fill.';
        const latest = (await capabilityPermissions.listForAgent(ctx.agentId)).find((p) => p.capability_id === 'paper.trade');
        if (latest?.permission !== 'ALLOWED' || JSON.stringify(latest.config) !== JSON.stringify(settings.config) || (await pauseState()).paused) return 'Paper permission or its owner configuration changed before execution.';
        // runPaperTrade calls this inside the journal lock immediately before
        // recording the fill, so overlapping requests cannot spend the same cap.
        return limits();
      };
      const outcome = await runPaperTrade({
        agentId: ctx.agentId, venue: config.venue, side: 'BUY', assetIn: config.quoteAsset, assetOut: asset, subject: asset,
        maxIn, maxSlippageBps: mandate.maxSlippageBps, maxPriceImpactBps: mandate.maxPriceImpactBps, maxFeeBase: mandate.maxFeeBase,
        idempotencyKey: `social-paper:${ctx.agentId}:${message.key}`, requirePaperMandateId: config.mandateId, beforeFill: guard,
      });
      return finish(report(outcome, asset, config.quoteAsset));
    } catch {
      // A throw could follow a committed fill. Never claim it was refused or
      // expose an internal error; settle uncertainty and require review.
      return finish(uncertain());
    } finally {
      await socialPaper.complete(ctx.agentId, message.key, settled ?? uncertain());
    }
  },
});

export const PAPER_CAPABILITIES = [paperTrade] as unknown as AnyCapability[];
export function registerPaperCapabilities(): void { for (const capability of PAPER_CAPABILITIES) registerCapability(capability); }

/** A financial receipt is rendered from the record, never rewritten as a claim. */
export function paperReplyFromSteps(steps: { capabilityId: string; outcome: string; detail: string; output: unknown }[]): string | null {
  const paper = steps.filter((s) => s.capabilityId === 'paper.trade');
  let recorded: Result | null = null;
  for (const step of paper) {
    const result = Result.safeParse(step.output);
    if (result.success && result.data.outcome === 'PENDING') throw pendingReview();
    if (!result.success && ['FAILED', 'TIMED_OUT'].includes(step.outcome)) throw pendingReview();
    if (result.success && result.data.outcome === 'FILLED') return result.data.reply;
    if (result.success) recorded = result.data;
  }
  const last = paper.at(-1);
  return recorded?.reply ?? (last ? refusal(last.detail).reply : null);
}

export async function paperReplyForJob(jobId: string): Promise<string | null> {
  const request = await socialPaper.requestForJob(jobId);
  if (request) {
    const result = Result.safeParse(request.result);
    if (!result.success || result.data.outcome === 'PENDING') throw pendingReview();
    return result.data.reply;
  }
  return paperReplyFromSteps(await capabilityInvocations.listForJob(jobId));
}

function pendingReview() {
  return PipelineError.review('paper_request_pending', 'Review this paper simulation in the journal before sending any receipt.');
}
