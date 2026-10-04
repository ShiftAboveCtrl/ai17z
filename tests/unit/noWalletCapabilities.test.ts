import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCapabilities, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { NEVER_MODEL_CALLABLE, capabilityCrossesTheLine, registerManagementCapabilities, registerWalletCapabilities } from '@xbam/runtime';

/**
 * Paying for something is the owner's act, never the agent's.
 *
 * The one payment AI17Z prepares (MARKETPLACE_PLUGIN_PURCHASE) is reached only
 * from an owner's button through `/api/studio/purchases/*`, and a transaction
 * from an agent's own wallet only through the owner's wallet routes, approved
 * by its exact digest. Nothing a model can choose may send, transfer, approve,
 * swap or sign, and neither path may be imported by the capability layer,
 * where it would be one refactor away from being offered.
 *
 * An agent may read its own wallet, and only through these four.
 */
const WALLET_READS = ['wallet.address', 'wallet.balances', 'wallet.network_status', 'wallet.recent_activity'];

const MONEY = /\b(send|transfer|approve|swap|sign)[_ ]?(token|tokens|funds|payment|transaction|tx|eth|erc20|ai17z|message)?\b|\bwallet\b|\bpurchase\b|\bpay(ment)?\b|calldata|call_contract/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function registerAll() {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  registerManagementCapabilities();
  registerWalletCapabilities();
}

describe('no capability can move money', () => {
  it('registers nothing whose name or purpose is a payment, except the four wallet reads', () => {
    registerAll();
    const offenders = listCapabilities().filter((c) => MONEY.test(`${c.id} ${c.name}`) && !WALLET_READS.includes(c.id));
    expect(offenders.map((c) => c.id)).toEqual([]);
  });

  it('the wallet capabilities are exactly four reads, off until the owner enables them, and owner only', () => {
    registerAll();
    const wallet = listCapabilities().filter((c) => c.id.startsWith('wallet.'));
    expect(wallet.map((c) => c.id).sort()).toEqual([...WALLET_READS].sort());
    for (const c of wallet) {
      expect(c.effect, c.id).toBe('READ');
      expect(c.unsetPermission, c.id).toBe('DISABLED');
      expect(c.audience, c.id).toBe('OWNER');
    }
    for (const forbidden of ['send', 'transfer', 'approve', 'sign', 'sign_message', 'call_contract', 'send_calldata']) {
      expect(listCapabilities().map((c) => c.id)).not.toContain(`wallet.${forbidden}`);
    }
  });

  it('keeps the purchase builder and the wallet submit path out of the capability layer', () => {
    const root = join(__dirname, '..', '..', 'packages');
    const reachable = [
      ...walk(join(root, 'tools', 'src')),
      join(root, 'runtime', 'src', 'pluginCapabilities.ts'),
      join(root, 'runtime', 'src', 'capabilityLoop.ts'),
      join(root, 'runtime', 'src', 'walletCapabilities.ts'),
      join(root, 'runtime', 'src', 'managementCapabilities.ts'),
    ];
    for (const file of reachable) {
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      expect(text, file).not.toMatch(/prepareMarketplacePurchase|prepareStudioPurchase|eth_sendTransaction|encodeTransfer/);
      expect(text, file).not.toMatch(/\b(submitIntent|approveIntent|draftIntent|simulateIntent|sealedSecretOf|openSecret)\b|\.sign\(|\.broadcast\(/);
    }
  });
});

/**
 * The same line, for trading.
 *
 * Here rather than in a file of its own, because "can a model move value" has
 * one answer and two places that both look authoritative about it is how
 * something ends up allowed on one and refused on the other.
 */
describe('no capability can place a trade either', () => {
  it('registers no trade capability at all yet', () => {
    registerAll();
    // When one appears it has to come with a decision about effect, audience
    // and default permission, and this failing is where that decision gets
    // made rather than inherited.
    expect(listCapabilities().filter((c) => c.id.startsWith('trade.')).map((c) => c.id)).toEqual([]);
  });

  it('refuses every registered capability whose verb is a generic transaction', () => {
    registerAll();
    const offenders = listCapabilities().filter((c) => !capabilityCrossesTheLine(c.id).ok);
    expect(offenders.map((c) => c.id)).toEqual([]);
  });

  it('names the verbs, so the list cannot quietly shrink', () => {
    for (const verb of ['send', 'transfer', 'approve', 'sign', 'signTypedData', 'contractCall', 'calldata']) {
      expect(NEVER_MODEL_CALLABLE, verb).toContain(verb);
    }
  });
});
