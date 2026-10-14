import { describe, expect, it } from 'vitest';
import { TRADE_INTENT_STATUSES } from '@xbam/shared/contracts';
import { studioStatusOf } from '../../packages/runtime/src/studioLiveTrades';

/**
 * What Studio is told about a real trade, from the trade's own state here.
 * Every state is named, so a new one cannot quietly report nothing, and none
 * that has not reached the chain is ever told to Studio as sent.
 */
describe('a local trade as Studio hears it', () => {
  it('names every state, and only a sent trade reads as sent', () => {
    const told = Object.fromEntries(TRADE_INTENT_STATUSES.map((s) => [s, studioStatusOf(s)]));
    expect(told).toEqual({
      DRAFTED: null,
      RISK_REJECTED: 'REFUSED',
      AWAITING_APPROVAL: 'PREPARED',
      APPROVED: 'APPROVED',
      SIMULATED: null,
      SIGNED: 'APPROVED',
      SUBMITTED: 'SUBMITTED',
      UNKNOWN: 'SUBMITTED',
      CONFIRMED: 'CONFIRMED',
      FAILED: 'FAILED',
      EXPIRED: 'EXPIRED',
      CANCELLED: 'EXPIRED',
      PAPER_FILLED: null,
    });
  });
});
