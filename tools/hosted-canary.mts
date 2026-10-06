#!/usr/bin/env tsx
/**
 * The confidential hardware canary, rendered in full, as one command.
 *
 * Three barrier items wait on the same thing: a confidential VM nobody has
 * provisioned. Everything that does not need the hardware is built, so what
 * remains ought to be configuration rather than work, and this is the command
 * that proves that claim instead of asserting it. It renders every request the
 * canary would send, names the exact credential each provider is missing, and
 * refuses at the end rather than implying anything has run.
 *
 * It exists because "blocked on confidential hardware" is a sentence, and a
 * sentence cannot be checked. Somebody with a cloud subscription should be able
 * to read this output, see the one thing they have to supply, supply it, and run
 * the canary. If they cannot, the remaining work was not configuration after
 * all, and the output will say which part.
 *
 * **Nothing here provisions, pays for, or contacts anything.** Every adapter
 * operation is a render or a refusal, which is a property of the adapters
 * rather than of this script: `live()` returns `executed: false` by
 * construction and `renderProvision` returns `provisioned: false`. This asserts
 * both on the way past, because a tool that reported them would be trusting the
 * thing it is reporting on.
 *
 *   npm run hosted:canary
 *   npm run hosted:canary -- --json
 *   npm run hosted:canary -- --emit <dir>    write each body, with the command that sends it
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  CONFIDENTIAL_SKUS,
  MEASURED_TENANT_FOOTPRINT,
  PROVIDER_CAVEATS,
  azureConfidential,
  googleConfidential,
  providerMayHold,
  requestProblems,
  sizeHoldsTenant,
  type ConfidentialProviderAdapter,
  type KeyReleaseRequest,
  type LiveOperation,
  type RuntimeRequest,
} from '../packages/runtime/src/index';

const asJson = process.argv.includes('--json');
const out: string[] = [];
const say = (line = ''): void => void out.push(line);

/**
 * One clock for the whole run.
 *
 * `sizeHoldsTenant` takes the time explicitly rather than reading it, so a
 * footprint that has gone stale says so against a time somebody chose. Reading
 * the clock twice in one report could size two providers against two different
 * answers about whether the measurement still counts.
 */
const NOW = new Date();

/**
 * The measurement the rendered request carries.
 *
 * Deliberately recognisable rather than random: anybody reading the rendered
 * body should see at a glance that it is a placeholder, and `requestProblems`
 * refuses anything that is not hash-shaped, so it has to be 96 hex characters
 * to render at all. The real measurement comes from building the runtime image,
 * which is step three.
 */
const PLACEHOLDER_MEASUREMENT = 'f'.repeat(96);

/** Everything the canary would need a live provider for, in the order it would need it. */
const CANARY_OPERATIONS: readonly LiveOperation[] = ['START', 'HEALTH', 'FETCH_ATTESTATION', 'SNAPSHOT', 'STOP', 'DELETE'];

/**
 * The runtime the canary would provision.
 *
 * One tenant, the smallest size that holds the measured footprint with its
 * headroom, in the region that size was actually priced in. Generation 1
 * because a canary is the first generation by definition, and a measurement
 * rather than an image tag because a tag is not what a TEE attests to.
 */
function canaryRequest(adapter: ConfidentialProviderAdapter): { request: RuntimeRequest; note: string } | { note: string } {
  const offered = adapter.skus();
  if (offered.length === 0) {
    return {
      note: `${adapter.provider} offers no priced size, so there is nothing to render a request against. Picking one anyway would mean quoting a price from memory, which is the thing this subsystem is arranged to avoid.`,
    };
  }
  const fitting = offered.filter((sku) => sizeHoldsTenant(sku, MEASURED_TENANT_FOOTPRINT, NOW).fits);
  const smallest = [...fitting].sort((a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb)[0];
  if (smallest === undefined) {
    // Named rather than counted: the reason the smallest was refused is the
    // useful half, and a stale measurement refuses every size at once.
    const why = sizeHoldsTenant(offered[0]!, MEASURED_TENANT_FOOTPRINT, NOW);
    return {
      note: `No ${adapter.provider} size holds the measured tenant footprint of ${MEASURED_TENANT_FOOTPRINT.memoryMb} MB with its headroom, out of ${offered.length} priced. ${why.why}`,
    };
  }
  return {
    request: {
      runtimeId: 'canary-0001',
      tenantId: 'canary-tenant',
      sku: smallest,
      region: smallest.region,
      // A well-formed placeholder, so the request renders and can be reviewed.
      // Step three of the canary replaces it with the real measurement of the
      // built image: this is the shape, not the identity, and the output says so.
      imageMeasurement: PLACEHOLDER_MEASUREMENT,
      dataDiskGb: 32,
      generation: 1,
    },
    note: `${smallest.sku} in ${smallest.region}, the smallest priced ${adapter.provider} size that holds the measured footprint.`,
  };
}

interface ProviderReport {
  provider: string;
  version: string;
  ready: boolean;
  missing: { name: string; how: string }[];
  mayHold: boolean;
  mayHoldWhy: string;
  sizing: string;
  provision:
    | { operation: string; method: string; path: string; monthlyUsd: number; asserts: readonly string[]; body: Record<string, unknown> }
    | { refused: string };
  policy: { attachesTo: string; binds: string; refuses: readonly string[]; policy: Record<string, unknown> } | { refused: string };
  live: { operation: string; method: string; path: string; why: string }[];
}

function report(adapter: ConfidentialProviderAdapter): ProviderReport {
  const readiness = adapter.readiness();
  const hold = providerMayHold(adapter.provider);
  const chosen = canaryRequest(adapter);

  let provision: ProviderReport['provision'] = { refused: chosen.note };
  let policy: ProviderReport['policy'] = { refused: 'No request to attach a policy to.' };

  if ('request' in chosen) {
    const problems = requestProblems(chosen.request, CONFIDENTIAL_SKUS);
    if (problems.length > 0) {
      provision = { refused: `The request is unsound before any provider sees it: ${problems.join(' ')}` };
    } else {
      const outcome = adapter.renderProvision(chosen.request);
      if (outcome.rendered) {
        // Rendering is not provisioning, and this asserts it rather than
        // repeating what the adapter said about itself.
        if (outcome.request.provisioned !== false) {
          throw new Error(`${adapter.provider} returned a rendered request claiming to be provisioned. That is the one thing this contract forbids.`);
        }
        provision = {
          operation: outcome.request.operation,
          method: outcome.request.method,
          path: outcome.request.path,
          monthlyUsd: outcome.request.monthlyUsd,
          asserts: outcome.request.asserts,
          body: outcome.request.body,
        };
      } else {
        provision = { refused: `${outcome.why}${outcome.missing.length > 0 ? ` Missing: ${outcome.missing.map((m) => m.name).join(', ')}.` : ''}` };
      }
    }

    const keyRequest: KeyReleaseRequest = {
      runtimeId: chosen.request.runtimeId,
      tenantId: chosen.request.tenantId,
      imageMeasurement: chosen.request.imageMeasurement,
      generation: chosen.request.generation,
      tee: chosen.request.sku.tee,
    };
    const rendered = adapter.renderKeyReleasePolicy(keyRequest);
    policy = rendered.rendered
      ? {
          attachesTo: rendered.policy.attachesTo,
          binds: rendered.policy.binds,
          refuses: rendered.policy.refuses,
          policy: rendered.policy.policy,
        }
      : { refused: rendered.why };
  }

  const live = CANARY_OPERATIONS.map((operation) => {
    const outcome = adapter.live(operation);
    if (outcome.executed !== false) {
      throw new Error(`${adapter.provider} reported executing ${operation}. Nothing here has a credential and no adapter may pretend otherwise.`);
    }
    return { operation, method: outcome.would.method, path: outcome.would.path, why: outcome.why };
  });

  return {
    provider: adapter.provider,
    version: adapter.version,
    ready: readiness.ready,
    missing: readiness.ready ? [] : readiness.missing.map((m) => ({ name: m.name, how: m.how })),
    mayHold: hold.may,
    mayHoldWhy: hold.why,
    sizing: chosen.note,
    provision,
    policy,
    live,
  };
}

const reports = [azureConfidential, googleConfidential].map(report);

// ---------------------------------------------------------------------------
// Emitting the bodies, so the remaining step is sending one
// ---------------------------------------------------------------------------

/**
 * Write each rendered body to a file, with the one command that would send it.
 *
 * There is no Terraform or Bicep here on purpose: the provision body is
 * rendered from the typed contract by the adapter, so a second hand-maintained
 * copy in another language would be the thing this codebase keeps refusing. The
 * cost of that choice is that a rendered body printed to a terminal is not
 * something anybody can send, which is what this closes. A file plus the
 * command that posts it is the whole remaining action.
 *
 * The emitted files carry `{placeholders}` wherever a credential belongs, which
 * is deliberate: an owner substitutes their own subscription, resource group
 * and vault, and nothing here ever holds those.
 */
function emitTo(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const notes: string[] = [
    '# The confidential canary, rendered',
    '',
    'Generated by `npm run hosted:canary -- --emit <dir>`. Nothing here has been',
    'sent to any provider. Every `{placeholder}` is a value that is yours and has',
    'deliberately never been held by AI17Z.',
    '',
  ];

  for (const r of reports) {
    if ('body' in r.provision) {
      const file = join(dir, `${r.provider.toLowerCase()}-provision.json`);
      writeFileSync(file, `${JSON.stringify(r.provision.body, null, 2)}\n`, 'utf8');
      written.push(file);
      notes.push(`## ${r.provider}: create the runtime`);
      notes.push('');
      notes.push(`Operation \`${r.provision.operation}\`, about $${r.provision.monthlyUsd.toFixed(2)} a month.`);
      notes.push('');
      notes.push('```');
      notes.push(
        r.provider === 'AZURE'
          ? `az rest --method ${r.provision.method.toLowerCase()} --uri "https://management.azure.com${r.provision.path}" --body @${basename(file)}`
          : `curl -X ${r.provision.method} -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" --data @${basename(file)} "https://compute.googleapis.com${r.provision.path}"`,
      );
      notes.push('```');
      notes.push('');
    }
    if ('policy' in r.policy) {
      const file = join(dir, `${r.provider.toLowerCase()}-key-release-policy.json`);
      writeFileSync(file, `${JSON.stringify(r.policy.policy, null, 2)}\n`, 'utf8');
      written.push(file);
      notes.push(`## ${r.provider}: the key release policy`);
      notes.push('');
      notes.push(`Attaches to ${r.policy.attachesTo}. It binds **${r.policy.binds}**.`);
      if (r.policy.binds === 'PLATFORM_ONLY') {
        notes.push('');
        notes.push(
          'Read that before using it. A policy that asserts a compliant confidential platform and nothing about which image booted is a real claim, and it is not the claim this product needs. Proving the runtime binding is what the canary is for.',
        );
      }
      notes.push('');
      for (const refusal of r.policy.refuses) notes.push(`- refuses ${refusal}`);
      notes.push('');
    }
    if (!r.ready) {
      notes.push(`## ${r.provider}: what you have to supply first`);
      notes.push('');
      for (const m of r.missing) notes.push(`- **${m.name}** - ${m.how}`);
      notes.push('');
    }
  }

  notes.push('## Then, in order');
  notes.push('');
  CANARY_STEPS.forEach((step, i) => notes.push(`${i + 1}. ${step}`));
  notes.push('');
  notes.push('## What this would not prove');
  notes.push('');
  for (const line of WOULD_NOT_PROVE) notes.push(`- ${line}`);
  notes.push('');

  const readme = join(dir, 'README.md');
  writeFileSync(readme, `${notes.join('\n')}\n`, 'utf8');
  written.push(readme);
  return written;
}


// ---------------------------------------------------------------------------
// What the canary would prove, and what it would not
// ---------------------------------------------------------------------------

/**
 * Deliberately two lists.
 *
 * A canary that is described only by what it proves reads as a stronger result
 * than it is. The second list is the one that keeps the claim honest, and it
 * stays in the output whether or not anybody has run anything.
 */
const WOULD_PROVE: readonly string[] = [
  'That a confidential VM of a named SKU boots the approved runtime measurement on real AMD SEV-SNP or Intel TDX hardware.',
  'That the provider returns an attestation document AI17Z can parse into evidence, and that judgeConfidentialEvidence reaches a verdict on it rather than trusting it.',
  'That a key release policy bound to the measurement and the generation releases to the attested guest, and refuses a guest whose measurement or generation differs.',
  'That the tenant master key reaches the guest without the control plane holding it.',
  'That the measured monthly cost of a tenant on confidential hardware is what confidentialSkus.ts says it is, which is what every plan price rests on.',
];

const WOULD_NOT_PROVE: readonly string[] = [
  'That the host operator cannot read tenant plaintext. One canary shows the mechanism working on one machine; the claim is about an operator with administrative access over time, and availability is not confidentiality.',
  'Immunity from the host operator stopping the runtime. Nothing here claims that and nothing should.',
  'That the provider is the right one. Selecting a provider needs costs and attestation documents from both, which is barrier item 6 and needs two canaries rather than one.',
  'Anything about community or third-party hardware, which stays disabled whatever a canary on a cloud provider shows.',
];

/**
 * The ordered steps, so the remaining work is visibly configuration.
 *
 * Each step names what it needs rather than how to log in, because the credential
 * is the owner's and the route to it is the provider's documentation.
 */
const CANARY_STEPS: readonly string[] = [
  'Supply the missing credential named above for one provider. Nothing else in this list can start without it.',
  'Add that provider to CONFIDENTIAL_PROVIDERS_ENABLED. providerMayHold refuses every provider while it is empty, which is deliberate: enabling one is a decision that needs a canary behind it, so this is the step that records the decision.',
  'Build the runtime image and record its measurement. The measurement is the identity; an image tag is not what a TEE attests to, so the placeholder measurement above has to become the real one.',
  'Run the rendered provision request for that provider. The output above is the request verbatim, so this step sends something already reviewed rather than something composed under time pressure.',
  'Fetch the attestation document and put it through judgeFromAdapter. A verdict from the adapter itself would be the adapter marking its own homework.',
  'Attach the rendered key release policy and prove both directions: the attested guest receives the key, and a guest with a different measurement or an older generation is refused. The refusal is the half that matters.',
  'Measure what the runtime actually cost for the hours it ran, and compare it against confidentialSkus.ts. A price that has gone stale says so rather than ageing quietly.',
  'Re-run npm run phase1:barrier. Items 6, 12 and the confidential half of 28 are the ones this moves, and the barrier reads evidence rather than a claim that the canary happened.',
];

// Emitted here rather than beside emitTo, because the function closes over
// CANARY_STEPS and WOULD_NOT_PROVE: the function is hoisted and those are not.
const emitAt = process.argv.indexOf('--emit');
const emitted = emitAt === -1 ? [] : emitTo(process.argv[emitAt + 1] ?? 'canary-requests');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const blocked = reports.filter((r) => !r.ready);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provisioned: false,
        footprint: MEASURED_TENANT_FOOTPRINT,
        providers: reports,
        wouldProve: WOULD_PROVE,
        wouldNotProve: WOULD_NOT_PROVE,
        steps: CANARY_STEPS,
        caveats: PROVIDER_CAVEATS,
        blockedBy: blocked.length === 0 ? null : 'CLOUD_CREDENTIAL_OR_BUDGET',
      },
      null,
      2,
    )}\n`,
  );
} else {
  say();
  say('The confidential hardware canary, rendered. Nothing was provisioned, paid for or contacted.');
  say();
  say(`Sized against the measured tenant footprint: ${MEASURED_TENANT_FOOTPRINT.memoryMb} MB, ${MEASURED_TENANT_FOOTPRINT.vcpus} vCPU, measured ${MEASURED_TENANT_FOOTPRINT.measuredAt.slice(0, 10)} on ${MEASURED_TENANT_FOOTPRINT.version}.`);
  say();

  for (const r of reports) {
    say(`${r.provider}  (adapter ${r.version})`);
    say(`  Ready:      ${r.ready ? 'yes' : 'no'}`);
    for (const m of r.missing) say(`    missing   ${m.name} - ${m.how}`);
    say(`  May hold:   ${r.mayHold ? 'yes' : 'no'}. ${r.mayHoldWhy}`);
    say(`  Size:       ${r.sizing}`);
    if ('refused' in r.provision) {
      say(`  Provision:  refused. ${r.provision.refused}`);
    } else {
      say(`  Provision:  ${r.provision.method} ${r.provision.path}`);
      say(`              operation ${r.provision.operation}, $${r.provision.monthlyUsd.toFixed(2)} a month if it ran`);
      for (const a of r.provision.asserts) say(`              asserts: ${a}`);
    }
    if ('refused' in r.policy) {
      say(`  Key policy: refused. ${r.policy.refused}`);
    } else {
      say(`  Key policy: on ${r.policy.attachesTo}, binds ${r.policy.binds}`);
      for (const refusal of r.policy.refuses) say(`              refuses: ${refusal}`);
    }
    say(`  Live:       ${r.live.length} operations, every one a refusal:`);
    for (const l of r.live) say(`              ${l.operation.padEnd(18)} would be ${l.method} ${l.path}`);
    say();
  }

  say('What a canary would prove');
  for (const line of WOULD_PROVE) say(`  - ${line}`);
  say();
  say('What it would not prove, and must not be read as proving');
  for (const line of WOULD_NOT_PROVE) say(`  - ${line}`);
  say();
  say('The canary, in order');
  CANARY_STEPS.forEach((step, i) => say(`  ${String(i + 1).padStart(2)}. ${step}`));
  say();
  say('Standing caveats');
  for (const line of PROVIDER_CAVEATS) say(`  - ${line}`);
  say();

  if (emitted.length > 0) {
    say(`Written, each with the one command that would send it (nothing was sent):`);
    for (const file of emitted) say(`  ${file}`);
    say();
  }

  if (blocked.length === 0) {
    say('Every adapter reports ready, so the canary can be run. Nothing here ran it.');
  } else {
    say(`BLOCKED_BY_CLOUD_CREDENTIAL_OR_BUDGET: ${blocked.map((r) => `${r.provider} needs ${r.missing.map((m) => m.name).join(' and ')}`).join('; ')}.`);
    say('That is the whole of what is missing. Everything above is rendered from this repository and reviewed without a provider.');
  }
  say();
  process.stdout.write(`${out.join('\n')}\n`);
}

// Non-zero while blocked, so this cannot be mistaken for a canary that passed.
process.exit(blocked.length === 0 ? 0 : 1);
