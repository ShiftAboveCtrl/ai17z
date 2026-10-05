/**
 * Prints the egress ruleset AI17Z would load for one tenant's interface.
 *
 *   npm run tenant:ruleset -- --tap tapab12cd34
 *
 * The lab needs a ruleset per tenant, and a ruleset written by hand in the lab
 * would prove the lab's opinion rather than the product's. This renders the
 * same plan `hosted-egress-proof.mts` loads into a kernel, so a guest booting
 * behind it is behind what AI17Z itself would apply.
 */
import { egressPlan, nftablesRuleset } from '@xbam/runtime';

const argv = process.argv.slice(2);
const at = argv.indexOf('--tap');
const tap = at >= 0 ? argv[at + 1] : undefined;
if (!tap) {
  process.stderr.write('usage: tenant-ruleset.mts --tap <iface>\n');
  process.exit(2);
}

process.stdout.write(`${nftablesRuleset(egressPlan(), tap)}\n`);
