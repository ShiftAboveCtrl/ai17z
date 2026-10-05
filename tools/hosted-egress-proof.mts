#!/usr/bin/env tsx
/**
 * Proves the egress guard against a real kernel rather than against a string.
 *
 * `verifyLoadedRuleset` exists because a rule that was generated is not a rule
 * that is loaded. Everything that checks it so far has handed it text this
 * repository rendered itself, which proves the comparison and not the claim:
 * nothing had established that the ruleset `nftablesRuleset` produces is a
 * ruleset a kernel accepts, or that what the kernel reports back still passes.
 *
 * So this loads it, reads it back out of the kernel, and verifies that. Then it
 * does the half that matters: it removes one denial, reloads, and confirms the
 * verifier notices. A checker that cannot fail has not been tested.
 *
 *   npx tsx tools/hosted-egress-proof.mts --netns ai17z-tenant-alpha --tap tapd10b4f3e
 *   npx tsx tools/hosted-egress-proof.mts --netns ... --tap ... --json
 *
 * It needs nftables and a network namespace, so on Windows it reaches a Linux
 * host through `wsl -u root`. That is the development lab, and it is named here
 * rather than hidden so nobody mistakes this for something the product does.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANDATORY_DENIALS, egressPlan, nftablesRuleset, verifyLoadedRuleset } from '@xbam/runtime';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const asJson = argv.includes('--json');
const netns = flag('netns');
const tap = flag('tap');

if (!netns || !tap) {
  process.stderr.write('usage: hosted-egress-proof.mts --netns <name> --tap <iface> [--json]\n');
  process.exit(2);
}

/**
 * Runs a command on the Linux side.
 *
 * On Linux that is the shell. On Windows it is `wsl -u root`, which is the
 * development lab's elevation path: there is no production code path here and
 * nothing in the product shells out like this.
 */
function onLinux(script: string): string {
  if (process.platform === 'linux') {
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  }
  return execFileSync('wsl.exe', ['-u', 'root', '-e', 'bash', '-c', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Writes a ruleset where the Linux side can read it, and returns that path. */
function stage(contents: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai17z-egress-'));
  const local = join(dir, name);
  // Unix line endings: nft reads a stray carriage return as part of a token.
  writeFileSync(local, contents.replace(/\r\n/g, '\n'), 'utf8');
  if (process.platform === 'linux') return local;
  /*
    Converted here rather than by asking `wslpath`, because handing wslpath a
    path that has already been converted converts it twice: `C:/x` became
    `/mnt/C/x` became `/mnt/c/mnt/C/x`, and nft reported a file that was not
    there. The drive letter is lower-cased because that is how the mount point
    is spelled.
  */
  return local.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, drive: string) => `/mnt/${drive.toLowerCase()}`);
}

interface Step {
  step: string;
  outcome: 'PASS' | 'FAIL';
  detail: string;
}
const steps: Step[] = [];
const record = (step: string, outcome: 'PASS' | 'FAIL', detail: string): void => void steps.push({ step, outcome, detail });

const plan = egressPlan();
const ruleset = nftablesRuleset(plan, tap);

// ---------------------------------------------------------------------------
// 1. A kernel accepts what this repository renders.
// ---------------------------------------------------------------------------
try {
  const path = stage(ruleset, 'egress.nft');
  onLinux(`ip netns exec ${netns} nft flush ruleset && ip netns exec ${netns} nft -f ${path}`);
  record('A kernel accepts the generated ruleset', 'PASS', `${plan.rules.length} rules loaded into ${netns}.`);
} catch (error) {
  record('A kernel accepts the generated ruleset', 'FAIL', `nft refused it: ${(error as Error).message.split('\n')[0]}`);
}

// ---------------------------------------------------------------------------
// 2. What the kernel reports back still passes the guard.
// ---------------------------------------------------------------------------
let observed = '';
try {
  observed = onLinux(`ip netns exec ${netns} nft list ruleset`);
  const verdict = verifyLoadedRuleset(observed, plan);
  if (verdict.enforced) {
    record(
      'The guard passes what the kernel reports',
      'PASS',
      `All ${MANDATORY_DENIALS.length} mandatory denials are present in the kernel's own output, and the chain drops by default.`,
    );
  } else {
    record('The guard passes what the kernel reports', 'FAIL', `${verdict.why} ${verdict.missing.join(' ')}`);
  }
} catch (error) {
  record('The guard passes what the kernel reports', 'FAIL', `could not read the ruleset: ${(error as Error).message}`);
}

// ---------------------------------------------------------------------------
// 3. The half that matters: the guard notices a missing denial.
//
// A checker that cannot fail has not been tested. One denial is removed, the
// ruleset is reloaded, and the guard has to say so about the kernel's own
// output rather than about the text that was rendered.
// ---------------------------------------------------------------------------
const victim = '0.0.0.0/8';
try {
  const weakened = ruleset
    .split('\n')
    .filter((line) => !line.includes(` ${victim} `))
    .join('\n');
  const path = stage(weakened, 'egress-weakened.nft');
  onLinux(`ip netns exec ${netns} nft flush ruleset && ip netns exec ${netns} nft -f ${path}`);
  const weakenedObserved = onLinux(`ip netns exec ${netns} nft list ruleset`);
  const verdict = verifyLoadedRuleset(weakenedObserved, plan);
  if (!verdict.enforced && verdict.missing.includes(victim)) {
    record(
      'The guard notices a denial the kernel is missing',
      'PASS',
      `${victim} was removed and the guard named it, from the kernel's output. Note that 10.0.0.0/8 is still loaded and contains those characters, which is the case a substring test passed.`,
    );
  } else {
    record(
      'The guard notices a denial the kernel is missing',
      'FAIL',
      verdict.enforced ? 'the guard passed a ruleset missing a mandatory denial' : `it refused for the wrong reason: ${verdict.why}`,
    );
  }
} catch (error) {
  record('The guard notices a denial the kernel is missing', 'FAIL', `${(error as Error).message}`);
}

// ---------------------------------------------------------------------------
// 4. Put the real ruleset back, so the lab is left filtered.
// ---------------------------------------------------------------------------
try {
  const path = stage(ruleset, 'egress.nft');
  onLinux(`ip netns exec ${netns} nft flush ruleset && ip netns exec ${netns} nft -f ${path}`);
  const back = onLinux(`ip netns exec ${netns} nft list ruleset`);
  const verdict = verifyLoadedRuleset(back, plan);
  record(
    'The namespace is left filtered',
    verdict.enforced ? 'PASS' : 'FAIL',
    verdict.enforced ? 'The full ruleset is loaded again.' : 'The lab was left without its rules, which needs attention.',
  );
} catch (error) {
  record('The namespace is left filtered', 'FAIL', `${(error as Error).message}`);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ netns, tap, steps }, null, 2)}\n`);
} else {
  const width = Math.max(...steps.map((s) => s.step.length));
  process.stdout.write(`\nEgress guard against a real kernel, namespace ${netns}\n\n`);
  for (const s of steps) {
    process.stdout.write(`  ${s.step.padEnd(width)}  ${s.outcome}\n`);
    process.stdout.write(`  ${' '.repeat(width)}  ${s.detail}\n\n`);
  }
}

const failed = steps.filter((s) => s.outcome === 'FAIL').length;
if (!asJson) {
  process.stdout.write(failed === 0 ? 'The guard is checking a kernel, not a string.\n\n' : `${failed} step(s) failed.\n\n`);
}
process.exit(failed === 0 ? 0 : 1);
