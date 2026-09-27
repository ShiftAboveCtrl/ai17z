import { describe, expect, it } from 'vitest';
import {
  AI17Z_PAYMENT,
  ERC20_TRANSFER_SELECTOR,
  decodeTransfer,
  formatBaseUnits,
  isExactPurchaseTransaction,
  prepareMarketplacePurchase,
  type StudioPurchaseTerms,
} from '@xbam/shared/contracts';

const PAYER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-09-27T12:00:00Z');

function terms(overrides: Partial<StudioPurchaseTerms> = {}): StudioPurchaseTerms {
  return {
    intent_id: '6b1f2a0e-1c1d-4c2e-9f00-0123456789ab',
    plugin_id: 'weather-pro',
    plugin_name: 'Weather Pro',
    status: 'AWAITING_PAYMENT',
    chain_id: 4663,
    token_address: AI17Z_PAYMENT.tokenChecksum,
    token_decimals: 18,
    payer_address: PAYER,
    recipient_address: RECIPIENT,
    amount_base_units: '250500000000000000000',
    expires_at: '2026-09-27T13:00:00Z',
    ...overrides,
  };
}

describe('MARKETPLACE_PLUGIN_PURCHASE', () => {
  it('builds exactly one ERC-20 transfer of $AI17Z for the exact amount, to the pinned token', () => {
    const result = prepareMarketplacePurchase(terms(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { transaction } = result.purchase;
    expect(Object.keys(transaction).sort()).toEqual(['data', 'from', 'to', 'value']);
    expect(transaction.to).toBe(AI17Z_PAYMENT.token);
    expect(transaction.value).toBe('0x0');
    expect(transaction.from).toBe(PAYER);
    expect(transaction.data).toBe(
      `${ERC20_TRANSFER_SELECTOR}${'0'.repeat(24)}${RECIPIENT.slice(2)}${(250500000000000000000n).toString(16).padStart(64, '0')}`,
    );
    expect(decodeTransfer(transaction.data)).toEqual({ recipient: RECIPIENT, amountBaseUnits: '250500000000000000000' });
    expect(result.purchase.amountDisplay).toBe('250.5');
    expect(result.purchase.chainIdHex).toBe('0x1237');
    expect(isExactPurchaseTransaction(result.purchase)).toBe(true);
  });

  it.each([
    ['another chain', { chain_id: 1 }, /chain 1/],
    ['another token', { token_address: '0x3333333333333333333333333333333333333333' }, /not \$AI17Z/],
    ['wrong decimals', { token_decimals: 6 }, /18/],
    ['a decimal amount', { amount_base_units: '250.5' }, /whole, positive/],
    ['a zero amount', { amount_base_units: '0' }, /whole, positive/],
    ['a negative amount', { amount_base_units: '-1' }, /whole, positive/],
    ['scientific notation', { amount_base_units: '1e18' }, /whole, positive/],
    ['a leading zero', { amount_base_units: '0100' }, /whole, positive/],
    ['hex', { amount_base_units: '0x10' }, /whole, positive/],
    ['more than a uint256', { amount_base_units: (1n << 256n).toString() }, /whole, positive/],
    ['the zero address', { recipient_address: '0x0000000000000000000000000000000000000000' }, /destroy/],
    ['the token as recipient', { recipient_address: AI17Z_PAYMENT.tokenChecksum }, /destroy/],
    ['paying yourself', { recipient_address: PAYER }, /same wallet/],
    ['a malformed address', { recipient_address: '0x1234' }, /not an address/],
    ['an expired checkout', { expires_at: '2026-09-27T11:59:59Z' }, /expired/],
    ['a settled checkout', { status: 'SUBMITTED' }, /nothing to pay/],
    ['a bad id', { intent_id: '../../x' }, /no usable id/],
  ])('refuses %s', (_label, overrides, why) => {
    const result = prepareMarketplacePurchase(terms(overrides as Partial<StudioPurchaseTerms>), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toMatch(why);
  });

  it('notices a prepared transaction changed on its way to the wallet', () => {
    const result = prepareMarketplacePurchase(terms(), NOW);
    if (!result.ok) throw new Error(result.why);
    const good = result.purchase;
    const variants = [
      { ...good, transaction: { ...good.transaction, to: '0x3333333333333333333333333333333333333333' } },
      { ...good, transaction: { ...good.transaction, value: '0x1' as '0x0' } },
      { ...good, transaction: { ...good.transaction, from: RECIPIENT } },
      { ...good, transaction: { ...good.transaction, data: good.transaction.data.replace(RECIPIENT.slice(2), '4'.repeat(40)) } },
      // approve(spender, amount) with the same arguments.
      { ...good, transaction: { ...good.transaction, data: `0x095ea7b3${good.transaction.data.slice(10)}` } },
      { ...good, amountBaseUnits: '1' },
      { ...good, transaction: { ...good.transaction, gas: '0x1' } as unknown as typeof good.transaction },
    ];
    for (const variant of variants) expect(isExactPurchaseTransaction(variant)).toBe(false);
  });

  it('decodes nothing but a plain transfer', () => {
    expect(decodeTransfer('0x095ea7b3' + '0'.repeat(128))).toBeNull();
    expect(decodeTransfer('0x23b872dd' + '0'.repeat(192))).toBeNull();
    expect(decodeTransfer(`${ERC20_TRANSFER_SELECTOR}${'f'.repeat(64)}${'0'.repeat(64)}`)).toBeNull();
    expect(decodeTransfer(`${ERC20_TRANSFER_SELECTOR}00`)).toBeNull();
  });

  it('formats base units exactly, never rounding', () => {
    expect(formatBaseUnits('1')).toBe('0.000000000000000001');
    expect(formatBaseUnits('1000000000000000000')).toBe('1');
    expect(formatBaseUnits('123456789012345678901234567890')).toBe('123456789012.34567890123456789');
  });

  it('pins the chain facts verified on 2026-09-27', () => {
    expect(AI17Z_PAYMENT).toMatchObject({ chainId: 4663, token: '0x16cb7cbb26295b60df7f4b3b39a99a9a3c585e81', decimals: 18 });
    expect(AI17Z_PAYMENT.tokenChecksum.toLowerCase()).toBe(AI17Z_PAYMENT.token);
  });
});
