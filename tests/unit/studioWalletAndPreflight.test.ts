import { afterEach, describe, expect, it } from 'vitest';
import { AI17Z_PAYMENT, prepareMarketplacePurchase } from '@xbam/shared/contracts';
import { isWalletLinkChallenge, preflightPurchase, setPaymentRpcForTests } from '../../packages/runtime/src/studioLink';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const message = (overrides: Partial<Record<'wallet' | 'purpose' | 'chain' | 'footer', string>> = {}) =>
  [
    'studio.example asks you to prove you control this wallet.',
    '',
    overrides.purpose ?? 'Link this wallet to my AI17Z Studio account so I can pay for plugins from it.',
    '',
    `Wallet: ${overrides.wallet ?? '0x1111111111111111111111111111111111111111'}`,
    overrides.chain ?? 'Chain: Robinhood Chain (4663)',
    'Studio account: owner@example.test',
    'Nonce: abc123',
    'Issued: 2026-09-28T00:00:00.000Z',
    'Expires: 2026-09-28T00:10:00.000Z',
    '',
    overrides.footer ?? 'Signing this message does not send a transaction, grant any allowance, or cost gas.',
  ].join('\n');

describe('what a wallet may be asked to sign to link it', () => {
  it('accepts a wallet-link message for this wallet', () => {
    expect(isWalletLinkChallenge(message(), ADDRESS)).toBe(true);
  });

  it.each([
    ['for another wallet', { wallet: '0x2222222222222222222222222222222222222222' }],
    ['for payouts rather than linking', { purpose: 'Receive AI17Z plugin sale proceeds for the publisher "X".' }],
    ['on another chain', { chain: 'Chain: Ethereum (1)' }],
    ['without the no-transaction promise', { footer: 'Sign to continue.' }],
  ])('refuses a message %s', (_label, overrides) => {
    expect(isWalletLinkChallenge(message(overrides), ADDRESS)).toBe(false);
  });
});

describe('reading the chain before a wallet is asked', () => {
  afterEach(() => setPaymentRpcForTests(null));
  const prepared = prepareMarketplacePurchase(
    {
      intent_id: '6b1f2a0e-1c1d-4c2e-9f00-0123456789ab',
      plugin_id: 'p',
      plugin_name: 'P',
      status: 'AWAITING_PAYMENT',
      chain_id: 4663,
      token_address: AI17Z_PAYMENT.token,
      token_decimals: 18,
      payer_address: ADDRESS,
      recipient_address: '0x2222222222222222222222222222222222222222',
      amount_base_units: '10000000000000000000',
      expires_at: '2999-01-01T00:00:00Z',
    },
  );
  if (!prepared.ok) throw new Error(prepared.why);
  const symbolHex = `0x${'20'.padStart(64, '0')}${'5'.padStart(64, '0')}${Buffer.from('ai17z').toString('hex').padEnd(64, '0')}`;
  const chain = (balance: bigint, overrides: Record<string, unknown> = {}) => async (method: string, params: unknown[]) => {
    if (method in overrides) return overrides[method];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBalance') return '0x5af3107a4000';
    if (method === 'eth_estimateGas') return '0xc350';
    const data = (params[0] as { data: string }).data;
    if (data === '0x313ce567') return `0x${'12'.padStart(64, '0')}`;
    if (data === '0x95d89b41') return symbolHex;
    return `0x${balance.toString(16).padStart(64, '0')}`;
  };

  it('passes a transfer the chain agrees with', async () => {
    setPaymentRpcForTests(chain(10n ** 19n));
    const result = await preflightPurchase(prepared.purchase);
    expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
      ['Chain', true],
      ['Token decimals', true],
      ['Token symbol', true],
      ['Balance', true],
      ['Would succeed', true],
      ['Gas money', true],
    ]);
    expect(result.ok).toBe(true);
  });

  it('refuses when the wallet holds too little, the node serves another chain, or the call would revert', async () => {
    setPaymentRpcForTests(chain(10n ** 19n - 1n));
    expect((await preflightPurchase(prepared.purchase)).ok).toBe(false);
    setPaymentRpcForTests(chain(10n ** 19n, { eth_chainId: '0x1' }));
    expect((await preflightPurchase(prepared.purchase)).ok).toBe(false);
    setPaymentRpcForTests(async (method, params) => {
      if (method === 'eth_estimateGas') throw new Error('execution reverted');
      return chain(10n ** 19n)(method, params);
    });
    const reverted = await preflightPurchase(prepared.purchase);
    expect(reverted.ok).toBe(false);
    expect(reverted.checks.find((c) => c.name === 'Would succeed')?.detail).toMatch(/reverted/);
  });
});
