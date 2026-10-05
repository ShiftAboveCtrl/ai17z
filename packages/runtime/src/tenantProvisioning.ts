import type { RuntimeState } from '@xbam/shared';
import type { KeyCustody } from '@xbam/shared/contracts';

/**
 * Bringing one tenant runtime into existence, and taking it back out again
 * when a step fails.
 *
 * The dangerous state is not failure, it is half success: a guest booted
 * before its egress rules loaded, a database reachable by PUBLIC because the
 * revoke did not run, a grant issued against a runtime that never finished
 * starting. Each of those is indistinguishable from a working tenant from the
 * control plane's side, which is why this file is ordered steps with a
 * rollback rather than a function that does the work.
 *
 * Two rules it inherits rather than invents.
 *
 * Each step settles before the next begins, exactly as the job pipeline does,
 * so a control plane that dies mid-provision resumes rather than restarts.
 * `nextStep` is what makes that possible and it reads only what was recorded.
 *
 * And provisioning is atomic in both directions, exactly as installing a
 * Plugin is. A failed provision undoes what it did; a failed rollback says so
 * loudly rather than leaving a tenant that is half present and unreachable,
 * because provisioned and permanently unusable is the one state never to leave
 * a customer in.
 */

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * Who does a step.
 *
 * The distinction the step list was missing. A step the control plane performs
 * is a step the host operator performs, and for anything touching the key or
 * the tenant's state that is the whole question rather than a detail of
 * sequencing.
 */
export type Performer =
  /** The control plane, which means the host operator. */
  | 'CONTROL_PLANE'
  /** The tenant's own runtime, inside its boundary. */
  | 'GUEST';

export interface ProvisioningStep {
  name: string;
  /** Said in a sentence, for an operator reading a stalled provision. */
  what: string;
  performedBy: Performer;
  /**
   * Whether running it twice is harmless.
   *
   * A step that is not idempotent must be preceded by its own recorded
   * marker, which `provisioningProblems` checks, because a resumed provision
   * that repeats a non-idempotent step is how a tenant ends up with two data
   * disks and one of them orphaned.
   */
  idempotent: boolean;
  /** The step that undoes it, or null where there is nothing to undo. */
  undo: string | null;
}

/**
 * In order, and the order is the design.
 *
 * Networking is attached before the guest boots, because a guest that boots
 * first is a guest that is unfiltered for however long the rules take. The
 * master key is minted before anything is sealed under it. Isolation is
 * verified before a grant exists, because a grant is the thing that makes a
 * runtime reachable, and verifying afterwards means verifying something a
 * customer can already use.
 */
export const PROVISIONING_STEPS: readonly ProvisioningStep[] = [
  {
    name: 'RESERVE_PLACEMENT',
    performedBy: 'CONTROL_PLANE',
    what: 'Subtract this runtime class from a host, so the machine cannot be promised twice.',
    idempotent: true,
    undo: 'RELEASE_PLACEMENT',
  },
  {
    name: 'MINT_MASTER_KEY',
    performedBy: 'CONTROL_PLANE',
    what: 'Mint this runtime its own master key. Never a key shared with another tenant.',
    idempotent: false,
    undo: 'DESTROY_MASTER_KEY',
  },
  {
    name: 'CREATE_DATABASE',
    performedBy: 'CONTROL_PLANE',
    what: 'Create the tenant database and role, with PUBLIC revoked before the tenant is granted.',
    idempotent: true,
    undo: 'DROP_DATABASE',
  },
  {
    name: 'CREATE_DATA_DISK',
    performedBy: 'CONTROL_PLANE',
    what: 'Create the one writable disk this tenant has. The root image stays read only.',
    idempotent: false,
    undo: 'DESTROY_DATA_DISK',
  },
  {
    name: 'ATTACH_NETWORK',
    performedBy: 'CONTROL_PLANE',
    what: 'Create the network namespace and load the egress rules into it, before anything can send a packet.',
    idempotent: true,
    undo: 'DETACH_NETWORK',
  },
  {
    name: 'BOOT_GUEST',
    performedBy: 'CONTROL_PLANE',
    what: 'Launch the guest under the jailer, with seccomp in place and as an unprivileged user.',
    idempotent: false,
    undo: 'STOP_GUEST',
  },
  {
    name: 'MIGRATE_SCHEMA',
    performedBy: 'GUEST',
    what: 'Apply migrations inside the guest, against the tenant database only.',
    idempotent: true,
    undo: null,
  },
  {
    name: 'VERIFY_ISOLATION',
    performedBy: 'CONTROL_PLANE',
    what: 'Read the egress rules, the guest report and the database grants back, and compare them with the plan.',
    idempotent: true,
    undo: null,
  },
  {
    name: 'ISSUE_GRANT',
    performedBy: 'CONTROL_PLANE',
    what: 'Issue the one grant the customer will use. Returned once and stored only as a hash.',
    idempotent: false,
    undo: 'REVOKE_GRANT',
  },
  {
    name: 'MARK_READY',
    performedBy: 'CONTROL_PLANE',
    what: 'Record the runtime as ready, which is the first moment anything outside may reach it.',
    idempotent: true,
    undo: 'MARK_NOT_READY',
  },
];

export const PROVISIONING_STEP_NAMES: readonly string[] = PROVISIONING_STEPS.map((s) => s.name);

/**
 * The same provisioning, for a tenant whose key is released rather than held.
 *
 * Three differences from the list above, and each is the consequence of one
 * sentence: the host operator must not be able to read the customer's durable
 * state or hold its key.
 *
 * The guest boots **before** anything exists to put in it, because a guest is
 * what attestation is about: there is nothing to attest until something is
 * running. It then proves which runtime it is, and only then is the key
 * released to it. And the database is the **guest's own**, created inside the
 * boundary on the tenant's encrypted disk, because a database on a server the
 * host operates is a database the host reads.
 *
 * `MINT_MASTER_KEY` has no counterpart here on purpose. Nothing mints a key
 * for this tenant outside its own boundary, so there is no step for it.
 */
export const ATTESTED_PROVISIONING_STEPS: readonly ProvisioningStep[] = [
  {
    name: 'RESERVE_PLACEMENT',
    what: 'Subtract this runtime class from a host, so the machine cannot be promised twice.',
    performedBy: 'CONTROL_PLANE',
    idempotent: true,
    undo: 'RELEASE_PLACEMENT',
  },
  {
    name: 'CREATE_DATA_DISK',
    what: 'Create the one writable disk this tenant has, encrypted, with the host holding no key to it.',
    performedBy: 'CONTROL_PLANE',
    idempotent: false,
    undo: 'DESTROY_DATA_DISK',
  },
  {
    name: 'ATTACH_NETWORK',
    what: 'Create the network namespace and load the egress rules into it, before anything can send a packet.',
    performedBy: 'CONTROL_PLANE',
    idempotent: true,
    undo: 'DETACH_NETWORK',
  },
  {
    name: 'BOOT_GUEST',
    what: 'Launch the confidential guest. Nothing exists to attest until something is running.',
    performedBy: 'CONTROL_PLANE',
    idempotent: false,
    undo: 'STOP_GUEST',
  },
  {
    name: 'ATTEST_RUNTIME',
    what: 'Have the guest prove the hardware, the security mode, the runtime measurement and that debug is off.',
    performedBy: 'GUEST',
    idempotent: true,
    undo: null,
  },
  {
    name: 'RELEASE_MASTER_KEY',
    what: 'Release this tenant\'s key to the attested guest. The control plane never receives it.',
    performedBy: 'GUEST',
    idempotent: true,
    undo: 'DESTROY_MASTER_KEY',
  },
  {
    name: 'CREATE_DATABASE',
    what: 'The guest creates its own database on its own encrypted disk, reachable only on its own loopback.',
    performedBy: 'GUEST',
    idempotent: true,
    undo: null,
  },
  {
    name: 'MIGRATE_SCHEMA',
    what: 'Apply migrations inside the guest, against the tenant database only.',
    performedBy: 'GUEST',
    idempotent: true,
    undo: null,
  },
  {
    name: 'VERIFY_ISOLATION',
    what: 'Read the egress rules and the guest report back, and compare them with the plan.',
    performedBy: 'CONTROL_PLANE',
    idempotent: true,
    undo: null,
  },
  {
    name: 'ISSUE_GRANT',
    what: 'Issue the one grant the customer will use. Returned once and stored only as a hash.',
    performedBy: 'CONTROL_PLANE',
    idempotent: false,
    undo: 'REVOKE_GRANT',
  },
  {
    name: 'MARK_READY',
    what: 'Record the runtime as ready, which is the first moment anything outside may reach it.',
    performedBy: 'CONTROL_PLANE',
    idempotent: true,
    undo: 'MARK_NOT_READY',
  },
];

/** Steps for one custody. The order is a property of the custody, not a constant. */
export function stepsFor(custody: KeyCustody): readonly ProvisioningStep[] {
  return custody === 'ATTESTED_RELEASE' ? ATTESTED_PROVISIONING_STEPS : PROVISIONING_STEPS;
}

/**
 * The steps that decide whether the host operator can read a tenant.
 *
 * Named rather than matched on a substring, so a step added later is either on
 * this list deliberately or is not one of these.
 */
export const KEY_AND_STATE_STEPS: readonly string[] = [
  'MINT_MASTER_KEY',
  'RELEASE_MASTER_KEY',
  'CREATE_DATABASE',
  'MIGRATE_SCHEMA',
];

/**
 * Whether a step list keeps the promise its custody makes.
 *
 * Separate from `provisioningProblems`, which checks the properties both lists
 * share. This one is about the claim: under ATTESTED_RELEASE the control plane
 * must perform nothing that touches the key or the tenant's state, and there
 * has to be an attestation before the key moves. Either of those failing means
 * the word confidential is being used for something that is not.
 */
export function custodyProblems(custody: KeyCustody, steps: readonly ProvisioningStep[] = stepsFor(custody)): readonly string[] {
  const problems: string[] = [];
  const index = new Map(steps.map((step, at) => [step.name, at]));

  if (custody !== 'ATTESTED_RELEASE') {
    // Said rather than left as an absence. A host-sealed tenant's state is on
    // the host, and the only dishonest thing would be not saying so.
    return problems;
  }

  for (const step of steps) {
    if (KEY_AND_STATE_STEPS.includes(step.name) && step.performedBy === 'CONTROL_PLANE') {
      problems.push(`${step.name} would be performed by the control plane, which means the host operator holds the key or reads the state.`);
    }
  }

  if (index.has('MINT_MASTER_KEY')) {
    problems.push('Something outside the guest would mint this tenant\'s key, and whatever minted it held it.');
  }

  const attest = index.get('ATTEST_RUNTIME') ?? -1;
  const release = index.get('RELEASE_MASTER_KEY') ?? -1;
  if (attest < 0) {
    problems.push('Nothing attests the runtime, so a key would be released to whatever booted.');
  } else if (!(release > attest)) {
    problems.push('The key would be released before the runtime proved what it is, which is release with nothing behind it.');
  }

  const boot = index.get('BOOT_GUEST') ?? -1;
  if (!(attest > boot)) {
    problems.push('Attestation would happen before the guest boots, and there is nothing to attest until something is running.');
  }

  const database = index.get('CREATE_DATABASE') ?? -1;
  if (!(database > release)) {
    problems.push('The database would exist before the guest had the key to seal anything under.');
  }

  return problems;
}

/** Checks the step list itself, so a step added later keeps the properties. */
export function provisioningProblems(steps: readonly ProvisioningStep[] = PROVISIONING_STEPS): readonly string[] {
  const problems: string[] = [];
  const index = new Map(steps.map((s, i) => [s.name, i]));

  for (const step of steps) {
    if (!step.what.trim()) problems.push(`${step.name} carries no explanation.`);
    if (step.undo && index.has(step.undo)) {
      problems.push(`${step.name} names ${step.undo} as its undo, but that is itself a provisioning step.`);
    }
  }

  const network = index.get('ATTACH_NETWORK') ?? -1;
  const boot = index.get('BOOT_GUEST') ?? -1;
  if (!(network >= 0 && boot >= 0 && network < boot)) {
    problems.push('The guest would boot before its egress rules load, which leaves it unfiltered for however long that takes.');
  }

  /*
    Whichever step gives the runtime its key, which is not the same step in
    both custodies: a host-sealed tenant's key is minted for it and an attested
    one's is released to it. The property is the same either way, so the check
    asks for the key rather than for a step name.
  */
  const key = Math.max(index.get('MINT_MASTER_KEY') ?? -1, index.get('RELEASE_MASTER_KEY') ?? -1);
  const database = index.get('CREATE_DATABASE') ?? -1;
  if (!(key >= 0 && database >= 0 && key < database)) {
    problems.push('The database would exist before this runtime has a key of its own to seal anything under.');
  }

  const verify = index.get('VERIFY_ISOLATION') ?? -1;
  const grant = index.get('ISSUE_GRANT') ?? -1;
  const ready = index.get('MARK_READY') ?? -1;
  if (!(verify >= 0 && grant > verify)) {
    problems.push('A grant would exist before isolation was verified, so what is verified is something a customer can already use.');
  }
  if (ready !== steps.length - 1) {
    problems.push('MARK_READY is not last, so something outside could reach a runtime that is still being built.');
  }

  // A step that is not idempotent has to be undoable, or a resumed provision
  // cannot get back to a clean state.
  for (const step of steps) {
    if (!step.idempotent && !step.undo) {
      problems.push(`${step.name} can neither be repeated safely nor undone, so a failure after it is unrecoverable.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

export interface ProvisioningProgress {
  runtimeId: string;
  /** Steps recorded as settled, in any order. */
  completed: readonly string[];
  /** A step that failed, if one did. */
  failed?: { step: string; why: string };
}

export type NextAction =
  | { action: 'RUN'; step: ProvisioningStep }
  | { action: 'ROLLBACK'; steps: readonly string[]; why: string }
  | { action: 'DONE' };

/**
 * What to do next, read only from what was recorded.
 *
 * A failure anywhere means rollback rather than retry. Retrying a step that
 * failed for a reason nobody has looked at is how a provision loops, and a
 * loop against a host is worse than a refusal somebody has to read.
 */
export function nextAction(progress: ProvisioningProgress, steps: readonly ProvisioningStep[] = PROVISIONING_STEPS): NextAction {
  if (progress.failed) {
    return {
      action: 'ROLLBACK',
      steps: rollbackOrder(progress.completed, steps),
      why: `${progress.failed.step} failed: ${progress.failed.why}`,
    };
  }

  const done = new Set(progress.completed);
  for (const step of steps) {
    if (!done.has(step.name)) return { action: 'RUN', step };
  }
  return { action: 'DONE' };
}

/**
 * The undos to run, newest first.
 *
 * Reverse order because an undo depends on what came before it still being
 * there: dropping a database after releasing the placement means dropping it
 * on a host that is no longer reserved for this tenant.
 */
export function rollbackOrder(
  completed: readonly string[],
  steps: readonly ProvisioningStep[] = PROVISIONING_STEPS,
): readonly string[] {
  const done = new Set(completed);
  return [...steps]
    .reverse()
    .filter((s) => done.has(s.name) && s.undo)
    .map((s) => s.undo!);
}

// ---------------------------------------------------------------------------
// What may not be skipped before a runtime is reachable
// ---------------------------------------------------------------------------

export interface IsolationEvidence {
  /** The host read its own loaded ruleset back and it carried every denial. */
  egressEnforced: boolean;
  /** The guest the host reports is the guest this plan asked for. */
  guestMatchesPlan: boolean;
  /** The server's own report of the tenant database had no problems. */
  databaseIsolated: boolean;
  /** This runtime's key is not shared with another tenant. */
  keyIsItsOwn: boolean;
}

export type ReadyVerdict = { ready: true } | { ready: false; missing: readonly string[] };

/**
 * Whether a runtime may be marked ready.
 *
 * Every one of these is required, and none of them is inferred from a step
 * having run. A step that ran is a step that returned; the evidence is what
 * the host and the server said afterwards, which is the distinction the local
 * product already pays for in `verifyLoadedRuleset` and in reading a browser's
 * own report back over CDP.
 */
export function mayMarkReady(evidence: IsolationEvidence): ReadyVerdict {
  const missing: string[] = [];
  if (!evidence.egressEnforced) missing.push('The host has not confirmed the egress rules are loaded.');
  if (!evidence.guestMatchesPlan) missing.push('The guest the host reports is not the guest that was planned.');
  if (!evidence.databaseIsolated) missing.push('The tenant database has not been confirmed isolated by the server.');
  if (!evidence.keyIsItsOwn) missing.push('This runtime has not been confirmed to hold a key of its own.');
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

/**
 * Where a runtime sits after a provision failed.
 *
 * Never a state in which it may act. A half-provisioned runtime that reads as
 * ACTIVE is a tenant acting on the world with one of its boundaries missing,
 * and the failure is silent by construction because every individual step
 * returned.
 */
export function stateAfterFailure(rollbackSucceeded: boolean): RuntimeState {
  return rollbackSucceeded ? 'DELETED' : 'FAILED';
}

/**
 * What to say when a rollback itself failed.
 *
 * Loudly, and naming what is left behind, because this is the case where
 * something exists on a host that the control plane no longer has a record of
 * and nobody will find it by looking at the control plane.
 */
export function orphanReport(input: {
  runtimeId: string;
  undosAttempted: readonly string[];
  undosFailed: readonly string[];
}): string {
  if (input.undosFailed.length === 0) return `${input.runtimeId} was rolled back cleanly.`;
  return [
    `${input.runtimeId} could not be rolled back completely.`,
    `Left behind on the host: ${input.undosFailed.join(', ')}.`,
    'These need a person. Nothing will find them by looking at the control plane, because the runtime record is gone.',
  ].join(' ');
}

export const PROVISIONING_CAVEATS: readonly string[] = [
  'No tenant has been provisioned from this repository. These are ordered steps and their checks, not a provision that has run.',
  'A step that returned is not a boundary that exists. mayMarkReady asks the host and the server rather than inferring it from the steps.',
  'A failed rollback leaves something on a host that the control plane has no record of. orphanReport is what says so, and it needs a person.',
  'Resuming reads only what was recorded. A control plane that dies between doing a step and recording it will repeat that step, which is why a step that cannot be repeated safely has to be undoable.',
];
