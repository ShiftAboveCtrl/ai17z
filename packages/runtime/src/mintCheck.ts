import { z } from 'zod';
import {
  capabilityInvocations,
  jobs as jobsRepo,
  mintChecks,
  notifications as notificationsRepo,
  observability,
  radar,
} from '@xbam/database';
import { createLogger, PipelineError } from '@xbam/shared';
import type { ResolvedContext } from '@xbam/shared/contracts';
import { invokeCapability } from '@xbam/tools';
import { EVM_CHAINS, type EvmChain } from '@xbam/upstream';

import { capabilitySettings } from './capabilityPermissions';
import { readTemperature } from './engagement';
import { pauseState } from './killSwitch';
import type { JobBundle } from './loadJob';
import { readPromo } from './promo';
import { unpromptedSubject } from './reticence';
import { parseTokenReference, tokenAddressesIn } from './token';

const log = createLogger('mint-check');

/**
 * "@agent check <mint>": a sourced reading of one contract, with no verdict.
 *
 * ### What this is allowed to say
 *
 * Attributes of a contract, each with who reported it and when it was read, and
 * what could not be read, said plainly as "unavailable". It never says a token
 * is safe, a rug, worth buying or going anywhere. The hardest way for this to
 * go wrong is a clean card that reads as an all clear, so the layout is fixed
 * text rather than model prose, every card ends by saying it is not a verdict,
 * and a reading that is missing or old is written as missing or old, never as
 * a nought and never as nothing.
 *
 * ### How it rides the pipeline
 *
 * Detection and the early stops happen in the engagement step, so a request is
 * judged by the same exchange limits, pitch rule and strategy as any other
 * message. The reading happens in the research step. The text is then carried
 * through generate, validate, voice and execute unchanged, the way a paper
 * receipt is: a model never rewrites a financial or safety statement.
 *
 * ### What it never does
 *
 * It never speaks first, never creates a watch from anybody's text, holds no
 * wallet and offers no trade. A watch is pinned only by the owner confirming it
 * on one of their own surfaces: see `confirmMintWatch`.
 */

/** A reading older than this is not shown as current. */
export const MINT_READ_MAX_AGE_MS = 10 * 60_000;
/** An index entry that has not been refreshed for this long is shown as old. */
export const INDEX_ENTRY_MAX_AGE_MS = 6 * 3_600_000;

export type RefusalReason = 'MANY' | 'TICKER' | 'NEEDS_CHAIN' | 'PAIR_LINK';

export type MintRequest =
  | { kind: 'ONE'; chain: 'solana' | EvmChain; address: string }
  | { kind: 'REFUSE'; why: RefusalReason };

/** The only words that turn a message containing an address into a request. */
const ASKS_FOR_A_CHECK = /\b(?:check|scan|inspect|audit|vet|verify)\b|\b(?:rug|rugged|scam|legit|honeypot)\b/i;

/** Chain names people type, mapped to the ones the evidence reads know. */
const EVM_NAME: Record<string, EvmChain> = { bsc: 'bnb', bnb: 'bnb' };

function evmChainOf(named: string | null): EvmChain | null {
  if (!named) return null;
  const mapped = EVM_NAME[named] ?? named;
  return mapped in EVM_CHAINS ? (mapped as EvmChain) : null;
}

/**
 * Whether a message is asking for a check, and of what.
 *
 * Deterministic, and refuses rather than guesses: two addresses, a bare ticker,
 * an EVM address with no chain and a link to a pair are each a one-sentence
 * refusal, because answering about the wrong contract is worse than asking.
 */
export function detectMintRequest(text: string | null | undefined): MintRequest | null {
  const clean = text ?? '';
  if (!ASKS_FOR_A_CHECK.test(clean.replace(/@[A-Za-z0-9_]+/g, ' '))) return null;

  const reference = parseTokenReference(clean);
  const addresses = tokenAddressesIn(clean);
  if (addresses.length > 1) return { kind: 'REFUSE', why: 'MANY' };
  if (addresses.length === 0) {
    if (reference.pairAddress) return { kind: 'REFUSE', why: 'PAIR_LINK' };
    if (reference.symbol) return { kind: 'REFUSE', why: 'TICKER' };
    return null;
  }
  const address = addresses[0]!;
  if (!address.startsWith('0x')) return { kind: 'ONE', chain: 'solana', address };
  const chain = evmChainOf(reference.chain);
  return chain ? { kind: 'ONE', chain, address } : { kind: 'REFUSE', why: 'NEEDS_CHAIN' };
}

const REFUSALS: Record<RefusalReason, string> = {
  MANY: 'I read one token at a time, so send a single address.',
  TICKER: 'A ticker can belong to many tokens, so send the exact address and I will read it.',
  NEEDS_CHAIN: 'I need the chain for that 0x address, for example base or ethereum.',
  PAIR_LINK: 'That link points at a trading pair, so send the token address itself.',
};

export function refusalSentence(why: RefusalReason): string {
  return REFUSALS[why];
}

export function pointerSentence(input: { askedAt: string; url: string | null; now?: number; allowLink: boolean }): string {
  const minutes = Math.max(1, Math.round(((input.now ?? Date.now()) - Date.parse(input.askedAt)) / 60_000));
  const where = input.allowLink && input.url ? `the evidence card is here: ${input.url}` : 'the evidence card is in my earlier reply';
  return `Already read that address ${minutes} min ago, ${where}.`;
}

/* --------------------------------------------------------------- evidence */

export interface EvidenceLine {
  label: string;
  /** Null means this reading was not reported, and is written as unavailable. */
  value: string | null;
  source: string;
  /** When the reading was taken. */
  at: string;
  /** Lowest priority is dropped first when the card does not fit. */
  priority: number;
}

export type MintEvidence =
  | { state: 'READ'; lines: EvidenceLine[] }
  | { state: 'NOT_INDEXED'; source: string; at: string }
  | { state: 'UNAVAILABLE'; source: string; at: string; reason: string };

const Provenance = z.looseObject({ source: z.string(), readAt: z.string() });
const SolanaProfileOut = z.looseObject({
  found: z.boolean(),
  token: z
    .looseObject({
      liquidityUsd: z.number().nullable(),
      topHoldersPct: z.number().nullable(),
      mintAuthorityDisabled: z.boolean().nullable(),
      freezeAuthorityDisabled: z.boolean().nullable(),
      firstPoolAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  provenance: Provenance,
});

const Observation = z.object({ what: z.string(), detail: z.string(), source: z.string(), kind: z.enum(['FACT', 'FLAG']) });
const RiskOut = z.looseObject({ observations: z.array(Observation), notChecked: z.array(z.string()), sourcesAnswering: z.number() });

const usd = (value: number): string =>
  value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}`;

function ageSentence(iso: string, now: number): string | null {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days === 0) return 'today';
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function sourceName(upstreamId: string): string {
  return /jupiter/i.test(upstreamId) ? 'Jupiter' : upstreamId.split('.').pop() ?? upstreamId;
}

/** A reading too old to call current is shown as such, not as a number. */
function tooOld(readAt: string, now: number): boolean {
  const age = now - Date.parse(readAt);
  return !Number.isFinite(age) || age > MINT_READ_MAX_AGE_MS || age < -60_000;
}

export function evidenceFromSolanaProfile(output: unknown, now = Date.now()): MintEvidence {
  const parsed = SolanaProfileOut.safeParse(output);
  if (!parsed.success) return { state: 'UNAVAILABLE', source: 'Jupiter', at: new Date(now).toISOString(), reason: 'the answer was not in a shape I can read' };
  const { found, token, provenance } = parsed.data;
  const source = sourceName(provenance.source);
  if (tooOld(provenance.readAt, now)) {
    return { state: 'UNAVAILABLE', source, at: new Date(now).toISOString(), reason: 'the reading is too old to show as current' };
  }
  if (!found || !token) return { state: 'NOT_INDEXED', source, at: provenance.readAt };

  // An entry the index has not touched lately may describe a token that is
  // quiet or gone. Its figures are shown as old rather than presented as now.
  const entryOld = token.updatedAt !== null && now - Date.parse(token.updatedAt) > INDEX_ENTRY_MAX_AGE_MS;
  const line = (label: string, value: string | null, priority: number): EvidenceLine => ({ label, value, source, at: provenance.readAt, priority });
  const authority = (disabled: boolean | null) => (disabled === null ? null : disabled ? 'disabled' : 'still set');
  const firstPool = token.firstPoolAt ? ageSentence(token.firstPoolAt, now) : null;

  return {
    state: 'READ',
    lines: [
      line('Liquidity', token.liquidityUsd === null || entryOld ? null : usd(token.liquidityUsd), 5),
      line('Top holders', token.topHoldersPct === null || entryOld ? null : `${Number(token.topHoldersPct.toFixed(1))}% of supply`, 4),
      line('Mint authority', authority(token.mintAuthorityDisabled), 5),
      line('Freeze authority', authority(token.freezeAuthorityDisabled), 4),
      line('First pool', firstPool, 1),
    ],
  };
}

/**
 * The EVM reading, from what `token.inspect_risk` reported.
 *
 * That capability lists an attribute only when a source raised or stated it, and
 * lists what nobody checked by name. So absence from both lists is a reading of
 * "no", presence in `notChecked` is "unavailable", and nothing is inferred
 * beyond that. Sell and buy are never written, only the exit and entry of a
 * position, because the card does not use the vocabulary of a trade.
 */
export function evidenceFromRiskInspect(output: unknown, fetchedAt: string, now = Date.now()): MintEvidence {
  const parsed = RiskOut.safeParse(output);
  if (!parsed.success) return { state: 'UNAVAILABLE', source: 'analysis', at: new Date(now).toISOString(), reason: 'the answer was not in a shape I can read' };
  const { observations, notChecked, sourcesAnswering } = parsed.data;
  if (sourcesAnswering === 0) {
    return { state: 'UNAVAILABLE', source: 'analysis', at: fetchedAt, reason: 'no security source answered' };
  }
  if (tooOld(fetchedAt, now)) {
    return { state: 'UNAVAILABLE', source: 'analysis', at: new Date(now).toISOString(), reason: 'the reading is too old to show as current' };
  }
  const find = (what: string) => observations.find((o) => o.what === what);
  const unchecked = (what: string) => notChecked.some((n) => n.startsWith(what));
  const line = (label: string, value: string | null, source: string, priority: number): EvidenceLine => ({ label, value, source, at: fetchedAt, priority });
  const flagged = (what: string, yes: string, no: string, source: string, label: string, priority: number) =>
    line(label, unchecked(what) ? null : find(what) ? yes : no, source, priority);

  // Short names for the two kinds of source, so five readings with their source
  // and time fit the limit a post has. They are the capability's own words.
  const short = (source: string) => (source === 'trade simulation' ? 'simulation' : source === 'contract analysis' ? 'analysis' : source);
  const exitTax = find('Sell tax') ?? find('Sell tax, simulated');
  const exitTest = find('Could be sold again');
  return {
    state: 'READ',
    lines: [
      line('Holders', find('Holders')?.detail ?? null, 'analysis', 3),
      line('Creator holds', find('Held by the creator')?.detail ?? null, 'analysis', 4),
      flagged('More can be minted', 'can be increased', 'cannot be increased', 'analysis', 'Supply', 5),
      line('Exit tax', exitTax?.detail ?? null, short(exitTax?.source ?? 'contract analysis'), 4),
      line('Exit test', exitTest ? (exitTest.kind === 'FLAG' ? 'failed in simulation' : 'passed in simulation') : null, 'simulation', 5),
    ],
  };
}

/* ------------------------------------------------------------------- card */

const HEADER = 'Evidence:';
/** On every card of every kind, so no layout can read as an all clear. */
const FOOTER = 'Not a verdict. Reads can be wrong or late.';

const clock = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'time unknown' : `${at.toISOString().slice(11, 16)}Z`;
};

/**
 * The card, as fixed text.
 *
 * When it does not fit the output limit the lowest-priority readings are left
 * out and the card says how many, rather than shortening a line into something
 * that reads differently.
 */
export function renderMintCard(evidence: MintEvidence, maxCharacters: number): string {
  if (evidence.state === 'NOT_INDEXED') {
    return `Not found in the token index (${evidence.source} ${clock(evidence.at)}). That says nothing about the token either way. ${FOOTER}`;
  }
  if (evidence.state === 'UNAVAILABLE') {
    return `Evidence unavailable right now: ${evidence.reason} (${evidence.source} ${clock(evidence.at)}). Try again shortly. ${FOOTER}`;
  }
  const render = (lines: EvidenceLine[], left: number): string =>
    [
      HEADER,
      ...lines.map((l) => `${l.label}: ${l.value ?? 'unavailable'} (${l.source} ${clock(l.at)})`),
      ...(left > 0 ? [`${left} more left out for length.`] : []),
      FOOTER,
    ].join('\n');

  let kept = evidence.lines;
  let text = render(kept, 0);
  while (text.length > maxCharacters && kept.length > 1) {
    const dropped = [...kept].sort((a, b) => a.priority - b.priority)[0]!;
    kept = kept.filter((l) => l !== dropped);
    text = render(kept, evidence.lines.length - kept.length);
  }
  return text;
}

/**
 * Words the card, a pointer or a refusal must never contain.
 *
 * The register of a call, a price or a clearance. A disclaimer beside one does
 * not undo it, so the text is refused instead. Mirrors the radar's publication
 * rule, and adds the verdict words that rule leaves to its fixed templates.
 */
const BANNED =
  /\b(?:safe|safer|safest|safety|unsafe|secure|rug(?:s|ged)?|rug[ -]?proof|rug[ -]?pull(?:ed)?|scam(?:s|med)?|legit|honest|trust\w*|buy\w*|bought|sell\w*|sold|ape|aping|invest\w*|accumulate|long|short|bullish|bearish|moon\w*|pump\w*|dump\w*|gem|prices?|profits?|returns?|forecast\w*|predict\w*|guaranteed|risk[ -]?free|[1-9]\d{0,3}x)\b|\$[A-Za-z]/i;

/** Why this text may not be published as a mint check, or null when it may. */
export function mintCardRefusal(text: string): string | null {
  // A link is an address, not wording: a handle that happens to spell a word on
  // the list does not make the sentence around it a call.
  const hit = BANNED.exec(text.replace(/https?:\/\/\S+/g, ' '));
  if (hit) return `The card contains "${hit[0]}", which is the register of a verdict or a call. Evidence cards state readings and nothing else.`;
  if (unpromptedSubject(text)) return 'The card touches a subject this agent does not raise.';
  if (readPromo(text).level !== 'none') return 'The card reads as a promotion.';
  return null;
}

/* ------------------------------------------------------------- the stages */

export interface MintMeta {
  request: MintRequest;
  outcome?: 'CARD' | 'POINTER' | 'REFUSED';
  reply?: string;
  requestId?: string | null;
}

export function mintMetaOf(context: ResolvedContext | null | undefined): MintMeta | null {
  const meta = (context?.meta as { mintCheck?: MintMeta } | undefined)?.mintCheck;
  return meta && typeof meta === 'object' && meta.request ? meta : null;
}

/** The exact text this job must publish, or null when it is not a mint check. */
export function mintReplyOf(context: ResolvedContext | null | undefined): string | null {
  return mintMetaOf(context)?.reply ?? null;
}

const EVENTS_THAT_ADDRESS_THE_AGENT = new Set(['MENTION', 'REPLY']);

export function askerKeyOf(bundle: Pick<JobBundle, 'job' | 'event'>): string {
  return `${bundle.job.channel}:${bundle.event.remoteAuthorId ?? bundle.event.remoteAuthorHandle ?? 'unknown'}`;
}

const evidenceCapabilityFor = (request: Extract<MintRequest, { kind: 'ONE' }>) =>
  request.chain === 'solana' ? 'token.solana_profile' : 'token.inspect_risk';

export type MintPlan = { kind: 'NONE' } | { kind: 'REQUEST'; request: MintRequest } | { kind: 'IGNORE'; reason: string };

/**
 * Decides, in the engagement step, whether this message is a mint check and
 * whether it may be answered at all.
 *
 * Stops come first and are sentences: a pitch is declined, an asker who has
 * used their hour is not answered again, and an evidence capability the owner
 * switched off is respected. A hostile message is not a request, so the
 * ordinary pipeline meets it with a deflection.
 */
export async function planMintCheck(
  bundle: JobBundle,
  input: { text: string; unprompted: boolean },
): Promise<MintPlan> {
  const config = bundle.policy.tools.mintCheck;
  if (!config.enabled) return { kind: 'NONE' };
  // Never speaks first: only a message addressed to the agent can ask.
  if (input.unprompted || !EVENTS_THAT_ADDRESS_THE_AGENT.has(bundle.event.type)) return { kind: 'NONE' };

  const request = detectMintRequest(input.text);
  if (!request) return { kind: 'NONE' };
  if (readTemperature(input.text) === 'hostile') return { kind: 'NONE' };

  const pitch = readPromo(input.text);
  if (pitch.level === 'strong') {
    return { kind: 'IGNORE', reason: `It reads as a token pitch (${pitch.signals.join(', ')}), so no card is written for it.` };
  }

  if (request.kind === 'ONE') {
    const needed = evidenceCapabilityFor(request);
    const settings = await capabilitySettings(bundle.agent.id).catch(() => null);
    if (settings?.permissions.get(needed) === 'DISABLED') {
      return { kind: 'IGNORE', reason: `${needed} is switched off for this agent, so there is nothing to read the card from.` };
    }
  }

  const used = await mintChecks.askerCountSince(bundle.agent.id, askerKeyOf(bundle), 3_600_000);
  if (used >= config.maxPerAskerPerHour) {
    return {
      kind: 'IGNORE',
      reason: `They have already asked for ${used} checks in the last hour, which is this agent's limit for one person.`,
    };
  }
  return { kind: 'REQUEST', request };
}

async function readEvidence(bundle: JobBundle, request: Extract<MintRequest, { kind: 'ONE' }>): Promise<MintEvidence> {
  const id = evidenceCapabilityFor(request);
  const settings = await capabilitySettings(bundle.agent.id).catch(() => null);
  const paused = (await pauseState().catch(() => ({ paused: false }))).paused;
  const input = request.chain === 'solana' ? { mint: request.address } : { chain: request.chain, address: request.address };

  const result = await invokeCapability({
    call: { id, input },
    context: { agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId, config: {}, logger: log },
    permission: { stored: settings?.permissions.get(id) ?? null, paused },
  });
  const fetchedAt = new Date().toISOString();

  // Recorded like any capability call, so "what did it read for that card" has
  // an answer in the audit trail. A failed write does not lose the card.
  await capabilityInvocations
    .recordInvocation({
      agentId: bundle.agent.id,
      jobId: bundle.job.id,
      accountId: bundle.job.accountId,
      capabilityId: id,
      step: 0,
      outcome: result.outcome,
      detail: result.detail,
      input: result.input,
      output: result.output,
      durationMs: result.durationMs,
    })
    .catch(() => undefined);

  if (result.outcome !== 'SUCCEEDED' || !result.output) {
    const source = request.chain === 'solana' ? 'Jupiter' : 'analysis';
    return { state: 'UNAVAILABLE', source, at: fetchedAt, reason: 'the source did not answer' };
  }
  return request.chain === 'solana' ? evidenceFromSolanaProfile(result.output) : evidenceFromRiskInspect(result.output, fetchedAt);
}

async function remember(bundle: JobBundle, meta: MintMeta): Promise<void> {
  const context = bundle.job.resolvedContext;
  if (!context) return;
  const next = { ...context, meta: { ...context.meta, mintCheck: meta } };
  await jobsRepo.updateJob(bundle.job.id, { resolvedContext: next });
  bundle.job.resolvedContext = next;
}

/**
 * Reads the evidence and fixes the reply. Returns false when this job is not a
 * mint check, so the research step carries on as usual.
 *
 * A retried job finds its reply already fixed and does nothing, and the claim
 * is keyed on the job, so a retry cannot take a second place in the limits.
 * A rehearsal takes no place at all: it must not use up an asker's hour or
 * turn the real question, an hour later, into a pointer.
 */
export async function stepMintCheck(bundle: JobBundle): Promise<boolean> {
  const meta = mintMetaOf(bundle.job.resolvedContext);
  if (!meta) return false;
  if (meta.reply) return true;

  const { job, policy } = bundle;
  const request = meta.request;
  let outcome: NonNullable<MintMeta['outcome']> = request.kind === 'ONE' ? 'CARD' : 'REFUSED';
  let requestId: string | null = null;
  let pointer: { askedAt: string; url: string | null } | null = null;

  if (!job.dryRun) {
    const claim = await mintChecks.claim({
      agentId: bundle.agent.id,
      jobId: job.id,
      channel: job.channel,
      askerKey: askerKeyOf(bundle),
      askerHandle: bundle.event.remoteAuthorHandle ?? null,
      mint: request.kind === 'ONE' ? request.address : null,
      chain: request.kind === 'ONE' ? request.chain : null,
      askerCap: policy.tools.mintCheck.maxPerAskerPerHour,
      cooldownMs: policy.tools.mintCheck.mintCooldownSeconds * 1000,
    });
    if (claim.capped) {
      // Two requests passed the early check together and this one lost. Nothing
      // is sent, and the reason is on the job.
      throw PipelineError.permanent('mint_check_asker_capped', 'They reached the hourly limit for evidence checks while this was queued.');
    }
    outcome = claim.row.outcome;
    requestId = claim.row.id;
    pointer = claim.pointer;
  }

  let reply: string;
  if (request.kind === 'REFUSE') {
    reply = refusalSentence(request.why);
  } else if (outcome === 'POINTER' && pointer) {
    reply = pointerSentence({ askedAt: pointer.askedAt, url: pointer.url, allowLink: !policy.output.forbidLinks });
  } else {
    reply = renderMintCard(await readEvidence(bundle, request), policy.output.maxCharacters);
  }

  const refusal = mintCardRefusal(reply);
  if (refusal) throw PipelineError.review('mint_card_refused', refusal);

  await remember(bundle, { request, outcome, reply, requestId });
  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'RESEARCH_DONE',
    message: `Mint check: ${outcome.toLowerCase()} for ${request.kind === 'ONE' ? `${request.chain} ${request.address.slice(0, 6)}...${request.address.slice(-4)}` : `a refused request (${request.why.toLowerCase()})`}.`,
    data: { mintCheck: true, outcome, requestId, rehearsal: job.dryRun },
  });

  if (outcome === 'CARD' && requestId && request.kind === 'ONE') {
    await offerWatch(bundle, requestId, request).catch((error: unknown) => {
      log.warn('could not tell the owner about a mint check', { jobId: job.id, error: String(error) });
    });
  }
  return true;
}

/**
 * Tells the owner a card went out and how to pin a watch on it.
 *
 * This only informs. The watch is created by `confirmMintWatch`, which runs
 * from the owner's own paired chat and from nowhere that handles other
 * people's words.
 */
async function offerWatch(bundle: JobBundle, requestId: string, request: Extract<MintRequest, { kind: 'ONE' }>): Promise<void> {
  const short = `${request.address.slice(0, 6)}...${request.address.slice(-4)}`;
  const id = requestId.slice(0, 8);
  await notificationsRepo.raise({
    kind: 'MINT_CHECK_ANSWERED',
    severity: 'INFO',
    agentId: bundle.agent.id,
    accountId: bundle.job.accountId,
    title: 'Your agent answered a request to check a mint',
    body:
      `@${bundle.event.remoteAuthorHandle ?? 'someone'} asked about ${request.chain} ${short} and received an evidence card with no verdict. ` +
      (request.chain === 'solana'
        ? `To watch it for new pools, confirm with /watch ${id} in Telegram. Nothing is watched until you do.`
        : 'Watches read Solana mints only, so there is nothing to confirm for this one.'),
    data: { requestId, chain: request.chain },
    dedupeKey: `mint-check:${requestId}`,
  });
}

/* --------------------------------------------------- the owner's confirm */

export type WatchOutcome = { ok: true; sentence: string } | { ok: false; sentence: string };

/** Cards waiting on the owner, as short ids they can type. */
export async function listWatchable(): Promise<{ id: string; mint: string; chain: string; asker: string | null }[]> {
  const cards = await mintChecks.undecidedCards(null, 8);
  return cards.map((c) => ({ id: c.id.slice(0, 8), mint: c.mint!, chain: c.chain ?? 'solana', asker: c.askerHandle }));
}

/**
 * Pins a watch on the mint a card was about, because the owner said to.
 *
 * Callable only from the owner's paired Telegram chat. It is the single writer
 * of a mint-check watch, and a test fails if anything else calls it. The watch
 * is context only (`mayTrigger: false`): it never creates a post, and it reads
 * through the radar's own Solana path and its own limits.
 */
export async function confirmMintWatch(idPrefix: string): Promise<WatchOutcome> {
  const prefix = idPrefix.trim().toLowerCase();
  if (prefix.length < 4) return { ok: false, sentence: 'Give me at least four characters of the id.' };
  const matches = (await mintChecks.undecidedCards(null, 50)).filter((c) => c.id.toLowerCase().startsWith(prefix));
  if (matches.length === 0) return { ok: false, sentence: 'No card is waiting under that id.' };
  if (matches.length > 1) return { ok: false, sentence: `That matches ${matches.length} cards. Type a few more characters.` };

  const card = matches[0]!;
  if (card.chain !== 'solana' || !card.mint) {
    return { ok: false, sentence: 'Watches read Solana mints only, so nothing was pinned.' };
  }
  const job = await jobsRepo.getJob(card.jobId);
  if (!job?.accountId) {
    return { ok: false, sentence: 'That request came in without an account, so there is nowhere to pin a watch.' };
  }

  await radar.upsertSource({
    accountId: job.accountId,
    kind: 'market_signal',
    target: `mint-check:${card.mint}`,
    label: `Mint check watch ${card.mint.slice(0, 6)}...${card.mint.slice(-4)}`,
    enabled: true,
    config: {
      intervalSeconds: 300,
      limit: 1,
      mayTrigger: false,
      priority: 40,
      watches: [{ chain: 'solana', address: card.mint, predicate: 'new_pool' }],
    },
  });
  await mintChecks.markWatching(card.id);
  return {
    ok: true,
    sentence: `Watching ${card.mint.slice(0, 6)}...${card.mint.slice(-4)} for new pools. It is context only and never posts. Add liquidity or holder limits in the Radar.`,
  };
}
