import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CAVEATS,
  NEVER_MODEL_CALLABLE,
  UNKNOWN_ATTEMPTS_BEFORE_PERSON,
  afterBroadcast,
  capabilityCrossesTheLine,
  maySign,
  resolveUnknown,
  type SignContext,
} from '@xbam/runtime';
import { TRADE_INTENT_STATUSES, TRADE_NO_RESIGN_STATUSES } from '@xbam/shared';

/**
 * Whether one decision can become two transactions.
 *
 * For a reply the answer costs an embarrassment and can be deleted. For a
 * transfer it costs money and cannot, so the test is written against the three
 * refusals rather than the happy path: no second signature, no signing in
 * PAPER, and no retry of a broadcast nobody saw.
 */

const context = (over: Partial<SignContext> = {}): SignContext => ({
  status: 'APPROVED',
  mode: 'LIVE',
  approval: 'OWNER_APPROVES_EACH',
  ownerApproved: true,
  paused: false,
  quoteFresh: true,
  signerAvailable: true,
  ...over,
});

describe('producing a signature', () => {
  it('allows one for an approved intent with everything in place', () => {
    expect(maySign(context())).toEqual({ sign: true });
  });

  it('allows one from SIMULATED as well as APPROVED', () => {
    expect(maySign(context({ status: 'SIMULATED' })).sign).toBe(true);
  });

  it('never produces a second one', () => {
    // Signing again is how one decision becomes two transactions.
    for (const status of TRADE_NO_RESIGN_STATUSES) {
      const out = maySign(context({ status }));
      expect(out.sign, status).toBe(false);
      if (out.sign) continue;
      expect(out.why.join(' '), status).toContain('two transactions');
    }
  });

  it('refuses from every status that is not APPROVED or SIMULATED', () => {
    for (const status of TRADE_INTENT_STATUSES) {
      if (status === 'APPROVED' || status === 'SIMULATED') continue;
      expect(maySign(context({ status })).sign, status).toBe(false);
    }
  });

  it('never signs in PAPER mode', () => {
    // Re-read here rather than trusted from an earlier read, because a mandate
    // can change between the two.
    const out = maySign(context({ mode: 'PAPER' }));
    expect(out.sign).toBe(false);
    if (out.sign) return;
    expect(out.why.join(' ')).toContain('whatever else it allows');
  });

  it('refuses without the owner when the mandate asks about every trade', () => {
    expect(maySign(context({ ownerApproved: false })).sign).toBe(false);
  });

  it('does not ask the owner when the mandate does not', () => {
    expect(maySign(context({ approval: 'AUTONOMOUS_WITHIN_MANDATE', ownerApproved: false })).sign).toBe(true);
  });

  it('refuses under a pause', () => {
    expect(maySign(context({ paused: true })).sign).toBe(false);
  });

  it('refuses a stale quote, which is a different trade', () => {
    const out = maySign(context({ quoteFresh: false }));
    expect(out.sign).toBe(false);
    if (out.sign) return;
    expect(out.why.join(' ')).toContain('different trade');
  });

  it('refuses rather than improvising a signer', () => {
    const out = maySign(context({ signerAvailable: false }));
    expect(out.sign).toBe(false);
    if (out.sign) return;
    expect(out.why.join(' ')).toContain('improvise');
  });

  it('gives every reason rather than the first', () => {
    const out = maySign(context({ mode: 'PAPER', paused: true, quoteFresh: false, signerAvailable: false, ownerApproved: false }));
    expect(out.sign).toBe(false);
    if (out.sign) return;
    expect(out.why.length).toBeGreaterThanOrEqual(5);
  });
});

describe('after a broadcast', () => {
  it('records the identity when the network accepted it', () => {
    const out = afterBroadcast({ kind: 'ACCEPTED', txIdentity: '0xabc' });
    expect(out.status).toBe('SUBMITTED');
    expect(out.txIdentity).toBe('0xabc');
    expect(out.mayRetry).toBe(false);
  });

  it('treats a refusal as evidence that nothing was sent', () => {
    // The only outcome here that is evidence of that.
    const out = afterBroadcast({ kind: 'REFUSED', why: 'insufficient balance' });
    expect(out.status).toBe('FAILED');
    expect(out.mayRetry).toBe(true);
    expect(out.next).toContain('Nothing was sent');
  });

  it('never retries a broadcast nobody saw', () => {
    // The exact case where trying again creates a second real transaction.
    const out = afterBroadcast({ kind: 'UNSEEN', why: 'the connection dropped' });
    expect(out.status).toBe('UNKNOWN');
    expect(out.mayRetry).toBe(false);
    expect(out.next).toContain('Never send it again');
  });

  it('keeps a refusal and an unseen outcome apart', () => {
    const refused = afterBroadcast({ kind: 'REFUSED', why: 'x' });
    const unseen = afterBroadcast({ kind: 'UNSEEN', why: 'x' });
    expect(refused.status).not.toBe(unseen.status);
    expect(refused.mayRetry).not.toBe(unseen.mayRetry);
  });

  it('names no identity for anything but an accepted broadcast', () => {
    expect(afterBroadcast({ kind: 'REFUSED', why: 'x' }).txIdentity).toBeUndefined();
    expect(afterBroadcast({ kind: 'UNSEEN', why: 'x' }).txIdentity).toBeUndefined();
  });
});

describe('resolving an unknown', () => {
  it('confirms when the network has it confirmed', () => {
    const out = resolveUnknown({ kind: 'FOUND', txIdentity: '0xabc', confirmed: true }, 1);
    expect(out.status).toBe('CONFIRMED');
    if (out.status === 'FAILED' || out.status === 'UNKNOWN') return;
    expect(out.txIdentity).toBe('0xabc');
  });

  it('records it as submitted when the network has it unconfirmed', () => {
    expect(resolveUnknown({ kind: 'FOUND', txIdentity: '0xabc', confirmed: false }, 1).status).toBe('SUBMITTED');
  });

  it('closes the intent only when the network is sure nothing exists', () => {
    const out = resolveUnknown({ kind: 'DEFINITELY_ABSENT', why: 'the nonce has moved past it' }, 1);
    expect(out.status).toBe('FAILED');
    expect(out.detail).toContain('Nothing was sent');
  });

  it('stays unknown when the network would not say', () => {
    const out = resolveUnknown({ kind: 'STILL_UNKNOWN', why: 'the node timed out' }, 1);
    expect(out.status).toBe('UNKNOWN');
    if (out.status !== 'UNKNOWN') return;
    expect(out.needsPerson).toBe(false);
  });

  it('asks for a person rather than sweeping for ever', () => {
    // A sweep that never gives up looks like progress, and is the state in
    // which somebody eventually resends by hand to make it stop.
    const out = resolveUnknown({ kind: 'STILL_UNKNOWN', why: 'the node timed out' }, UNKNOWN_ATTEMPTS_BEFORE_PERSON);
    expect(out.status).toBe('UNKNOWN');
    if (out.status !== 'UNKNOWN') return;
    expect(out.needsPerson).toBe(true);
  });
});

describe('what a model may never reach', () => {
  it('names every generic transaction verb', () => {
    for (const verb of ['send', 'transfer', 'approve', 'sign', 'signTypedData', 'contractCall', 'calldata']) {
      expect(NEVER_MODEL_CALLABLE, verb).toContain(verb);
    }
  });

  it('refuses a capability whose verb is one of them', () => {
    for (const id of ['wallet.send', 'x.transfer', 'plugin_thing.signTypedData', 'trade.approve']) {
      const out = capabilityCrossesTheLine(id);
      expect(out.ok, id).toBe(false);
      if (out.ok) continue;
      expect(out.why).toContain('whole surface');
    }
  });

  it('allows a capability that reads rather than moves anything', () => {
    for (const id of ['trade.quote', 'market.price', 'wallet.balance', 'trade.proposeIntent']) {
      expect(capabilityCrossesTheLine(id).ok, id).toBe(true);
    }
  });

  it('matches the verb rather than a name containing it', () => {
    // `x.sendable` is not `send`, and refusing it would be a false positive
    // somebody works around by renaming.
    expect(capabilityCrossesTheLine('x.sendable').ok).toBe(true);
    expect(capabilityCrossesTheLine('wallet.approvals').ok).toBe(true);
  });
});

describe('what this does not claim', () => {
  it('says no funded transaction has been made', () => {
    expect(EXECUTION_CAVEATS.join(' ').toLowerCase()).toContain('no funded transaction has been built');
  });

  it('says an unknown is never retried', () => {
    expect(EXECUTION_CAVEATS.join(' ').toLowerCase()).toContain('unknown is never retried');
  });

  it('says a dropped connection is evidence of nothing', () => {
    expect(EXECUTION_CAVEATS.join(' ').toLowerCase()).toContain('evidence of nothing');
  });
});
