import { describe, expect, it } from 'vitest';
import { MAX_UINT256, inspectCall } from '@xbam/runtime';

/**
 * Saying what an EVM call would do before anybody signs it.
 *
 * The failures that matter are the quiet ones: an unlimited approval read as
 * an ordinary one, a spender nobody expected passing, a function this cannot
 * read passing as harmless. Each case is built from the real encoding.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';
const STRANGER = '0x1111111111111111111111111111111111111111';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
const uint = (n: bigint) => n.toString(16).padStart(64, '0');
const call = (selector: string, ...words: string[]) => `${selector}${words.join('')}`;

describe('approvals', () => {
  it('reads an ordinary approval and lets it through', () => {
    const r = inspectCall({ to: USDC, data: call('0x095ea7b3', addr(ROUTER), uint(1_000_000n)), value: '0' });
    expect(r.kind).toBe('APPROVE');
    expect(r.args).toEqual({ spender: ROUTER, amount: '1000000' });
    expect(r.verdict).toBe('ALLOW');
  });

  it('says an unlimited approval is unlimited, and needs a person', () => {
    const r = inspectCall({ to: USDC, data: call('0x095ea7b3', addr(ROUTER), uint(MAX_UINT256)), value: '0' });
    expect(r.verdict).toBe('APPROVAL_REQUIRED');
    expect(r.findings.map((f) => f.code)).toContain('UNLIMITED_APPROVAL');
  });

  it('refuses a spender nobody expected', () => {
    const r = inspectCall({
      to: USDC,
      data: call('0x095ea7b3', addr(STRANGER), uint(5n)),
      value: '0',
      expect: { spenders: [ROUTER] },
    });
    expect(r.verdict).toBe('DENY');
    expect(r.findings.find((f) => f.code === 'UNEXPECTED_SPENDER')?.sentence).toContain(STRANGER);
  });

  it('treats approve-all as handing over the whole collection', () => {
    const r = inspectCall({ to: STRANGER, data: call('0xa22cb465', addr(ROUTER), uint(1n)), value: '0' });
    expect(r.kind).toBe('SET_APPROVAL_FOR_ALL');
    expect(r.verdict).toBe('APPROVAL_REQUIRED');
    // Revoking approve-all is not something to stop.
    expect(inspectCall({ to: STRANGER, data: call('0xa22cb465', addr(ROUTER), uint(0n)), value: '0' }).verdict).toBe('ALLOW');
  });

  it('reads a Permit2 approval, its token and its spender', () => {
    const r = inspectCall({
      to: PERMIT2,
      data: call('0x87517c45', addr(USDC), addr(STRANGER), uint((1n << 160n) - 1n), uint(1_900_000_000n)),
      value: '0',
      expect: { spenders: [ROUTER], tokens: [USDC] },
    });
    expect(r.kind).toBe('PERMIT2_APPROVE');
    expect(r.args.token).toBe(USDC);
    expect(r.verdict).toBe('DENY');
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['UNLIMITED_APPROVAL', 'UNEXPECTED_SPENDER']));
  });
});

describe('transfers and value', () => {
  it('reads a transfer and refuses an unexpected recipient', () => {
    const r = inspectCall({ to: USDC, data: call('0xa9059cbb', addr(STRANGER), uint(42n)), value: '0', expect: { recipients: [ROUTER] } });
    expect(r.args).toEqual({ recipient: STRANGER, amount: '42' });
    expect(r.verdict).toBe('DENY');
  });

  it('reads transferFrom, which moves tokens on behalf of another address', () => {
    const r = inspectCall({ to: USDC, data: call('0x23b872dd', addr(ROUTER), addr(STRANGER), uint(7n)), value: '0' });
    expect(r.args).toEqual({ from: ROUTER, recipient: STRANGER, amount: '7' });
  });

  it('refuses value above the ceiling, and a token contract nobody named', () => {
    const r = inspectCall({ to: STRANGER, data: '0x', value: '2000', expect: { maxValue: '1000', recipients: [STRANGER] } });
    expect(r.kind).toBe('NATIVE_TRANSFER');
    expect(r.findings.map((f) => f.code)).toContain('VALUE_ABOVE_LIMIT');
    const wrongToken = inspectCall({ to: STRANGER, data: call('0xa9059cbb', addr(ROUTER), uint(1n)), value: '0', expect: { tokens: [USDC] } });
    expect(wrongToken.findings.map((f) => f.code)).toContain('UNEXPECTED_TOKEN');
  });
});

describe('nothing is signed blind', () => {
  it('sends a function it cannot read to a person', () => {
    const swap = call('0x3593564c', uint(1n), uint(2n), uint(3n));
    const r = inspectCall({ to: ROUTER, data: swap, value: '0' });
    expect(r.kind).toBe('UNKNOWN');
    expect(r.verdict).toBe('APPROVAL_REQUIRED');
  });

  it('refuses call data that is not whole words', () => {
    expect(inspectCall({ to: ROUTER, data: '0x095ea7b3abcd', value: '0' }).verdict).toBe('DENY');
    expect(inspectCall({ to: ROUTER, data: '0x09', value: '0' }).verdict).toBe('DENY');
  });

  it('does not read a known selector with the wrong number of arguments as that function', () => {
    const r = inspectCall({ to: USDC, data: call('0x095ea7b3', addr(ROUTER)), value: '0' });
    expect(r.kind).toBe('UNKNOWN');
    expect(r.verdict).toBe('APPROVAL_REQUIRED');
  });
});
