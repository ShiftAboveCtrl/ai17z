/**
 * The four things an agent may know about its own wallet. All reads.
 *
 * There is no capability that sends, transfers, approves, signs, signs a
 * message, calls a contract or sends calldata, and there must never be one:
 * value moves only through the owner's routes in `walletCore.ts`, one exact
 * approved transaction at a time. `tests/unit/noWalletCapabilities.test.ts`
 * pins this list and fails if this file ever reaches the submit path.
 *
 * ## Off until the owner turns them on, and the owner's for now
 *
 * Each is DISABLED for an agent whose owner decided nothing, as a Plugin
 * bought on Studio is. And each is `audience: 'OWNER'` in this first version:
 * what an agent holds is public on a chain, but an agent volunteering its
 * balance to whoever asks on X is a decision to make on purpose, later, not a
 * default to discover.
 */
import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { WALLET_NETWORKS, WalletNetworkId, formatUnits } from '@xbam/shared/contracts';
import { readActivity, readBalances, walletAdapter, walletReadiness, walletsOf } from './walletCore';

async function ready() {
  const r = walletReadiness();
  return r.ready ? { status: 'AVAILABLE' as const } : { status: 'UNAVAILABLE' as const, why: r.detail };
}

const address = defineCapability({
  id: 'wallet.address',
  name: 'Own wallet address',
  description: 'The addresses of your own wallets, by network. Use when the owner asks for your wallet address.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({}),
  output: z.object({ wallets: z.array(z.object({ family: z.string(), address: z.string(), networks: z.array(z.string()) })), detail: z.string() }),
  modelCallable: true,
  timeoutMs: 10_000,
  readiness: ready,
  async run(_input, ctx) {
    const wallets = await walletsOf(ctx.agentId, null);
    return {
      wallets: wallets.map((w) => ({
        family: w.family,
        address: w.address,
        networks: Object.values(WALLET_NETWORKS).filter((n) => n.family === w.family).map((n) => n.label),
      })),
      detail: wallets.length === 0 ? 'You have no wallet yet. Your owner creates one on your page.' : `${wallets.length} wallet${wallets.length === 1 ? '' : 's'}.`,
    };
  },
});

const balances = defineCapability({
  id: 'wallet.balances',
  name: 'Own wallet balances',
  description: 'What your own wallet holds on one network, read from the chain now. Use when the owner asks your balance.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ network: WalletNetworkId }),
  output: z.object({
    network: z.string(),
    address: z.string().nullable(),
    balances: z.array(z.object({ symbol: z.string(), amount: z.string(), readable: z.string(), token: z.string().nullable() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: ready,
  async run(input, ctx) {
    const out = await readBalances(ctx.agentId, input.network);
    return {
      network: WALLET_NETWORKS[input.network].label,
      address: out.address,
      balances: out.balances.map((b) => ({ symbol: b.symbol, amount: b.amount, readable: `${formatUnits(b.amount, b.decimals)} ${b.symbol}`, token: b.token })),
      detail: out.detail,
    };
  },
});

const networkStatus = defineCapability({
  id: 'wallet.network_status',
  name: 'Wallet network status',
  description: 'Whether a network your wallet uses can be reached right now, and its latest block or slot.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ network: WalletNetworkId }),
  output: z.object({ network: z.string(), reachable: z.boolean(), height: z.string().nullable(), detail: z.string() }),
  modelCallable: true,
  timeoutMs: 15_000,
  readiness: ready,
  async run(input) {
    const a = walletAdapter();
    if (!a) return { network: WALLET_NETWORKS[input.network].label, reachable: false, height: null, detail: walletReadiness().detail };
    const status = await a.networkStatus(input.network);
    return { network: WALLET_NETWORKS[input.network].label, reachable: status.reachable, height: status.height, detail: status.detail };
  },
});

const recentActivity = defineCapability({
  id: 'wallet.recent_activity',
  name: 'Own wallet activity',
  description: 'Recent transactions in and out of your own wallet on one network.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ network: WalletNetworkId, limit: z.number().int().min(1).max(20).default(10) }),
  output: z.object({
    network: z.string(),
    address: z.string().nullable(),
    activity: z.array(z.object({ txHash: z.string(), direction: z.string(), amount: z.string().nullable(), symbol: z.string().nullable(), at: z.string().nullable(), status: z.string() })),
    detail: z.string(),
  }),
  modelCallable: true,
  timeoutMs: 20_000,
  readiness: ready,
  async run(input, ctx) {
    const out = await readActivity(ctx.agentId, input.network, input.limit);
    return {
      network: WALLET_NETWORKS[input.network].label,
      address: out.address,
      activity: out.activity,
      detail: out.address ? `${out.activity.length} recent transactions.` : 'You have no wallet on that network.',
    };
  },
});

export const WALLET_CAPABILITIES = [address, balances, networkStatus, recentActivity] as unknown as AnyCapability[];

export function registerWalletCapabilities(): void {
  for (const capability of WALLET_CAPABILITIES) registerCapability(capability);
}
