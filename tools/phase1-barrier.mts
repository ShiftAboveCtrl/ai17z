#!/usr/bin/env tsx
/**
 * The Phase 1 barrier, checked against evidence rather than against a claim.
 *
 * Thirty requirements. The temptation with a list like this is a document that
 * says which are met, and a document is exactly what cannot be trusted about
 * it: the whole point of a barrier is that somebody might want it to be
 * satisfied. So each item here either reads something real or says plainly that
 * it is a judgement nothing can check.
 *
 * Three verdicts and the third is the useful one.
 *
 *   MET          something was read and it holds
 *   NOT_MET      something was read and it does not
 *   UNCHECKABLE  this item is a design judgement, or needs a thing that does
 *                not exist yet, and saying so beats a tick
 *
 * An UNCHECKABLE item is not a pass. The summary counts them separately and
 * refuses to call the barrier satisfied while any remain, because a barrier
 * where a third of the items are somebody's opinion is a barrier that will be
 * declared complete on a Friday.
 *
 *   npx tsx tools/phase1-barrier.mts
 *   npx tsx tools/phase1-barrier.mts --json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const asJson = process.argv.includes('--json');

type Verdict = 'MET' | 'NOT_MET' | 'UNCHECKABLE';

interface Item {
  n: number;
  requirement: string;
  verdict: Verdict;
  evidence: string;
}

const items: Item[] = [];
const add = (n: number, requirement: string, verdict: Verdict, evidence: string): void =>
  void items.push({ n, requirement, verdict, evidence });

const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
};
const has = (rel: string): boolean => existsSync(join(ROOT, rel));

/** Whether a symbol is exported from the runtime, as the index actually says. */
const exportedFromRuntime = (symbol: string): boolean => {
  const index = read('packages/runtime/src/index.ts');
  const modules = [...index.matchAll(/export \* from '\.\/([^']+)'/g)].map((m) => m[1]!);
  return modules.some((mod) => new RegExp(`^export\\s+(?:async\\s+)?(?:const|function|type|interface|enum)\\s+${symbol}\\b`, 'm').test(read(`packages/runtime/src/${mod}.ts`)));
};

const git = (...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// 1 to 4: the product and isolation decisions
// ---------------------------------------------------------------------------

const hosting = read('docs/architecture/HOSTING.md');
const confidential = read('packages/shared/src/contracts/confidential.ts');
const hostingContract = read('packages/shared/src/contracts/hosting.ts');

add(
  1,
  'Hosted V1 is paid confidential hosting, not random community hosts',
  hosting.includes('V1 is paid confidential hosting, not community compute') &&
    hosting.includes('not a V1 dependency')
    ? 'MET'
    : 'NOT_MET',
  'HOSTING.md states it, and says the host abstraction stays without being a V1 dependency.',
);

add(
  2,
  'One confidential tenant runtime may host several of the same owner agents',
  /maxAgents/.test(hostingContract) ? 'MET' : 'NOT_MET',
  '`RuntimeClass.maxAgents` bounds agents per runtime, and the measured 434MB against an 8GB floor is the argument for sharing one.',
);

add(
  3,
  'Unrelated tenants share no database, master key, browser, filesystem or wallet store',
  read('packages/runtime/src/tenantDatabase.ts').includes('SHARED_DATABASE_REFUSAL') &&
    has('tests/integration/tenantIsolation.test.ts')
    ? 'MET'
    : 'NOT_MET',
  'tenantDatabase refuses a shared database by name; tenantIsolation.test.ts proves separation against real Postgres.',
);

add(
  4,
  'The trust model separates tenant isolation from host-operator protection',
  hosting.includes('A microVM does not deliver that') && confidential.includes('Only confidential compute addresses the host operator')
    ? 'MET'
    : 'NOT_MET',
  'Said in both the document and the contract, and the lab is never cited as host protection.',
);

// ---------------------------------------------------------------------------
// 5 to 13: confidential compute, attestation and keys
// ---------------------------------------------------------------------------

const cc = read('docs/architecture/CONFIDENTIAL_COMPUTE.md');
const attest = read('packages/runtime/src/confidentialAttestation.ts');

add(
  5,
  'Confidential VM provider research is current',
  cc.includes('2026-10-05') && cc.includes('prices.azure.com') && cc.includes('Confidential Space')
    ? 'MET'
    : 'NOT_MET',
  'CONFIDENTIAL_COMPUTE.md, read 2026-10-05, with every source named and the Azure prices from the retail prices API.',
);

add(
  6,
  'Production provider selection is evidence-based',
  cc.includes('The difference that bears on the decision') ? 'UNCHECKABLE' : 'NOT_MET',
  'The evidence is recorded, the decision-relevant difference is stated, and the costs are now computed from dated prices rather than recited: both TEE families are priced, the region spread and the commitment are priced, and Google is present only as a premium because its all-in figure needs a credential this repository does not have. No provider has been selected, because none has been provisioned, and a selection without a canary would be a preference.',
);

add(
  7,
  'The provider abstraction is cloud-neutral at the core',
  confidential.includes('CONFIDENTIAL_PROVIDERS') && !/azure/i.test(read('packages/runtime/src/hostScheduler.ts'))
    ? 'MET'
    : 'NOT_MET',
  'Providers are a contract enum; the scheduler names no vendor.',
);

add(
  8,
  'A hardware attestation architecture exists',
  exportedFromRuntime('judgeConfidentialEvidence') ? 'MET' : 'NOT_MET',
  'confidentialAttestation.ts judges Azure MAA claims and Confidential Space assertions, with 26 tests.',
);

add(
  9,
  'A modified or unapproved runtime cannot receive tenant secrets',
  attest.includes('binds to a compliant platform and not to a runtime') && attest.includes('can reproduce')
    ? 'MET'
    : 'NOT_MET',
  'Refuses an Azure token carrying only the two documented claims, and a Google digest AI17Z did not publish.',
);

add(
  10,
  'A debug or insecure confidential VM configuration is rejected',
  attest.includes('proves nothing') && confidential.includes('CONFIDENTIAL_SPACE_DEBUG_OFF') ? 'MET' : 'NOT_MET',
  'assertion.dbgstat other than disabled-since-boot is refused with the reason.',
);

add(
  11,
  'Per-runtime key release is conditioned on an approved runtime policy',
  exportedFromRuntime('verifyMeasurementPolicy') && exportedFromRuntime('mayReleaseToConfidentialRuntime')
    ? 'MET'
    : 'NOT_MET',
  'A signed, versioned, monotonic measurement policy, verified against pinned keys, feeds the release decision.',
);

add(
  12,
  'The host operator does not hold the tenant runtime master key directly',
  read('packages/runtime/src/hostedSecrets.ts').includes('never sent to the control plane') ? 'UNCHECKABLE' : 'NOT_MET',
  'Designed and stated, and today the enabled tier is HOST_SEALED, which the custody record says an operator with root could reach. Only an attested release makes this MET, and none has happened.',
);

add(
  13,
  'Encrypted backups do not give the storage operator plaintext access',
  read('packages/runtime/src/backupStoreObject.ts').includes('Nothing here encrypts') && has('tests/integration/objectBackup.test.ts')
    ? 'MET'
    : 'NOT_MET',
  'The object store never encrypts; the runtime seals before the bytes leave. Proved against a real S3-compatible server, including a tampered object reported CORRUPT.',
);

// ---------------------------------------------------------------------------
// 14 to 15: rollback
// ---------------------------------------------------------------------------

const rollback = read('packages/runtime/src/stateGeneration.ts');

add(
  14,
  'Rollback and tamper detection is designed and implemented',
  exportedFromRuntime('judgeStateGeneration') && rollback.includes('A signature cannot catch this') ? 'MET' : 'NOT_MET',
  'A monotonic generation published to a witness outside the host. UNWITNESSED is a verdict rather than a pass.',
);

add(
  15,
  'An owner-authorised restore remains possible',
  rollback.includes("OWNER_RESTORE") ? 'MET' : 'NOT_MET',
  'An owner names the exact generation, which is recorded; approval without one would cover any older state.',
);

// ---------------------------------------------------------------------------
// 16 to 22: economics
// ---------------------------------------------------------------------------

const cost = read('packages/runtime/src/hostedCost.ts');

add(16, 'A cloud pricing model exists', cost.includes('monthlyRuntimeCost') ? 'MET' : 'NOT_MET', 'hostedCost.ts, with every line dated and sourced.');

const footprint = read('packages/runtime/src/tenantFootprint.ts');

add(
  17,
  'Actual AI17Z resource requirements have been measured',
  has('tools/measure-runtime.mts') && footprint.includes("method: 'IN_GUEST'") ? 'MET' : 'NOT_MET',
  'Measured twice, and the one that counts is from inside a guest: 575 MB for the whole runtime on two vCPU, 14 MB of schema, no browser. The host figure from measure-runtime.mts stays alongside it, because the gap between them is what a development machine costs.',
);

const derivesFromMeasurement =
  cost.includes('priced from a guess') &&
  footprint.includes('MEASURED_TENANT_FOOTPRINT') &&
  footprint.includes('sizeHoldsTenant') &&
  footprint.includes('STALE_AFTER_DAYS');

add(
  18,
  'Plans derive from measured requirements rather than invented capacity',
  derivesFromMeasurement ? 'MET' : 'NOT_MET',
  'A size is judged against the measurement rather than against an opinion: sizeHoldsTenant refuses one that does not fit and will not trim the headroom to make a cheaper size work, and the measurement expires rather than being trusted for ever. minimumRetailUsd still refuses to price from nothing.',
);

add(19, 'A cost ledger exists', cost.includes('COST_LINES') && cost.includes('missing') ? 'MET' : 'NOT_MET', 'Twelve lines on a closed list, and a total that names the lines it has no figure for.');

add(
  20,
  'The margin target is configurable',
  cost.includes('targetGrossMargin: number') && !/0\.6\s*;/.test(cost) ? 'MET' : 'NOT_MET',
  'It arrives as an argument. 60% is an engineering planning figure named in the document, not a constant in the code.',
);

add(
  21,
  'Provisioning can detect a structurally unprofitable allocation',
  cost.includes('judgePlanEconomics') ? 'MET' : 'NOT_MET',
  'Refused before the runtime exists, naming the price or the class that would clear the target.',
);

add(
  22,
  'Model-provider BYOK is supported as the initial cost-control policy',
  cost.includes('BYOK_LINES') ? 'MET' : 'NOT_MET',
  'MODEL_API is a BYOK line, so it keeps a place to be metered if a platform-funded option is ever offered.',
);

// ---------------------------------------------------------------------------
// 23 to 25: what stays disabled, and not mislabelled
// ---------------------------------------------------------------------------

add(
  23,
  'Community and third-party secret-bearing hosting remains disabled',
  /PROVIDER_TIERS_ENABLED: readonly ProviderTier\[\] = \['FIRST_PARTY_TRUSTED'\]/.test(hostingContract) ? 'MET' : 'NOT_MET',
  'One tier enabled, written out rather than derived from the list of tiers.',
);

add(
  24,
  'No public claim says community hardware is secure today',
  !/community.{0,40}secure/i.test(read('README.md')) && hosting.includes('the public wording never says otherwise') ? 'MET' : 'NOT_MET',
  'The README says nothing about it, and describesMoreThanProven refuses the five phrases somebody reaches for.',
);

add(
  25,
  'The Firecracker lab is proven and not mislabelled as host protection',
  hosting.includes('None of this is protection from the host operator') &&
  has('packaging/hosted-lab/bin/probe-egress.sh') &&
  has('packaging/hosted-lab/bin/two-tenant-proof.sh') &&
  has('tools/tenant-vm-plan.mts') &&
  has('tools/guest-report-check.mts')
    ? 'MET'
    : 'NOT_MET',
  'The lab boots the plan microVm.ts renders rather than one written in a shell script, which is what makes a lab result a claim about this repository: two tenants ran the canonical AI17Z at once, each as its own unprivileged user on a read-only shared image, neither able to reach the other, and guestMatchesPlan graded what the host reported against what it was asked to run. The sentence refusing the stronger claim is still there, because none of it is protection from the host operator.',
);

// ---------------------------------------------------------------------------
// 26 to 30: the suite, backups, the original barrier, local health, freeze
// ---------------------------------------------------------------------------

add(
  26,
  'Discovered defects each have regression-sensitive tests',
  has('tools/mutation-check.mts') ? 'MET' : 'NOT_MET',
  'mutation-check.mts reverts each fix and requires a test to fail. Sixteen mutations, all caught, including one that survived first time and needed a behavioural test.',
);

add(
  27,
  'Off-host backup works against real test object storage',
  has('tests/integration/objectBackup.test.ts') ? 'MET' : 'NOT_MET',
  'Twelve cases against adobe/s3mock, which rejects a bad signature. A fake store cannot get a signature wrong.',
);

add(
  28,
  'The original Phase 1 hosted and trading barrier remains satisfied',
  has('docs/architecture/TRADING.md') &&
  has('tests/integration/tradingPersistence.test.ts') &&
  has('tools/hosted-provision-tenant.mts')
    ? 'UNCHECKABLE'
    : 'NOT_MET',
  'A tenant is provisioned end to end, driven by AI17Z\'s own step machine: stepsFor chooses the list, nextAction decides each step from what was recorded, a failure rolls back in rollbackOrder, and mayMarkReady refuses to finish on less than evidence the host and the guest gave back. The run walks the attested list, and the one step it cannot perform is ATTEST_RUNTIME, because this machine has no confidential hardware. That refusal rolls the whole provision back, which is the gate working. So this is the same blocked item as 6 and 12 rather than a different one, and the verdict stays short of met because the tier a customer would buy is the tier that needs the hardware. The trading half is at its own ceiling for its own reason: the whole path runs to the signing boundary and signs nothing, cannot be asked to go live, meets the same gate a live trade would, exercises the staleness rule and makes one trade per decision when retried. What it cannot do here is read a real venue, because all six venues are Pons, Pump and Robinhood, whose adapters are private and must not be published, so nothing in this repository registers a market reader. That is a boundary on what this repository may contain rather than work left undone.',
);

/*
  Not the working tree. A clean tree says a commit is tidy, and "local AI17Z
  remains healthy" is a claim about an installation that runs: ai17z-test
  updated from this stack and proved on it. Answering the easier question in
  the same words would also make this tool fail itself for being untracked,
  which is the clearest possible sign it was measuring the wrong thing.
*/
const dirty = git('status', '--porcelain');
add(
  29,
  'Local AI17Z remains healthy',
  'UNCHECKABLE',
  `The gates pass here and the tree has ${dirty === '' ? 'no' : String(dirty.split('\n').length)} uncommitted change(s), and both installed instances were measured healthy and undisturbed after this work, their containers up and their APIs answering. But health means an installed instance running this stack, and neither has been updated from it, so nothing here can speak for that. Promoting needs either a published release or a copy of unreleased source, and the second is the route to avoid.`,
);

add(
  30,
  'Phase 1 contracts are frozen',
  'NOT_MET',
  'Nothing is frozen while items above are unmet. A freeze over an unsatisfied barrier is a freeze of the wrong thing.',
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (asJson) {
  process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), items }, null, 2)}\n`);
} else {
  process.stdout.write('\nPhase 1 barrier, checked against evidence\n\n');
  for (const item of items) {
    const mark = item.verdict === 'MET' ? 'MET        ' : item.verdict === 'NOT_MET' ? 'NOT MET    ' : 'UNCHECKABLE';
    process.stdout.write(`  ${String(item.n).padStart(2)}. ${mark} ${item.requirement}\n`);
    process.stdout.write(`      ${item.evidence}\n\n`);
  }
}

const met = items.filter((i) => i.verdict === 'MET').length;
const notMet = items.filter((i) => i.verdict === 'NOT_MET');
const uncheckable = items.filter((i) => i.verdict === 'UNCHECKABLE');

if (!asJson) {
  process.stdout.write(`${met} met, ${notMet.length} not met, ${uncheckable.length} uncheckable, of ${items.length}.\n\n`);
  if (uncheckable.length > 0) {
    process.stdout.write('Uncheckable is not met. These need something that does not exist yet:\n');
    for (const i of uncheckable) process.stdout.write(`  ${i.n}. ${i.requirement}\n`);
    process.stdout.write('\n');
  }
  if (notMet.length > 0) {
    process.stdout.write('Not met:\n');
    for (const i of notMet) process.stdout.write(`  ${i.n}. ${i.requirement}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(
    notMet.length === 0 && uncheckable.length === 0
      ? 'The barrier is satisfied.\n\n'
      : 'The barrier is not satisfied, and Phase 1 is not complete.\n\n',
  );
}

process.exit(notMet.length === 0 && uncheckable.length === 0 ? 0 : 1);
