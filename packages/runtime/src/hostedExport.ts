import { AGENT_PACKAGE_EXTENSION, AGENT_PACKAGE_VERSION, type AgentPackageMode } from '@xbam/shared/contracts';
import { spendPermissionFor } from './hostedLifecycle';
import type { RuntimeState } from '@xbam/shared/contracts';

/**
 * Taking a hosted agent out, back to a machine the owner controls.
 *
 * AI17Z is local-first, and hosting is a convenience rather than a captivity.
 * So the hosted product owes an owner a way out, and it uses the agent package
 * format that already exists rather than inventing a hosted-only export: the
 * same `.ai17z-agent` document, the same two modes, the same strict schemas.
 * An export that only another hosted runtime could read would be a lock-in
 * dressed as a feature.
 *
 * What this module adds is the hosted-specific judgement: whether an export
 * may happen now, and what honestly travels. The packaging itself belongs to
 * the portable contract and is not duplicated here.
 */

export type ExportRefusal =
  | 'RUNTIME_DELETED'
  | 'RUNTIME_PROVISIONING'
  | 'NO_VERIFIED_BACKUP';

export type ExportDecision =
  | { ok: true; mode: AgentPackageMode; detail: string }
  | { ok: false; refusal: ExportRefusal; detail: string };

/**
 * Whether an owner may take their agent out right now.
 *
 * Permissive on purpose. Export survives a lapsed subscription, a suspension
 * and being parked, because being able to leave is the whole reason state is
 * kept when somebody stops paying. The only refusals are a runtime that has
 * genuinely gone and one that has not finished arriving.
 */
export function mayExport(input: {
  state: RuntimeState;
  mode: AgentPackageMode;
  /** Required for MOVE from a runtime whose host is unreachable. */
  hasVerifiedBackup: boolean;
}): ExportDecision {
  if (input.state === 'DELETED') {
    return { ok: false, refusal: 'RUNTIME_DELETED', detail: 'There is nothing left to export.' };
  }
  if (input.state === 'PROVISIONING' || input.state === 'MIGRATING') {
    return {
      ok: false,
      refusal: 'RUNTIME_PROVISIONING',
      detail: 'The runtime has not finished arriving, so an export now would be a snapshot of a half-built agent.',
    };
  }
  // A host that stopped answering cannot be asked for its live state, so the
  // only honest source is a backup somebody has actually read back.
  if ((input.state === 'HOST_UNREACHABLE' || input.state === 'FAILED') && !input.hasVerifiedBackup) {
    return {
      ok: false,
      refusal: 'NO_VERIFIED_BACKUP',
      detail: 'The host is not answering and there is no verified backup, so an export would invent a partial agent.',
    };
  }
  // Export deliberately outlives the right to act.
  const permission = spendPermissionFor(input.state);
  const note = permission.autonomousActions
    ? 'Exported from a running agent.'
    : 'Exported from a stopped agent. Nothing was running and nothing was lost.';
  return { ok: true, mode: input.mode, detail: note };
}

/**
 * What honestly travels, and what does not.
 *
 * Stated as data because an owner deciding whether to move needs to know
 * before they do it, not afterwards. The absences are the interesting half.
 */
export const HOSTED_EXPORT_CARRIES: readonly string[] = [
  'Identity and persona',
  'Memories, in a MOVE',
  'Knowledge and its source provenance',
  'Goals and commitments',
  'Learning and configuration',
  'Plugin decisions, where the target installation has the Plugin',
];

/**
 * What does not travel, each for a reason rather than an omission.
 *
 * The browser session is the one owners are most surprised by, and AI17Z
 * already knows why: profile seeding does not carry a login on Windows because
 * Chrome ties cookies to its own identity on that machine. Pretending
 * otherwise would hand somebody a package that looks complete and signs them
 * out the first time they use it.
 */
export const HOSTED_EXPORT_OMITS: readonly { what: string; why: string }[] = [
  {
    what: 'The browser session and Chrome profile',
    why: 'Chrome ties a signed-in session to its own identity on the machine that created it, so a copied profile is not a working login. Sign in again on the target.',
  },
  {
    what: 'Provider API keys',
    why: 'They are sealed under the runtime key that is being left behind, and an owner can paste them into the new installation in a few seconds.',
  },
  {
    what: 'Wallet key material',
    why: 'A signing key is not something to put in a document that gets emailed around. MOVE carries the agent, not the money.',
  },
  {
    what: 'The runtime master key',
    why: 'The target installation has its own. Carrying one would mean two installations could read the same sealed data.',
  },
  {
    what: 'Relationships and stances, in every mode including MOVE',
    why: 'Both rebuild themselves from what the agent actually published, so carrying them would put a list of everyone it has spoken to into a file that gets emailed around, in order to reconstruct something that reconstructs itself. `readLearned` in agentPackage.ts reads memories and nothing else, and this list says so rather than describing a package somebody might assume.',
  },
];

/**
 * The filename an owner gets.
 *
 * Uses the existing extension so a hosted export and a local one are the same
 * kind of document, openable by the same importer.
 */
export function exportFilename(input: { agentName: string; mode: AgentPackageMode; at?: Date }): string {
  const at = input.at ?? new Date();
  const stamp = at.toISOString().slice(0, 10);
  // Anything that is not plainly safe in a filename becomes a hyphen, and
  // runs collapse, so an agent called "Shift // Above" does not produce a
  // path with an empty segment in it.
  const safe = input.agentName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const stem = safe.length > 0 ? safe : 'agent';
  return `${stem}-${input.mode.toLowerCase()}-${stamp}${AGENT_PACKAGE_EXTENSION}`;
}

/** What an owner should be told before a MOVE, in the order it matters. */
export function moveWarnings(): readonly string[] {
  return [
    'Your agent keeps its identity, memories, relationships, beliefs, knowledge and goals.',
    'You will need to sign in to any connected account again on the new installation.',
    'Provider API keys are not carried and will need pasting in again.',
    'Wallet keys are not carried. Move funds deliberately, not by moving an agent.',
    `The package is a single ${AGENT_PACKAGE_EXTENSION} document at version ${AGENT_PACKAGE_VERSION}, readable by any AI17Z installation.`,
  ];
}
