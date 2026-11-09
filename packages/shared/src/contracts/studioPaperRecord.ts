import { z } from 'zod';

/**
 * The paper track record AI17Z Studio publishes about an owner's own
 * simulated trading, as this installation reads it.
 *
 * The endpoint is specified in `docs/architecture/STUDIO_PAPER_RECORD.md`. This
 * file is the allowlist: every object is `.strict()`, so a field Studio was
 * never meant to publish (an account identity, a linked wallet, a prompt, a
 * private guidance note, a live balance) is a refusal of the whole record, not
 * a field quietly ignored. A client that drops what it did not expect would
 * also drop the evidence that the server had started sending it.
 *
 * Money is a decimal string. A float turns `0.1 + 0.2` into a figure an agent
 * then repeats in public.
 */

export const PAPER_RECORD_WINDOWS = ['7d', '30d', '90d'] as const;
export const PaperRecordWindow = z.enum(PAPER_RECORD_WINDOWS);
export type PaperRecordWindow = (typeof PAPER_RECORD_WINDOWS)[number];

/** How Studio treated positions still open when the window ended. */
export const PAPER_OPEN_POSITION_TREATMENTS = ['MARKED_TO_MARKET', 'EXCLUDED', 'CLOSED_AT_WINDOW_END'] as const;

const Decimal = z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/, 'a plain decimal number');
const Count = z.number().int().min(0).max(10_000_000);
const Instant = z.iso.datetime();
const Sentence = z.string().max(240);

export const PaperRecordWindowFacts = z
  .object({
    label: PaperRecordWindow,
    start: Instant,
    end: Instant,
    /** False while the window is still running. A partial window is never published as a result. */
    complete: z.boolean(),
  })
  .strict();

export const PaperRecordTotals = z
  .object({
    trades: Count,
    closed_trades: Count,
    winning_trades: Count,
    losing_trades: Count,
    net_pnl_usd: Decimal,
    /** Null when Studio states no base to measure a return against. */
    return_pct: Decimal.nullable(),
    max_drawdown_pct: Decimal.nullable(),
  })
  .strict();

export const PaperRecordCosts = z
  .object({
    fee_bps: z.number().min(0).max(10_000),
    slippage_bps: z.number().min(0).max(10_000),
    note: Sentence,
  })
  .strict();

export const PaperRecordOpenPositions = z
  .object({
    count: Count,
    treatment: z.enum(PAPER_OPEN_POSITION_TREATMENTS),
    note: Sentence,
  })
  .strict();

export const PaperRecordDecision = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    at: Instant,
    /** Sanitized by Studio: no prompt, no private guidance. */
    summary: Sentence,
    /** A page on Studio itself. The client refuses any other origin. */
    url: z.url().max(300),
  })
  .strict();

export const PaperRecordStates = ['TRADED', 'NO_TRADES', 'MISSING'] as const;

export const PaperRecord = z
  .object({
    protocol: z.literal(1),
    /** Literal, so a record that says it is not simulated is refused rather than relayed. */
    simulated: z.literal(true),
    source: z.literal('ai17z-studio'),
    generated_at: Instant,
    window: PaperRecordWindowFacts,
    state: z.enum(PaperRecordStates),
    /** Why a window is missing, in a sentence. */
    reason: Sentence.nullable(),
    totals: PaperRecordTotals.nullable(),
    costs: PaperRecordCosts.nullable(),
    open_positions: PaperRecordOpenPositions.nullable(),
    decisions: z.array(PaperRecordDecision).max(20),
  })
  .strict()
  .superRefine((record, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (record.state === 'MISSING') {
      if (record.totals || record.costs || record.open_positions || record.decisions.length > 0) {
        fail('A missing window carries no figures.');
      }
      return;
    }
    if (!record.totals || !record.costs || !record.open_positions) {
      fail('A window with a record states its totals, its cost assumptions and how open positions were treated.');
      return;
    }
    if (record.state === 'NO_TRADES' && record.totals.trades !== 0) fail('A window with no trades has a trade count of zero.');
    if (record.state === 'TRADED' && record.totals.trades === 0) fail('A window with trades has a trade count above zero.');
    if (record.totals.winning_trades + record.totals.losing_trades > record.totals.closed_trades) {
      fail('More winning and losing trades than closed trades.');
    }
    if (record.totals.closed_trades > record.totals.trades) fail('More closed trades than trades.');
    if (Date.parse(record.window.end) < Date.parse(record.window.start)) fail('The window ends before it starts.');
  });
export type PaperRecord = z.infer<typeof PaperRecord>;
