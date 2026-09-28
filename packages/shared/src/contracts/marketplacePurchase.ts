/**
 * MARKETPLACE_PLUGIN_PURCHASE: the one payment AI17Z will ever prepare.
 *
 * An owner who bought a Plugin on AI17Z Studio finishes the purchase in their
 * own AI17Z, where their wallet signs it. This file is the whole of what that
 * signature can be: an ERC-20 `transfer(recipient, amount)` of $AI17Z on
 * Robinhood Chain, for the exact amount a checkout recorded, from the wallet
 * the checkout named, to the publisher the checkout named. Nothing else is
 * expressible here.
 *
 * It is not a capability and never will be. No model chooses it, no prompt
 * reaches it, and there is no "send", "approve", "swap" or "sign" anywhere in
 * the tool registry. It runs only when the owner presses a button in their own
 * interface, and the wallet then asks them again.
 *
 * What the builder refuses, and why each matters:
 *
 *  - A chain, token or decimals that differ from the pinned values. Studio
 *    says what to pay; this says what a payment is allowed to be. A Studio
 *    that sent different terms, whether broken or compromised, is refused here
 *    rather than obeyed.
 *  - Any amount that is not a positive whole number of base units that fits
 *    in a uint256. No decimal point is ever parsed, so nothing is rounded.
 *  - A recipient that is the zero address or the token contract itself, where
 *    a transfer is a burn or a mistake.
 *  - A payer that is the recipient.
 *  - A checkout that is not awaiting payment or has expired.
 *
 * There is no `approve`, no `transferFrom`, no caller-supplied calldata, no
 * native value. The transaction's `to` is always the pinned token.
 */

/**
 * Verified against the chain on 2026-09-27: `eth_chainId` returned 0x1237,
 * `decimals()` returned 18, `symbol()` returned "ai17z", `DOMAIN_SEPARATOR()`
 * reverted (no permit), and the address is the one the canonical README
 * publishes. Changing any of these is a release, never configuration.
 */
export const AI17Z_PAYMENT = {
  chainId: 4663,
  chainName: 'Robinhood Chain',
  token: '0x16cb7cbb26295b60df7f4b3b39a99a9a3c585e81',
  tokenChecksum: '0x16CB7cBb26295b60DF7f4B3B39a99a9A3c585E81',
  decimals: 18,
  // What the contract's own symbol() returns; displayed as AI17Z.
  symbol: 'ai17z',
  /** Read only: chain id, decimals, balances and gas estimates, never a send. */
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
} as const;

/** keccak256("transfer(address,uint256)") truncated to four bytes. */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

const UINT256_MAX = (1n << 256n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** A checkout as Studio lists it to the installation it names. */
export interface StudioPurchaseTerms {
  intent_id: string;
  plugin_id: string;
  plugin_name: string;
  status: string;
  chain_id: number;
  token_address: string;
  token_decimals: number;
  payer_address: string;
  recipient_address: string;
  amount_base_units: string;
  expires_at: string;
}

export interface PreparedMarketplacePurchase {
  kind: 'MARKETPLACE_PLUGIN_PURCHASE';
  intentId: string;
  pluginId: string;
  pluginName: string;
  chainId: number;
  chainIdHex: string;
  token: string;
  payer: string;
  recipient: string;
  amountBaseUnits: string;
  /** The same amount for a person to read, exact, never rounded. */
  amountDisplay: string;
  expiresAt: string;
  /** Exactly what is handed to the wallet's `eth_sendTransaction`. */
  transaction: { from: string; to: string; data: string; value: '0x0' };
}

export type PrepareResult = { ok: true; purchase: PreparedMarketplacePurchase } | { ok: false; why: string };

/** Base units to a decimal string, exactly. `1500000000000000000` is `1.5`. */
export function formatBaseUnits(baseUnits: string, decimals: number = AI17Z_PAYMENT.decimals): string {
  const value = BigInt(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function word(hexWithoutPrefix: string): string {
  return hexWithoutPrefix.toLowerCase().padStart(64, '0');
}

export function encodeTransfer(recipient: string, amountBaseUnits: string): string {
  return `${ERC20_TRANSFER_SELECTOR}${word(recipient.slice(2))}${word(BigInt(amountBaseUnits).toString(16))}`;
}

/** Reads a transfer back out of calldata, or null for anything that is not exactly one. */
export function decodeTransfer(data: string): { recipient: string; amountBaseUnits: string } | null {
  if (!/^0x[0-9a-f]{136}$/.test(data) || !data.startsWith(ERC20_TRANSFER_SELECTOR)) return null;
  const recipientWord = data.slice(10, 74);
  const amountWord = data.slice(74, 138);
  if (!recipientWord.startsWith('0'.repeat(24))) return null;
  return { recipient: `0x${recipientWord.slice(24)}`, amountBaseUnits: BigInt(`0x${amountWord}`).toString() };
}

export function prepareMarketplacePurchase(terms: StudioPurchaseTerms, now: Date = new Date()): PrepareResult {
  if (terms.status !== 'AWAITING_PAYMENT') {
    return { ok: false, why: `This purchase is ${terms.status.toLowerCase().replace(/_/g, ' ')}, so there is nothing to pay.` };
  }
  const expires = Date.parse(terms.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { ok: false, why: 'This checkout has expired. Start a new one on AI17Z Studio.' };
  }
  if (terms.chain_id !== AI17Z_PAYMENT.chainId) {
    return { ok: false, why: `Studio asked for a payment on chain ${terms.chain_id}. AI17Z pays only on ${AI17Z_PAYMENT.chainName} (${AI17Z_PAYMENT.chainId}).` };
  }
  if (typeof terms.token_address !== 'string' || terms.token_address.toLowerCase() !== AI17Z_PAYMENT.token) {
    return { ok: false, why: 'Studio asked for a payment in a token that is not $AI17Z, so it was refused.' };
  }
  if (terms.token_decimals !== AI17Z_PAYMENT.decimals) {
    return { ok: false, why: `Studio described $AI17Z with ${terms.token_decimals} decimals; it has ${AI17Z_PAYMENT.decimals}.` };
  }
  if (typeof terms.amount_base_units !== 'string' || !/^[1-9][0-9]{0,77}$/.test(terms.amount_base_units) || BigInt(terms.amount_base_units) > UINT256_MAX) {
    return { ok: false, why: 'The amount is not a whole, positive number of base units.' };
  }
  if (!ADDRESS.test(terms.recipient_address) || !ADDRESS.test(terms.payer_address)) {
    return { ok: false, why: 'A wallet address in this checkout is not an address.' };
  }
  const recipient = terms.recipient_address.toLowerCase();
  const payer = terms.payer_address.toLowerCase();
  if (recipient === ZERO_ADDRESS || recipient === AI17Z_PAYMENT.token) {
    return { ok: false, why: 'The recipient would destroy the payment, so it was refused.' };
  }
  if (payer === recipient) return { ok: false, why: 'The paying wallet and the recipient are the same wallet.' };
  if (!/^[0-9a-f-]{36}$/i.test(terms.intent_id)) return { ok: false, why: 'This checkout has no usable id.' };

  const data = encodeTransfer(recipient, terms.amount_base_units);
  return {
    ok: true,
    purchase: {
      kind: 'MARKETPLACE_PLUGIN_PURCHASE',
      intentId: terms.intent_id,
      pluginId: terms.plugin_id,
      pluginName: terms.plugin_name,
      chainId: AI17Z_PAYMENT.chainId,
      chainIdHex: `0x${AI17Z_PAYMENT.chainId.toString(16)}`,
      token: AI17Z_PAYMENT.token,
      payer,
      recipient,
      amountBaseUnits: terms.amount_base_units,
      amountDisplay: formatBaseUnits(terms.amount_base_units),
      expiresAt: terms.expires_at,
      transaction: { from: payer, to: AI17Z_PAYMENT.token, data, value: '0x0' },
    },
  };
}

/**
 * Checks, in the browser, that the transaction about to reach the wallet is
 * still exactly the one prepared. The page receives it from the local API and
 * hands it on, and this is the last look before a signature is asked for.
 */
export function isExactPurchaseTransaction(purchase: PreparedMarketplacePurchase): boolean {
  const tx = purchase.transaction;
  const decoded = decodeTransfer(tx.data);
  return (
    purchase.kind === 'MARKETPLACE_PLUGIN_PURCHASE' &&
    purchase.chainId === AI17Z_PAYMENT.chainId &&
    tx.to === AI17Z_PAYMENT.token &&
    tx.value === '0x0' &&
    tx.from === purchase.payer &&
    decoded !== null &&
    decoded.recipient === purchase.recipient &&
    decoded.amountBaseUnits === purchase.amountBaseUnits &&
    Object.keys(tx).sort().join(',') === 'data,from,to,value'
  );
}
