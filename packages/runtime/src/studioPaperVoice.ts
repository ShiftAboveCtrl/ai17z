import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import type { PaperRecord, PolicyConfig } from '@xbam/shared/contracts';
import { agents as agentsRepo, content as contentRepo, ops } from '@xbam/database';
import { capabilityPermissions } from './capabilityPermissions';
import { unpromptedSubject } from './reticence';
import { studioPaperRecord } from './studioLink';

const log = createLogger('studio-paper-voice');

/**
 * The agent speaking its owner's paper track record.
 *
 * Two surfaces share the words in this file and nothing else. Owner chat reads
 * the record through the `studio.paper_record` capability and may show every
 * figure, because the owner is the audience. A public post is a separate
 * opt-in (`policy.studio.postPaperRecord`), and states profit or loss only if a
 * second one allows it (`policy.studio.postPaperPnl`). Both are off.
 *
 * ## How a post is made, and what is not new
 *
 * Nothing here publishes. A complete window becomes an idea in `content_ideas`
 * with source `studio_paper_record`, and the posting engine takes it from
 * there: the schedule decides when, the post is written by the agent's own
 * voice, and it goes through the identity policy, the validator, the post
 * quality gate and the account's rate limits like every other post. Reticence
 * is asked here about the idea, because this is an agent choosing a subject for
 * itself. `checkPaperRecordAtSend` then reads the finished text, the last
 * thing that writes text being the last thing that checks it.
 *
 * ## What a post may never do
 *
 * Say anything but that it is simulated paper trading reported by Studio, give
 * dates, imply a future return, call itself a signal or advice, or imply a live
 * position or real money. Those are enforced on the finished text below and
 * asked for in the brief above; a model asked nicely is not a guarantee.
 */

/** The `content_ideas.source` and the event's `ideaSource` for a post made from the record. */
export const PAPER_IDEA_SOURCE = 'studio_paper_record';

const CAPABILITY_ID = 'studio.paper_record';
/** How often one agent asks Studio whether there is a new window to post about. */
const CHECK_EVERY_MS = 6 * 3_600_000;
const day = (iso: string) => iso.slice(0, 10);

/** The sentence a reader needs about open positions, from what Studio stated. */
export function openPositionSentence(record: PaperRecord): string {
  const open = record.open_positions;
  if (!open) return '';
  const n = open.count === 1 ? '1 position was' : `${open.count} positions were`;
  if (open.count === 0) return 'No positions were open at the end of the window.';
  switch (open.treatment) {
    case 'MARKED_TO_MARKET':
      return `${n} still open and marked to market at the end of the window.`;
    case 'EXCLUDED':
      return `${n} still open and left out of the totals.`;
    case 'CLOSED_AT_WINDOW_END':
      return `${n} still open and counted as closed at the end of the window.`;
  }
}

export function costSentence(record: PaperRecord): string {
  const costs = record.costs;
  if (!costs) return '';
  return `Assumed costs: ${costs.fee_bps} bps in fees and ${costs.slippage_bps} bps of slippage.`;
}

/** Plain direction of a decimal string. Studio sends strings, so this never touches a float's rounding for display. */
export function directionOf(decimal: string): 'GAIN' | 'LOSS' | 'FLAT' {
  const n = Number(decimal);
  return n > 0 ? 'GAIN' : n < 0 ? 'LOSS' : 'FLAT';
}

function windowWords(record: PaperRecord): string {
  const { start, end, complete } = record.window;
  return complete ? `${day(start)} to ${day(end)}` : `${day(start)} to ${day(end)} (the window is still running)`;
}

/**
 * What owner chat may say, every number attributed to Studio and every
 * sentence saying simulated and paper. Never a fabricated win: a window with
 * no trades, a loss, or no record each says exactly that.
 */
export function describePaperRecord(record: PaperRecord): { outcome: 'GAIN' | 'LOSS' | 'FLAT' | null; statement: string } {
  if (record.state === 'MISSING') {
    return {
      outcome: null,
      statement: `Studio has no simulated paper record for ${windowWords(record)}${record.reason ? `: ${record.reason.replace(/\.?$/, '.')}` : '.'} I will not guess at one.`,
    };
  }
  const totals = record.totals!;
  if (record.state === 'NO_TRADES') {
    return {
      outcome: null,
      statement: `According to Studio, the simulated paper trading for ${windowWords(record)} made no trades. ${costSentence(record)} ${openPositionSentence(record)}`.trim(),
    };
  }
  const outcome = directionOf(totals.net_pnl_usd);
  const magnitude = totals.net_pnl_usd.replace(/^-/, '');
  const result =
    outcome === 'GAIN'
      ? `a net gain of ${magnitude} USD`
      : outcome === 'LOSS'
        ? `a net loss of ${magnitude} USD`
        : 'a net result of zero';
  const base = totals.return_pct === null ? '' : ` (${totals.return_pct}%)`;
  const drawdown = totals.max_drawdown_pct === null ? '' : ` Largest drawdown: ${totals.max_drawdown_pct}%.`;
  return {
    outcome,
    statement: [
      `According to Studio, simulated paper trading for ${windowWords(record)} made ${totals.trades} paper ${totals.trades === 1 ? 'trade' : 'trades'}`,
      `(${totals.closed_trades} closed: ${totals.winning_trades} winning, ${totals.losing_trades} losing), with ${result}${base}, all simulated.${drawdown}`,
      costSentence(record),
      openPositionSentence(record),
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

// ---------------------------------------------------------------------------
// A public post, from the idea backlog
// ---------------------------------------------------------------------------

export interface PaperIdea {
  summary: string;
  detail: string;
  /** The window's end, which is what stops one window being proposed twice. */
  windowEnd: string;
}

/**
 * The idea a complete window makes, or nothing.
 *
 * Silence is the usual answer. A missing window, a window still running and a
 * window with no trades are all things Studio and owner chat can say when
 * asked; none of them is something to announce.
 */
export function paperIdeaFrom(record: PaperRecord, options: { allowPnl: boolean }): PaperIdea | null {
  if (record.state !== 'TRADED' || !record.window.complete) return null;
  const totals = record.totals!;
  const from = day(record.window.start);
  const to = day(record.window.end);

  const lines = [
    `Studio's simulated paper record, ${from} to ${to}: ${totals.trades} paper ${totals.trades === 1 ? 'trade' : 'trades'}.`,
    costSentence(record),
    openPositionSentence(record),
  ];
  if (options.allowPnl) {
    const outcome = directionOf(totals.net_pnl_usd);
    const magnitude = totals.net_pnl_usd.replace(/^-/, '');
    lines.splice(
      1,
      0,
      outcome === 'FLAT'
        ? 'Net simulated result: zero.'
        : `Net simulated ${outcome === 'GAIN' ? 'gain' : 'loss'}: ${magnitude} USD, ${totals.winning_trades} winning and ${totals.losing_trades} losing of ${totals.closed_trades} closed.`,
    );
  }
  const summary = lines.filter(Boolean).join(' ').slice(0, 500);

  const rules = [
    'Say that this is simulated paper trading and that the figures come from AI17Z Studio. Give the dates.',
    'Use only the figures above. Do not round them up, add to them or compare them with anything.',
    'Do not say or suggest what will happen next, and do not call it a signal, a recommendation or advice.',
    'No money moved and no position is live. Do not imply otherwise.',
    options.allowPnl
      ? 'A loss is stated as plainly as a gain.'
      : 'Do not say whether the trades made or lost money, and give no profit, loss, return or win count.',
  ];
  return { summary, detail: rules.join('\n'), windowEnd: record.window.end };
}

interface ProposalMemo {
  checkedAt: string;
  windowEnd: string | null;
  /** When a window was last proposed, or found already proposed. */
  proposedAt: string | null;
}

const WINDOW_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
const memoKey = (agentId: string) => `studio.paper_record.proposed.${agentId}`;

export interface ProposalOutcome {
  proposed: boolean;
  why: string;
}

/**
 * Looks for a complete window worth a post and, if there is one, puts it in the
 * idea backlog. Called by the posting engine when it comes due, so the schedule
 * stays what decides when anything is said.
 *
 * Needs all of: the owner's opt-in, the capability not switched off for this
 * agent (the same switch that governs reading Studio on its behalf), a linked
 * Studio that answers now, and a window nobody has proposed yet. Anything else
 * is a sentence and no idea.
 */
export async function proposePaperRecordPost(agentId: string, now: Date = new Date()): Promise<ProposalOutcome> {
  try {
    const policy = await agentsRepo.getActivePolicy(agentId);
    const studio = policy?.config.studio;
    if (!studio?.postPaperRecord) return { proposed: false, why: 'Posting the paper record is off.' };

    const permission = (await capabilityPermissions(agentId)).get(CAPABILITY_ID);
    if (permission === undefined || permission === 'DISABLED') {
      return { proposed: false, why: 'Reading the Studio paper record is switched off for this agent.' };
    }

    const memo = await ops.getSetting<ProposalMemo>(memoKey(agentId));
    if (memo && now.getTime() - Date.parse(memo.checkedAt) < CHECK_EVERY_MS) {
      return { proposed: false, why: 'Studio was asked recently.' };
    }
    /*
      One post per period, not one per reading. A rolling window ends "now", so
      its end moves every time it is read and cannot be what stops a repeat; the
      length of the window can. A seven day window is proposed at most once in
      seven days, whatever Studio's clock says about where it ends.
    */
    const period = WINDOW_DAYS[studio.paperRecordWindow] * 86_400_000;
    if (memo?.proposedAt && now.getTime() - Date.parse(memo.proposedAt) < period) {
      return { proposed: false, why: 'This period was already proposed.' };
    }
    const remember = (windowEnd: string | null, proposed = false) =>
      ops.setSetting(memoKey(agentId), {
        checkedAt: now.toISOString(),
        windowEnd: windowEnd ?? memo?.windowEnd ?? null,
        proposedAt: proposed ? now.toISOString() : (memo?.proposedAt ?? null),
      } satisfies ProposalMemo);

    const read = await studioPaperRecord(studio.paperRecordWindow, now);
    if (!read.ok) {
      await remember(null);
      return { proposed: false, why: read.why };
    }
    const idea = paperIdeaFrom(read.record, { allowPnl: studio.postPaperPnl });
    if (!idea) {
      await remember(null);
      return { proposed: false, why: 'There is no complete window with trades to post about.' };
    }
    if (memo?.windowEnd === idea.windowEnd) {
      await remember(null);
      return { proposed: false, why: 'That window was already proposed.' };
    }

    // The one gate on an agent choosing its own subject, as for any idea.
    const reticent = unpromptedSubject(`${idea.summary} ${idea.detail}`);
    if (reticent) {
      await remember(idea.windowEnd, true);
      return { proposed: false, why: `Not raised unprompted: ${reticent.subject}.` };
    }
    if (await contentRepo.similarExists(agentId, idea.summary)) {
      await remember(idea.windowEnd, true);
      return { proposed: false, why: 'The backlog already holds this.' };
    }

    await contentRepo.addIdea({
      agentId,
      kind: 'observation',
      summary: idea.summary,
      detail: idea.detail,
      source: PAPER_IDEA_SOURCE,
      sourceHandle: null,
      sourceJobId: null,
      // Above the decayed ordinary idea, because a window is only news for a few days.
      score: 60,
    });
    await remember(idea.windowEnd, true);
    log.info('paper record idea added', { agentId, windowEnd: idea.windowEnd });
    return { proposed: true, why: 'A complete paper window was added to the idea backlog.' };
  } catch (error) {
    // Posting about a record is optional; a failure here must never stop the
    // posting engine from doing everything else it was about to do.
    log.warn('paper record proposal failed', { agentId, message: errorMessage(error) });
    return { proposed: false, why: 'Studio could not be asked just now.' };
  }
}

// ---------------------------------------------------------------------------
// The check on the finished text
// ---------------------------------------------------------------------------

export const FORWARD_LOOKING =
  /\b(guarantee[sd]?|will (keep|continue|make|earn|return|print|pay)|expect(s|ed)? (to )?(earn|return|profit|gain|make)|going to (the moon|print|pump)|signals?|financial advice|investment advice|nfa|buy now|follow (my|these|the) trades|copy (my|these|the) trades|alpha)\b/i;
export const LIVE_OR_REAL = /\b(live (position|trade|trading|account)s?|real[- ]money (trade|position)s?|my (real )?(wallet|funds|capital))\b/i;
const MONEY_FIGURE = /[$€£]\s?\d|\d\s?%|\b(pnl|p&l|profit\w*|loss(es)?|lost|gains?|gained|returns?|drawdowns?|wins?|won(?!['’]t)|winning|losing)\b|\b(up|down)\s+\d/i;

/**
 * Problems with the finished text of a post made from the paper record, as
 * sentences. Empty when there are none.
 */
export function checkPaperRecordText(text: string, options: { allowPnl: boolean }): string[] {
  const problems: string[] = [];
  if (!/\bsimulated\b/i.test(text)) problems.push('It does not say the trading was simulated.');
  if (!/\bpaper\b/i.test(text)) problems.push('It does not say this is paper trading.');
  if (!/\bstudio\b/i.test(text)) problems.push('It does not attribute the figures to AI17Z Studio.');
  if (FORWARD_LOOKING.test(text)) problems.push('It reads as a promise, a signal or advice about what comes next.');
  if (LIVE_OR_REAL.test(text)) problems.push('It implies a live position or real money.');
  if (!options.allowPnl && MONEY_FIGURE.test(text)) problems.push('It states how the trades did, which the owner has not allowed in public posts.');
  return problems;
}

/**
 * The last word on a post made from the record, at the moment of sending.
 *
 * The owner can switch posting off, or switch PnL off, between the idea and the
 * send; a job can also wait behind an approval for a long time. So the policy
 * is read again here, and the finished text, including text an owner edited in
 * the review queue, is checked by the rules above.
 */
export function checkPaperRecordAtSend(input: { raw: unknown; text: string; policy: PolicyConfig }): void {
  const raw = (input.raw ?? {}) as { ideaSource?: unknown };
  if (raw.ideaSource !== PAPER_IDEA_SOURCE) return;

  if (!input.policy.studio.postPaperRecord) {
    throw PipelineError.permanent(
      'paper_record_posting_off',
      'Posting the paper record was switched off after this post was written, so it was not sent.',
    );
  }
  const problems = checkPaperRecordText(input.text, { allowPnl: input.policy.studio.postPaperPnl });
  if (problems.length > 0) {
    throw PipelineError.review('paper_record_text', `This post about the paper record needs the owner: ${problems.join(' ')}`);
  }
}
