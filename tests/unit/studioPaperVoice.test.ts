import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PaperRecord, PolicyConfig } from '@xbam/shared/contracts';
import {
  PAPER_IDEA_SOURCE,
  checkPaperRecordAtSend,
  checkPaperRecordText,
  describePaperRecord,
  paperIdeaFrom,
} from '../../packages/runtime/src/studioPaperVoice';
import { unpromptedSubject } from '../../packages/runtime/src/reticence';
import { tradedRecord } from '../support/paperStudioServer';

const ORIGIN = 'https://studio.example.invalid';
const record = (overrides: Record<string, unknown> = {}): PaperRecord => PaperRecord.parse(tradedRecord('7d', ORIGIN, overrides));

const NO_TRADES = {
  state: 'NO_TRADES',
  totals: { trades: 0, closed_trades: 0, winning_trades: 0, losing_trades: 0, net_pnl_usd: '0', return_pct: null, max_drawdown_pct: null },
  open_positions: { count: 0, treatment: 'EXCLUDED', note: 'Nothing was open.' },
  decisions: [],
};
const MISSING = { state: 'MISSING', reason: 'No paper agent was running', totals: null, costs: null, open_positions: null, decisions: [] };

describe('the contract is an allowlist', () => {
  it('refuses fields Studio was never meant to publish, at any depth', () => {
    for (const extra of [{ owner_email: 'a@b.invalid' }, { wallet_address: '0x1' }, { system_prompt: 'x' }, { live_balance: '1' }]) {
      expect(PaperRecord.safeParse(tradedRecord('7d', ORIGIN, extra)).success, JSON.stringify(extra)).toBe(false);
    }
    const base = tradedRecord('7d', ORIGIN);
    expect(PaperRecord.safeParse({ ...base, costs: { ...(base.costs as object), private_guidance: 'x' } }).success).toBe(false);
    expect(PaperRecord.safeParse({ ...base, decisions: [{ ...(base.decisions as object[])[0], prompt: 'x' }] }).success).toBe(false);
  });

  it('refuses a record that is not simulated, money as a float, and inconsistent states', () => {
    expect(PaperRecord.safeParse(tradedRecord('7d', ORIGIN, { simulated: false })).success).toBe(false);
    const base = tradedRecord('7d', ORIGIN);
    expect(PaperRecord.safeParse({ ...base, totals: { ...(base.totals as object), net_pnl_usd: -42.5 } }).success).toBe(false);
    expect(PaperRecord.safeParse(tradedRecord('7d', ORIGIN, { ...MISSING, totals: base.totals })).success).toBe(false);
    expect(PaperRecord.safeParse(tradedRecord('7d', ORIGIN, { ...NO_TRADES, state: 'TRADED' })).success).toBe(false);
    expect(PaperRecord.safeParse(tradedRecord('7d', ORIGIN, { totals: { ...(base.totals as object), winning_trades: 9, losing_trades: 9 } })).success).toBe(false);
  });
});

describe('what the agent says when asked', () => {
  it('reports a loss as a loss, with Studio, simulated, paper, dates, costs and open positions', () => {
    const said = describePaperRecord(record());
    expect(said.outcome).toBe('LOSS');
    expect(said.statement).toMatch(/^According to Studio, simulated paper trading for \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d made 12 paper trades/);
    expect(said.statement).toMatch(/net loss of 42\.50 USD \(-4\.25%\), all simulated/);
    expect(said.statement).toMatch(/Assumed costs: 30 bps in fees and 50 bps of slippage/);
    expect(said.statement).toMatch(/2 positions were still open and marked to market/);
    expect(said.statement).not.toMatch(/gain|profit/);
  });

  it('reports a gain and a flat result without decoration', () => {
    const base = tradedRecord('7d', ORIGIN).totals as object;
    expect(describePaperRecord(record({ totals: { ...base, net_pnl_usd: '10.00' } })).statement).toMatch(/net gain of 10\.00 USD/);
    const flat = describePaperRecord(record({ totals: { ...base, net_pnl_usd: '0.00' } }));
    expect(flat.outcome).toBe('FLAT');
    expect(flat.statement).toMatch(/net result of zero/);
  });

  it('has no outcome for no trades or a missing window', () => {
    const none = describePaperRecord(record(NO_TRADES));
    expect(none.outcome).toBeNull();
    expect(none.statement).toMatch(/According to Studio/);
    expect(none.statement).toMatch(/no trades/);
    const missing = describePaperRecord(record({ ...MISSING, window: { ...(tradedRecord('7d', ORIGIN).window as object), complete: false } }));
    expect(missing.outcome).toBeNull();
    expect(missing.statement).toMatch(/no simulated paper record/);
    expect(missing.statement).toMatch(/No paper agent was running\. I will not guess/);
  });
});

describe('a public post', () => {
  it('is off by default, in both switches', () => {
    expect(DEFAULT_POLICY.studio.postPaperRecord).toBe(false);
    expect(DEFAULT_POLICY.studio.postPaperPnl).toBe(false);
    expect(PolicyConfig.parse({}).studio).toEqual({ postPaperRecord: false, postPaperPnl: false, paperRecordWindow: '7d', postTraderDna: false, traderDnaStudyId: null, postLeagueSeason: false });
  });

  it('is only made from a finished window that had trades', () => {
    expect(paperIdeaFrom(record(NO_TRADES), { allowPnl: true })).toBeNull();
    expect(paperIdeaFrom(record(MISSING), { allowPnl: true })).toBeNull();
    expect(paperIdeaFrom(record({ window: { ...(tradedRecord('7d', ORIGIN).window as object), complete: false } }), { allowPnl: true })).toBeNull();
    expect(paperIdeaFrom(record(), { allowPnl: false })).not.toBeNull();
  });

  it('says nothing about how the trades did unless the owner allowed it', () => {
    const idea = paperIdeaFrom(record(), { allowPnl: false })!;
    expect(idea.summary).not.toMatch(/gain|loss|lost|\bwon\b|\bwin(s|ning)?\b|%|\$|\d\.\d\d/i);
    expect(idea.summary).toMatch(/simulated paper record/);
    expect(idea.summary).toMatch(/12 paper trades/);
    expect(idea.detail).toMatch(/give no profit, loss, return or win count/);
    expect(checkPaperRecordText(idea.summary, { allowPnl: false })).toEqual([]);

    const withPnl = paperIdeaFrom(record(), { allowPnl: true })!;
    expect(withPnl.summary).toMatch(/Net simulated loss: 42\.50 USD/);
    expect(withPnl.detail).toMatch(/stated as plainly as a gain/);
  });

  it('passes the reticence check, which the proposal also runs on every idea', () => {
    for (const allowPnl of [true, false]) {
      const idea = paperIdeaFrom(record(), { allowPnl })!;
      expect(unpromptedSubject(`${idea.summary} ${idea.detail}`)).toBeNull();
    }
  });

  it('keeps the dates and the window end it will not propose twice', () => {
    const one = record();
    const idea = paperIdeaFrom(one, { allowPnl: false })!;
    expect(idea.summary).toMatch(/\d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/);
    expect(idea.windowEnd).toBe(one.window.end);
  });
});

describe('the check on the finished text', () => {
  const good = "Studio's simulated paper record, 2026-11-02 to 2026-11-09: 12 paper trades, assumed 30 bps fees and 50 bps slippage. Nothing live.";

  it('accepts a post that says simulated, paper and Studio', () => {
    expect(checkPaperRecordText(good, { allowPnl: false })).toEqual([]);
  });

  it('asks for the words that stop it reading as performance', () => {
    expect(checkPaperRecordText('12 trades this week, 30 bps fees.', { allowPnl: false })).toHaveLength(3);
    expect(checkPaperRecordText('Simulated paper trades this week, 12 of them.', { allowPnl: false })).toEqual([
      'It does not attribute the figures to AI17Z Studio.',
    ]);
  });

  it('refuses a promise, a signal, advice and a live position', () => {
    for (const text of [
      `${good} It will keep making money.`,
      `${good} Treat it as a signal.`,
      `${good} Not financial advice.`,
      `${good} Copy my trades.`,
      `${good} Guaranteed to continue.`,
      `${good} My live positions agree.`,
      `${good} Real money trades next.`,
    ]) {
      expect(checkPaperRecordText(text, { allowPnl: true }), text).not.toEqual([]);
    }
  });

  it('refuses money outcomes only while the owner has not allowed them', () => {
    const pnl = `${good} Net loss of 42.50 USD, 6 winning of 10.`;
    expect(checkPaperRecordText(pnl, { allowPnl: false }).join(' ')).toMatch(/states how the trades did/);
    expect(checkPaperRecordText(pnl, { allowPnl: true })).toEqual([]);
    expect(checkPaperRecordText(`${good} Down 4% on the week.`, { allowPnl: false })).not.toEqual([]);
    // An apostrophe in "won't" is not a win.
    expect(checkPaperRecordText(`${good} This won't tell you much.`, { allowPnl: false })).toEqual([]);
  });

  it('is applied to posts made from the record and to nothing else', () => {
    const policy = PolicyConfig.parse({ studio: { postPaperRecord: true } });
    const raw = { origin: 'self', ideaSource: PAPER_IDEA_SOURCE };
    expect(() => checkPaperRecordAtSend({ raw, text: good, policy })).not.toThrow();
    expect(() => checkPaperRecordAtSend({ raw, text: 'Great week.', policy })).toThrow(/needs the owner/);
    // An ordinary post is not read by these rules.
    expect(() => checkPaperRecordAtSend({ raw: { origin: 'self', ideaSource: 'deliberation' }, text: 'Great week.', policy })).not.toThrow();
    expect(() => checkPaperRecordAtSend({ raw: null, text: 'Great week.', policy })).not.toThrow();
  });

  it('stops for good when the owner switched posting off after the idea was made', () => {
    const off = PolicyConfig.parse({});
    const raw = { origin: 'self', ideaSource: PAPER_IDEA_SOURCE };
    try {
      checkPaperRecordAtSend({ raw, text: good, policy: off });
      throw new Error('should have thrown');
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/switched off/);
      expect((error as { retryable?: boolean }).retryable ?? false).toBe(false);
    }
  });

  it('reads the policy as it is at sending, so PnL switched off since the idea was made is honoured', () => {
    const policy = PolicyConfig.parse({ studio: { postPaperRecord: true, postPaperPnl: false } });
    const raw = { origin: 'self', ideaSource: PAPER_IDEA_SOURCE };
    expect(() => checkPaperRecordAtSend({ raw, text: `${good} Net loss of 42.50 USD.`, policy })).toThrow(/needs the owner/);
  });
});
