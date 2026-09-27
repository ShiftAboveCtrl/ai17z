import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCapabilities, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';

/**
 * Paying for something is the owner's act, never the agent's.
 *
 * The one payment AI17Z prepares (MARKETPLACE_PLUGIN_PURCHASE) is reached only
 * from an owner's button through `/api/studio/purchases/*`. Nothing a model
 * can choose may send, transfer, approve, swap or sign, and the purchase code
 * must never be imported by the capability layer, where it would be one
 * refactor away from being offered.
 */

const MONEY = /\b(send|transfer|approve|swap|sign)[_ ]?(token|tokens|funds|payment|transaction|tx|eth|erc20|ai17z)\b|\bwallet\b|\bpurchase\b|\bpay(ment)?\b/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('no capability can move money', () => {
  it('registers nothing whose name or purpose is a payment', () => {
    resetCapabilitiesForTest();
    registerBuiltinCapabilities();
    const offenders = listCapabilities().filter((capability) => MONEY.test(`${capability.id} ${capability.name}`));
    expect(offenders.map((c) => c.id)).toEqual([]);
  });

  it('keeps the purchase builder out of the capability layer', () => {
    const root = join(__dirname, '..', '..', 'packages');
    const reachable = [...walk(join(root, 'tools', 'src')), join(root, 'runtime', 'src', 'pluginCapabilities.ts'), join(root, 'runtime', 'src', 'capabilityLoop.ts')];
    for (const file of reachable) {
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      expect(text, file).not.toMatch(/prepareMarketplacePurchase|prepareStudioPurchase|eth_sendTransaction|encodeTransfer/);
    }
  });
});
