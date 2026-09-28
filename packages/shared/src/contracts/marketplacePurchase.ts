/**
 * MARKETPLACE_PLUGIN_PURCHASE: the one payment AI17Z will ever prepare.
 *
 * An owner who bought a Plugin on AI17Z Studio finishes the purchase in their
 * own AI17Z, where their wallet signs it. A checkout is one or more payments
 * (legs): the publisher's share and, on a paid plan, the marketplace fee. This
 * file is the whole of what each signature can be, and there are exactly two
 * shapes:
 *
 *  - an ERC-20 `transfer(recipient, amount)` of $AI17Z on Robinhood Chain,
 *    sent to the pinned token contract with no native value, or
 *  - a plain ETH transfer on Robinhood Chain: `to` the recipient, `value` the
 *    exact amount in wei, and empty data, so no contract is ever called.
 *
 * Each for the exact amount the checkout recorded for that leg, from the
 * wallet the checkout named, to the recipient the checkout named. Nothing
 * else is expressible here.
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
 * There is no `approve`, no `transferFrom`, no caller-supplied calldata. An
 * AI17Z payment's `to` is always the pinned token and carries no value; an
 * ETH payment carries no data. Nothing here renews, repeats or schedules a
 * payment: every one is a person pressing a button and their wallet asking.
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

/** The zero address Studio records as the "token" of a checkout paid in ETH. */
export const NATIVE_ETH_ADDRESS = '0x0000000000000000000000000000000000000000';

export type PaymentAsset = 'AI17Z' | 'ETH';

/** One payment of a checkout, as Studio lists it. */
export interface StudioPurchaseLeg {
  leg_index: number;
  role: 'PUBLISHER' | 'TREASURY';
  asset: PaymentAsset;
  recipient_address: string;
  amount_base_units: string;
  status: string;
  submitted_tx_hash: string | null;
  failure_reason: string | null;
}

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
  /** Absent from a Studio that predates payment legs: then the checkout is one AI17Z payment. */
  payment_asset?: PaymentAsset;
  legs?: StudioPurchaseLeg[];
}

export interface PreparedMarketplacePurchase {
  kind: 'MARKETPLACE_PLUGIN_PURCHASE';
  intentId: string;
  legIndex: number;
  role: 'PUBLISHER' | 'TREASURY';
  asset: PaymentAsset;
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
  transaction: { from: string; to: string; data: string; value: string };
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

/** Statuses of a checkout that may still take a payment. */
const OPEN = new Set(['AWAITING_PAYMENT', 'SUBMITTED', 'CONFIRMING', 'PARTIALLY_PAID']);
/** Statuses of a leg that may be paid: never asked for, or refused by the chain and so still owed. */
const PAYABLE_LEG = new Set(['AWAITING_PAYMENT', 'FAILED']);

/**
 * The legs of a checkout. A Studio from before payment legs lists one AI17Z
 * payment at the top level, which is exactly a single publisher leg.
 */
export function legsOf(terms: StudioPurchaseTerms): StudioPurchaseLeg[] {
  if (Array.isArray(terms.legs) && terms.legs.length > 0) return terms.legs;
  return [
    {
      leg_index: 0,
      role: 'PUBLISHER',
      asset: 'AI17Z',
      recipient_address: terms.recipient_address,
      amount_base_units: terms.amount_base_units,
      status: terms.status,
      submitted_tx_hash: null,
      failure_reason: null,
    },
  ];
}

export function prepareMarketplacePurchase(terms: StudioPurchaseTerms, now: Date = new Date(), legIndex = 0): PrepareResult {
  const legacy = !Array.isArray(terms.legs) || terms.legs.length === 0;
  if (!OPEN.has(terms.status) || (legacy && terms.status !== 'AWAITING_PAYMENT')) {
    return { ok: false, why: `This purchase is ${terms.status.toLowerCase().replace(/_/g, ' ')}, so there is nothing to pay.` };
  }
  const legs = legsOf(terms);
  const leg = legs.find((l) => l.leg_index === legIndex);
  if (!leg) return { ok: false, why: 'This checkout has no such payment.' };
  if (!PAYABLE_LEG.has(leg.status)) {
    return { ok: false, why: 'This payment has already been made, so it will not be asked for again.' };
  }
  // A checkout with a payment already made stays payable past its deadline,
  // so a half-paid purchase can always be finished. Studio applies the same rule.
  const somethingPaid = legs.some((l) => l.leg_index !== legIndex && l.submitted_tx_hash);
  const expires = Date.parse(terms.expires_at);
  if (!Number.isFinite(expires) || (!somethingPaid && expires <= now.getTime())) {
    return { ok: false, why: 'This checkout has expired. Start a new one on AI17Z Studio.' };
  }
  if (terms.chain_id !== AI17Z_PAYMENT.chainId) {
    return { ok: false, why: `Studio asked for a payment on chain ${terms.chain_id}. AI17Z pays only on ${AI17Z_PAYMENT.chainName} (${AI17Z_PAYMENT.chainId}).` };
  }
  const asset = terms.payment_asset ?? 'AI17Z';
  if ((asset !== 'AI17Z' && asset !== 'ETH') || leg.asset !== asset) {
    return { ok: false, why: 'Studio described this payment in a currency AI17Z does not pay in, so it was refused.' };
  }
  const expectedToken = asset === 'ETH' ? NATIVE_ETH_ADDRESS : AI17Z_PAYMENT.token;
  if (typeof terms.token_address !== 'string' || terms.token_address.toLowerCase() !== expectedToken) {
    return {
      ok: false,
      why: asset === 'ETH' ? 'Studio described an ETH payment with a token attached, so it was refused.' : 'Studio asked for a payment in a token that is not $AI17Z, so it was refused.',
    };
  }
  if (terms.token_decimals !== AI17Z_PAYMENT.decimals) {
    return { ok: false, why: `Studio described the payment with ${terms.token_decimals} decimals; it has ${AI17Z_PAYMENT.decimals}.` };
  }
  const amount = leg.amount_base_units;
  if (typeof amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amount) || BigInt(amount) > UINT256_MAX) {
    return { ok: false, why: 'The amount is not a whole, positive number of base units.' };
  }
  if (!ADDRESS.test(leg.recipient_address) || !ADDRESS.test(terms.payer_address)) {
    return { ok: false, why: 'A wallet address in this checkout is not an address.' };
  }
  const recipient = leg.recipient_address.toLowerCase();
  const payer = terms.payer_address.toLowerCase();
  if (recipient === ZERO_ADDRESS || recipient === AI17Z_PAYMENT.token) {
    return { ok: false, why: 'The recipient would destroy the payment, so it was refused.' };
  }
  if (payer === recipient) return { ok: false, why: 'The paying wallet and the recipient are the same wallet.' };
  if (!/^[0-9a-f-]{36}$/i.test(terms.intent_id)) return { ok: false, why: 'This checkout has no usable id.' };

  const transaction =
    asset === 'ETH'
      ? { from: payer, to: recipient, data: '0x', value: `0x${BigInt(amount).toString(16)}` }
      : { from: payer, to: AI17Z_PAYMENT.token, data: encodeTransfer(recipient, amount), value: '0x0' };
  return {
    ok: true,
    purchase: {
      kind: 'MARKETPLACE_PLUGIN_PURCHASE',
      intentId: terms.intent_id,
      legIndex: leg.leg_index,
      role: leg.role === 'TREASURY' ? 'TREASURY' : 'PUBLISHER',
      asset,
      pluginId: terms.plugin_id,
      pluginName: terms.plugin_name,
      chainId: AI17Z_PAYMENT.chainId,
      chainIdHex: `0x${AI17Z_PAYMENT.chainId.toString(16)}`,
      token: expectedToken,
      payer,
      recipient,
      amountBaseUnits: amount,
      amountDisplay: formatBaseUnits(amount),
      expiresAt: terms.expires_at,
      transaction,
    },
  };
}

/**
 * Checks, in the browser, that the transaction about to reach the wallet is
 * still exactly the one prepared. The page receives it from the local API and
 * hands it on, and this is the last look before a signature is asked for.
 * Exactly one of the two shapes, with nothing added.
 */
export function isExactPurchaseTransaction(purchase: PreparedMarketplacePurchase): boolean {
  const tx = purchase.transaction;
  if (purchase.kind !== 'MARKETPLACE_PLUGIN_PURCHASE' || purchase.chainId !== AI17Z_PAYMENT.chainId) return false;
  if (Object.keys(tx).sort().join(',') !== 'data,from,to,value' || tx.from !== purchase.payer) return false;
  if (purchase.recipient === ZERO_ADDRESS || purchase.recipient === AI17Z_PAYMENT.token) return false;
  if (purchase.asset === 'ETH') {
    return (
      purchase.token === NATIVE_ETH_ADDRESS &&
      tx.to === purchase.recipient &&
      tx.data === '0x' &&
      /^0x[0-9a-f]{1,64}$/.test(tx.value) &&
      BigInt(tx.value).toString() === purchase.amountBaseUnits
    );
  }
  const decoded = decodeTransfer(tx.data);
  return (
    purchase.asset === 'AI17Z' &&
    tx.to === AI17Z_PAYMENT.token &&
    tx.value === '0x0' &&
    decoded !== null &&
    decoded.recipient === purchase.recipient &&
    decoded.amountBaseUnits === purchase.amountBaseUnits
  );
}
