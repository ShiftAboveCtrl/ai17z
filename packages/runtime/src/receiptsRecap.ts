import { z } from 'zod';
import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import type { PolicyConfig, SignalObservation, SignalWatch } from '@xbam/shared/contracts';
import { agents as agentsRepo, content as contentRepo, ops, query } from '@xbam/database';
import { unpromptedSubject } from './reticence';

const log = createLogger('receipts-recap');

/**
 * A weekly recap of what the signal radar published, and what its own stated
 * reading did a day later.
 *
 * ## What it is
 *
 * Every published radar signal in the window is listed, none left out, with the
 * reading it stated, the reading taken 24 hours later, and the source and time of
 * each. Counts only: how many were posted, how many got a later reading, and how
 * many of those readings changed or stayed the same. It never states a win rate,
 * a profit or loss, a "best" or "worst", or an order by outcome. Rows are in the
 * order they were posted.
 *
 * ## What it is built from
 *
 * Only signals that were actually published: an executed POST that is not a dry
 * run and not a rehearsal. A draft, a held job and a rehearsal leave no row,
 * however far they got. A signal whose 24 hour follow-up was never read (skipped,
 * still waiting, upstream down) is still counted and is shown as having no
 * reading, because dropping it would make the week look better measured than it was.
 *
 * ## Off by default
 *
 * `studio.postReceiptsRecap` lets the agent put one recap into the idea backlog,
 * once a week, through every gate any other post passes. `studio.receiptsRecapImage`
 * additionally asks the linked Studio for a picture of it. Without Studio, or with
 * the picture off, the post is the same text.
 */

export const RECAP_IDEA_SOURCE = 'receipts_recap';
export const RECAP_DISCLAIMER = 'counts and readings only, not a verdict';
export const RECAP_WINDOW_DAYS = 7;
/** More rows than a picture can carry stays a text recap, with every one still counted. */
export const RECAP_IMAGE_MAX_ROWS = 24;
const DAY = 86_400_000;

export type RecapReadingState = 'changed' | 'unchanged' | 'unavailable' | 'not_read';

export interface RecapReading {
  value: number | string | null;
  source: string | null;
  observed_at: string | null;
}

export interface RecapRow {
  chain: string;
  address: string;
  predicate: string;
  posted_at: string;
  at_post: RecapReading;
  after_24h: RecapReading & { state: RecapReadingState };
}

export interface Recap {
  window: { start: string; end: string };
  /** Every published radar signal in the window. */
  n: number;
  readings_taken: number;
  changed: number;
  unchanged: number;
  /** Signals whose 24 hour reading was missing, stale or never taken. */
  without_reading: number;
  rows: RecapRow[];
}

type ReceiptRow = {
  executed_at: string | Date;
  status: string;
  verdict: 'changed' | 'unchanged' | 'unavailable' | null;
  evidence: { watch: SignalWatch; after: SignalObservation };
  now_read: SignalObservation | null;
};

const iso = (value: string | Date) => new Date(value).toISOString();
const day = (value: string) => value.slice(0, 10);

function readingOf(observation: SignalObservation | null | undefined): RecapReading {
  if (!observation) return { value: null, source: null, observed_at: null };
  const value = observation.value;
  const shown = typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' ? value.slice(0, 100)
      : value === null || value === undefined ? null : JSON.stringify(value).slice(0, 100);
  const source = (observation.reads?.[0]?.source ?? observation.source ?? '').slice(0, 80);
  const at = observation.observedAt && Number.isFinite(Date.parse(observation.observedAt)) ? new Date(observation.observedAt).toISOString() : null;
  return { value: shown, source: /^[a-z0-9_.-]+$/.test(source) ? source : null, observed_at: at };
}

/** Pure: the recap for a set of published receipts. Every row is kept; the order is the order posted. */
export function recapFrom(rows: ReceiptRow[], window: { start: Date; end: Date }): Recap {
  const sorted = [...rows].sort((a, b) => Date.parse(iso(a.executed_at)) - Date.parse(iso(b.executed_at)));
  const out: RecapRow[] = sorted.map((r) => {
    const taken = r.now_read !== null && (r.verdict === 'changed' || r.verdict === 'unchanged');
    return {
      chain: r.evidence.watch.chain,
      address: r.evidence.watch.address,
      predicate: r.evidence.watch.predicate,
      posted_at: iso(r.executed_at),
      at_post: readingOf(r.evidence.after),
      after_24h: { ...(taken ? readingOf(r.now_read) : { value: null, source: null, observed_at: null }),
        state: taken ? r.verdict as 'changed' | 'unchanged' : r.verdict === 'unavailable' ? 'unavailable' : 'not_read' },
    };
  });
  const changed = out.filter((r) => r.after_24h.state === 'changed').length;
  const unchanged = out.filter((r) => r.after_24h.state === 'unchanged').length;
  return {
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    n: out.length, readings_taken: changed + unchanged, changed, unchanged,
    without_reading: out.length - changed - unchanged, rows: out,
  };
}

/** The deterministic text of a recap: what the post says if nothing else is written. */
export function recapText(recap: Recap): string {
  const span = `${day(recap.window.start)} to ${day(recap.window.end)} UTC`;
  const signals = recap.n === 1 ? 'radar signal' : 'radar signals';
  return `Radar receipts, ${span}: n = ${recap.n} ${signals} posted. 24h readings taken: ${recap.readings_taken} (changed ${recap.changed}, unchanged ${recap.unchanged}); no reading: ${recap.without_reading}. Every published signal in the window is counted. ${RECAP_DISCLAIMER}.`;
}

/** Published signals in the window with their 24 hour follow-up, if there is one. Drafts, dry runs and rehearsals are not rows. */
export async function publishedReceipts(agentId: string, window: { start: Date; end: Date }): Promise<ReceiptRow[]> {
  return query<ReceiptRow>(`SELECT a.executed_at, r.status, r.verdict, r.evidence, r.now_read
    FROM signal_receipts r JOIN actions a ON a.id=r.action_id JOIN jobs j ON j.id=a.job_id JOIN events e ON e.id=j.event_id
    WHERE a.agent_id=$1 AND r.window_hours=24 AND a.type='POST' AND a.status='EXECUTED' AND NOT a.dry_run
      AND COALESCE(e.payload->>'rehearsal','false') <> 'true' AND e.payload->>'ideaSource'='market_signal'
      AND a.executed_at >= $2 AND a.executed_at < $3
    ORDER BY a.executed_at`, [agentId, window.start, window.end]);
}

// ---------------------------------------------------------------------------
// The frozen picture request. Fixture: tests/fixtures/studioReceiptsRecapImage.json
// ---------------------------------------------------------------------------

/** Same family as the evidence card picture: DPoP transport, linked Studio only, no host parameter. */
export const RECEIPTS_RECAP_IMAGE_PATH = '/api/v1/installation/receipts-recap-image';

const Iso = z.string().max(40).refine((v) => Number.isFinite(Date.parse(v)), 'not a timestamp');
const Source = z.string().regex(/^[a-z0-9_.-]{1,80}$/);
const Value = z.union([z.number(), z.string().max(100)]).nullable();
const ReadingWire = z.strictObject({ value: Value, source: Source.nullable(), observed_at: Iso.nullable() });
const RowWire = z.strictObject({
  chain: z.enum(['solana', 'ethereum', 'robinhood']),
  address: z.string().max(64),
  predicate: z.string().regex(/^[a-z_]{1,40}$/),
  posted_at: Iso,
  at_post: ReadingWire,
  after_24h: z.strictObject({ value: Value, source: Source.nullable(), observed_at: Iso.nullable(), state: z.enum(['changed', 'unchanged', 'unavailable', 'not_read']) }),
});

export const ReceiptsRecapImageRequest = z.strictObject({
  protocol: z.literal(1),
  window: z.strictObject({ start: Iso, end: Iso }),
  n: z.number().int().nonnegative().max(1000),
  readings_taken: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  without_reading: z.number().int().nonnegative(),
  rows: z.array(RowWire).min(1).max(RECAP_IMAGE_MAX_ROWS),
  disclaimer: z.literal(RECAP_DISCLAIMER),
  requested_at: Iso,
}).superRefine((card, ctx) => {
  if (card.rows.length !== card.n) ctx.addIssue({ code: 'custom', path: ['rows'], message: 'every counted signal is a row' });
  if (card.changed + card.unchanged !== card.readings_taken || card.readings_taken + card.without_reading !== card.n) {
    ctx.addIssue({ code: 'custom', path: ['n'], message: 'counts do not add up' });
  }
});
export type ReceiptsRecapImageRequest = z.infer<typeof ReceiptsRecapImageRequest>;

/** Pure: the frozen payload for a recap, or null when it is not one a picture can carry. */
export function receiptsRecapImagePayload(recap: Recap, now: Date = new Date()): ReceiptsRecapImageRequest | null {
  const parsed = ReceiptsRecapImageRequest.safeParse({
    protocol: 1, window: recap.window, n: recap.n, readings_taken: recap.readings_taken, changed: recap.changed,
    unchanged: recap.unchanged, without_reading: recap.without_reading, rows: recap.rows,
    disclaimer: RECAP_DISCLAIMER, requested_at: now.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Proposing the post
// ---------------------------------------------------------------------------

/** Stored per idea so the picture and the send check use the exact figures the idea was written from. */
export const recapKey = (ideaId: string) => `studio.receipts_recap.idea.${ideaId}`;
const memoKey = (agentId: string) => `studio.receipts_recap.proposed.${agentId}`;

export function recapRules(): string {
  return [
    'Say this is a count of radar signals this agent published and what the stated reading was 24 hours later. Give the dates and write n = followed by the count exactly as above.',
    'Use only the figures above. Do not round them, add to them or compare them with anything.',
    'Do not give a win rate, hit rate, profit, loss, return or ranking, and do not call any signal best, worst, right or wrong.',
    'Do not say or suggest what will happen next. A small sample is said plainly as n = a number.',
    'Do not write any link.',
  ].join('\n');
}

export async function proposeReceiptsRecap(agentId: string, now: Date = new Date()): Promise<{ proposed: boolean; why: string }> {
  try {
    const policy = await agentsRepo.getActivePolicy(agentId);
    if (!policy?.config.studio.postReceiptsRecap) return { proposed: false, why: 'Posting the receipts recap is off.' };
    const memo = await ops.getSetting<{ proposedAt: string }>(memoKey(agentId));
    if (memo && now.getTime() - Date.parse(memo.proposedAt) < RECAP_WINDOW_DAYS * DAY) return { proposed: false, why: 'This week was already proposed.' };

    const window = { start: new Date(now.getTime() - RECAP_WINDOW_DAYS * DAY), end: now };
    const recap = recapFrom(await publishedReceipts(agentId, window), window);
    // A week with nothing published is not news, so nothing is announced.
    if (recap.n === 0) return { proposed: false, why: 'No radar signal was published in the window.' };
    const summary = recapText(recap);
    const reticent = unpromptedSubject(summary);
    if (reticent) return { proposed: false, why: `Not raised unprompted: ${reticent.subject}.` };
    if (await contentRepo.similarExists(agentId, summary)) return { proposed: false, why: 'The backlog already holds this.' };
    const idea = await contentRepo.addIdea({ agentId, kind: 'observation', summary, detail: recapRules(), source: RECAP_IDEA_SOURCE,
      sourceHandle: null, sourceJobId: null, score: 60 });
    await ops.setSetting(recapKey(idea.id), recap);
    await ops.setSetting(memoKey(agentId), { proposedAt: now.toISOString() });
    return { proposed: true, why: 'The weekly receipts recap was added to the idea backlog.' };
  } catch (error) {
    // Optional work: it must never stop the posting engine from doing everything else.
    log.warn('receipts recap proposal failed', { agentId, message: errorMessage(error) });
    return { proposed: false, why: 'The recap could not be built just now.' };
  }
}

// ---------------------------------------------------------------------------
// The check on the finished text
// ---------------------------------------------------------------------------

const OUTCOME_WORDS = /\b(win rate|hit rate|win(s|ning)?|won|los(s|es|ing|t)|profit\w*|pnl|p&l|returns?|roi|gains?|gained|best|worst|top|bottom|right|wrong|accura\w+|beat|beats|outperform\w*|guarantee\w*)\b|[$€£]\s?\d|\d\s?%|\b(buy|sell)\b/i;

/** Problems with the finished text of a recap post, as sentences. */
export function checkRecapText(text: string, recap: Recap): string[] {
  const problems: string[] = [];
  if (!new RegExp(`\\bn\\s*=\\s*${recap.n}\\b`).test(text)) problems.push(`It does not state the sample size as n = ${recap.n}.`);
  if (!text.includes(day(recap.window.start)) || !text.includes(day(recap.window.end))) problems.push('It does not give the window dates.');
  if (OUTCOME_WORDS.test(text)) problems.push('It states or implies an outcome, a rate or a ranking.');
  if (/\bhttps?:\/\//i.test(text)) problems.push('It contains a link.');
  return problems;
}

/** The last word at the moment of sending, read again from the current policy. */
export async function checkReceiptsRecapAtSend(input: { raw: unknown; text: string; policy: PolicyConfig }): Promise<Recap | null> {
  const raw = (input.raw ?? {}) as { ideaSource?: unknown; ideaId?: unknown };
  if (raw.ideaSource !== RECAP_IDEA_SOURCE) return null;
  if (!input.policy.studio.postReceiptsRecap) {
    throw PipelineError.permanent('receipts_recap_posting_off', 'Posting the receipts recap was switched off after this post was written, so it was not sent.');
  }
  const recap = typeof raw.ideaId === 'string' ? await ops.getSetting<Recap>(recapKey(raw.ideaId)) : null;
  if (!recap) throw PipelineError.permanent('receipts_recap_missing', 'The receipts behind this recap are missing, so it was not sent.');
  const problems = checkRecapText(input.text, recap);
  if (problems.length > 0) throw PipelineError.review('receipts_recap_text', `This receipts recap needs the owner: ${problems.join(' ')}`);
  return recap;
}
