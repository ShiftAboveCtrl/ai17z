import { z } from 'zod';

/**
 * An agent's own wallet: the vocabulary.
 *
 * AI17Z keeps a key for an agent, sealed under the master key, and can say
 * what that wallet holds. It never moves anything on its own. The only way
 * value leaves a wallet is an intent the owner drafted, simulated, read and
 * approved by its exact digest, submitted once. There is no generic send,
 * sign, approve or contract call anywhere in this vocabulary, and no model can
 * reach a write: the four wallet capabilities are reads.
 *
 * Chain-specific code (deriving addresses, reading nodes, building and signing
 * a transaction) is not here and not in this repository. It is supplied by a
 * first-party wallet adapter the owner installs; without one, every wallet
 * capability says it is not configured and nothing else changes.
 */

export const WALLET_FAMILIES = ['EVM', 'SOLANA'] as const;
export const WalletFamily = z.enum(WALLET_FAMILIES);
export type WalletFamily = (typeof WALLET_FAMILIES)[number];

/**
 * The networks a wallet may be read or used on.
 *
 * Every value was taken from the network's own documentation and read back
 * from a live node on 2026-09-30: `eth_chainId` answered 0x1 (Ethereum), 0x38
 * (BNB Smart Chain) and 0x1237 (Robinhood Chain), and Solana's `getGenesisHash`
 * answered 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d, whose first 32
 * characters are its CAIP-2 reference. All four are mainnets, so nothing here
 * ever moves without the owner approving the exact transaction.
 */
export const WALLET_NETWORKS = {
  ethereum: {
    family: 'EVM',
    label: 'Ethereum',
    chainId: 1,
    caip2: 'eip155:1',
    native: 'ETH',
    decimals: 18,
    explorer: 'https://etherscan.io',
    mainnet: true,
  },
  bnb: {
    family: 'EVM',
    label: 'BNB Smart Chain',
    chainId: 56,
    caip2: 'eip155:56',
    native: 'BNB',
    decimals: 18,
    explorer: 'https://bscscan.com',
    mainnet: true,
  },
  robinhood: {
    family: 'EVM',
    label: 'Robinhood Chain',
    chainId: 4663,
    caip2: 'eip155:4663',
    native: 'ETH',
    decimals: 18,
    explorer: 'https://robinhoodchain.blockscout.com',
    mainnet: true,
  },
  solana: {
    family: 'SOLANA',
    label: 'Solana',
    chainId: null,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    native: 'SOL',
    decimals: 9,
    explorer: 'https://explorer.solana.com',
    mainnet: true,
  },
} as const satisfies Record<
  string,
  { family: WalletFamily; label: string; chainId: number | null; caip2: string; native: string; decimals: number; explorer: string; mainnet: boolean }
>;
export type WalletNetwork = keyof typeof WALLET_NETWORKS;
export const WALLET_NETWORK_IDS = Object.keys(WALLET_NETWORKS) as [WalletNetwork, ...WalletNetwork[]];
export const WalletNetworkId = z.enum(WALLET_NETWORK_IDS);

export function networksOf(family: WalletFamily): WalletNetwork[] {
  return WALLET_NETWORK_IDS.filter((n) => WALLET_NETWORKS[n].family === family);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Whether a string is shaped like an address of this family. Shape only: checksums are the adapter's. */
export function addressShapeOk(family: WalletFamily, address: string): boolean {
  return family === 'EVM' ? EVM_ADDRESS.test(address) : BASE58.test(address);
}

/** An amount in the network's smallest unit, as a decimal string, never a float. */
export const BaseUnits = z
  .string()
  .regex(/^[0-9]{1,78}$/, 'An amount is a whole number of the smallest unit, written in digits.')
  .refine((v) => BigInt(v) > 0n, 'An amount has to be more than zero.');

/**
 * What an owner may ask a wallet to do. Two kinds, both transfers, both typed.
 *
 * Deliberately no calldata, no arbitrary contract, no approval of a spender,
 * no message signing: each of those is a way to hand somebody else the wallet
 * in a shape an owner cannot read.
 */
export const WalletIntentParams = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('NATIVE_TRANSFER'),
    network: WalletNetworkId,
    to: z.string().trim().min(32).max(64),
    amount: BaseUnits,
  }).strict(),
  z.object({
    kind: z.literal('TOKEN_TRANSFER'),
    network: WalletNetworkId,
    to: z.string().trim().min(32).max(64),
    amount: BaseUnits,
    /** The token's contract (EVM) or mint (Solana). */
    token: z.string().trim().min(32).max(64),
    /** As the owner was shown it; the adapter checks it against the chain. */
    tokenDecimals: z.number().int().min(0).max(36),
    tokenSymbol: z.string().trim().min(1).max(20),
  }).strict(),
]);
export type WalletIntentParams = z.infer<typeof WalletIntentParams>;

export const WALLET_INTENT_STATUSES = [
  /** Written down, not yet looked at by the chain. */
  'DRAFTED',
  /** Simulated; the owner can read exactly what would happen, and approve it by its digest. */
  'AWAITING_APPROVAL',
  /** The owner approved this exact transaction. Expires if not submitted. */
  'APPROVED',
  /** Being signed and handed to the network. Never retried from here. */
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  /** The chain said no, or simulation found it would fail. */
  'FAILED',
  'REJECTED',
  'EXPIRED',
  /**
   * Handed over and not heard back. The one state that needs a person: it may
   * have gone through. It is checked by its hash, never sent again.
   */
  'UNKNOWN',
] as const;
export type WalletIntentStatus = (typeof WALLET_INTENT_STATUSES)[number];

/** What simulating an intent found. Every amount in base units, as a string. */
export const WalletSimulation = z.object({
  ok: z.boolean(),
  /** The most the network fee can be, in the native unit's smallest part. */
  maxFee: z.string(),
  /** What the wallet holds of what is being sent, before. */
  balanceBefore: z.string(),
  /** What it would hold after, at the maximum fee. */
  balanceAfter: z.string(),
  /** Anything the owner should read before approving. */
  warnings: z.array(z.string()).default([]),
  /** Why it would fail, when `ok` is false. */
  failure: z.string().nullable().default(null),
  /**
   * What the adapter will sign, pinned: nonce and fee caps for EVM, the
   * blockhash window for Solana. Part of the digest, so an approval is for one
   * transaction and not for its type.
   */
  pinned: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type WalletSimulation = z.infer<typeof WalletSimulation>;

/** How long an approval holds before the transaction must be simulated again. */
export const APPROVAL_TTL_MS = 10 * 60_000;

/** A base-unit amount as a person reads it: "1.5 ETH". Exact, no floats. */
export function formatUnits(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** "1.5" in a unit with `decimals` places, as base units. Refuses more precision than the unit has. */
export function parseUnits(text: string, decimals: number): string {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) throw new Error('An amount is digits, with at most one decimal point.');
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) throw new Error(`That has more decimal places than the unit allows (${decimals}).`);
  return (BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}
