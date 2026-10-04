import { createHash } from 'node:crypto';

/**
 * Making a copy of a hosted tenant that outlives the machine holding it.
 *
 * A hosted agent is somebody's durable thing, so the honest requirement is not
 * "we take backups" but "the agent survives the host disappearing". That means
 * the copy lives somewhere other than the compute, it is encrypted with the
 * tenant's own key so possession is not authority, and somebody has actually
 * read one back, because writing a file is not evidence it can be restored.
 *
 * The store is an interface rather than an implementation for the same reason
 * the wallet signer is: where the ciphertext goes depends on the deployment,
 * and this layer should not care whether that is object storage, another
 * machine or a disk somebody carries.
 */

export interface BackupStore {
  id: string;
  /** Write ciphertext and return where it went. Throws a sentence on failure. */
  put(key: string, bytes: Uint8Array): Promise<{ location: string }>;
  /** Read it back. Returns null when it is not there. */
  get(location: string): Promise<Uint8Array | null>;
  /** Remove one. Used only when an owner asks or a retention window closes. */
  remove(location: string): Promise<void>;
}

let store: BackupStore | null = null;

export function registerBackupStore(next: BackupStore): void {
  store = next;
}

export function resetBackupStoreForTest(): void {
  store = null;
}

export function backupReadiness(): { ready: boolean; detail: string } {
  if (store) return { ready: true, detail: `Backups go to ${store.id}.` };
  return { ready: false, detail: 'No backup store is configured, so a hosted runtime cannot be made recoverable.' };
}

/**
 * What a backup is made of.
 *
 * The plaintext never appears in this module: a caller hands over ciphertext
 * that the runtime produced with its own key. That is the whole point of
 * "possession is not authority", and it is why there is no key parameter here
 * to accidentally log.
 */
export interface BackupPlan {
  runtimeId: string;
  tenantId: string;
  generation: number;
  /** Already encrypted by the runtime, with the runtime's own master key. */
  ciphertext: Uint8Array;
}

export type BackupOutcome =
  | { outcome: 'STORED'; location: string; sha256: string; sizeBytes: number }
  | { outcome: 'NO_STORE'; detail: string }
  | { outcome: 'REFUSED'; detail: string }
  | { outcome: 'FAILED'; detail: string };

/** A key that sorts by runtime and generation, so a listing is readable. */
export function backupKeyFor(plan: Pick<BackupPlan, 'runtimeId' | 'generation'>, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${plan.runtimeId}/gen-${plan.generation}/${stamp}.bin`;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Store a backup, and record what it hashed to.
 *
 * The digest is of the ciphertext, computed here before the write, so a corrupt
 * copy is caught by comparison later rather than trusted. An empty backup is
 * refused: it is almost always a bug upstream, and an empty file that verifies
 * cleanly is the worst kind of backup because it inspires confidence.
 */
export async function storeBackup(plan: BackupPlan, at: Date = new Date()): Promise<BackupOutcome> {
  if (!store) return { outcome: 'NO_STORE', detail: backupReadiness().detail };
  if (plan.ciphertext.byteLength === 0) {
    return { outcome: 'REFUSED', detail: 'An empty backup is refused: it would verify cleanly and restore nothing.' };
  }
  const sha256 = sha256Of(plan.ciphertext);
  try {
    const { location } = await store.put(backupKeyFor(plan, at), plan.ciphertext);
    return { outcome: 'STORED', location, sha256, sizeBytes: plan.ciphertext.byteLength };
  } catch (error) {
    return { outcome: 'FAILED', detail: (error as Error).message || 'The backup store refused the write.' };
  }
}

export type VerifyOutcome =
  | { outcome: 'VERIFIED'; sizeBytes: number }
  /** It is not where the record says it is. */
  | { outcome: 'MISSING'; detail: string }
  /** It is there and it is not what was written. */
  | { outcome: 'CORRUPT'; detail: string }
  | { outcome: 'NO_STORE'; detail: string }
  | { outcome: 'FAILED'; detail: string };

/**
 * Read a backup back and check it is what was stored.
 *
 * This is the step that makes a backup a backup. Without it the system has a
 * row saying a file exists, which is a belief rather than a recovery plan, and
 * the moment it matters is the moment nobody can test it any more.
 *
 * MISSING and CORRUPT are kept apart because they mean different things to
 * whoever has to fix it: one is a storage or a path problem, the other is a
 * write that completed and lied.
 */
export async function verifyBackup(location: string, expectedSha256: string): Promise<VerifyOutcome> {
  if (!store) return { outcome: 'NO_STORE', detail: backupReadiness().detail };
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(location);
  } catch (error) {
    return { outcome: 'FAILED', detail: (error as Error).message || 'The backup store could not be read.' };
  }
  if (!bytes) return { outcome: 'MISSING', detail: `Nothing is stored at ${location}.` };
  const actual = sha256Of(bytes);
  if (actual !== expectedSha256) {
    return { outcome: 'CORRUPT', detail: `The stored copy hashes to ${actual.slice(0, 12)} and the record says ${expectedSha256.slice(0, 12)}.` };
  }
  return { outcome: 'VERIFIED', sizeBytes: bytes.byteLength };
}

export type RestoreOutcome =
  | { outcome: 'READY'; ciphertext: Uint8Array }
  | { outcome: 'NOT_VERIFIED'; detail: string }
  | { outcome: 'MISSING'; detail: string }
  | { outcome: 'CORRUPT'; detail: string }
  | { outcome: 'NO_STORE'; detail: string };

/**
 * Fetch a backup to restore from, refusing one nobody has checked.
 *
 * Deliberately strict. Restoring from an unverified copy is how a tenant is
 * brought back as a partial version of itself, and the agent then acts on a
 * world it half remembers. A caller that genuinely wants to try an unverified
 * copy has to verify it first, which is the point.
 *
 * Returns ciphertext. Decryption needs the runtime's own key and happens
 * inside the runtime, so a control plane that holds every backup still holds
 * nothing it can read.
 */
export async function fetchForRestore(input: {
  location: string;
  sha256: string;
  verifiedAt: string | null;
}): Promise<RestoreOutcome> {
  if (!store) return { outcome: 'NO_STORE', detail: backupReadiness().detail };
  if (!input.verifiedAt) {
    return {
      outcome: 'NOT_VERIFIED',
      detail: 'That backup has never been read back, so restoring from it would be a guess. Verify it first.',
    };
  }
  const checked = await verifyBackup(input.location, input.sha256);
  if (checked.outcome === 'MISSING') return { outcome: 'MISSING', detail: checked.detail };
  if (checked.outcome === 'CORRUPT') return { outcome: 'CORRUPT', detail: checked.detail };
  if (checked.outcome !== 'VERIFIED') return { outcome: 'NO_STORE', detail: checked.detail };

  // Verified a moment ago, so this read is the one being restored from.
  const bytes = await store.get(input.location);
  if (!bytes) return { outcome: 'MISSING', detail: `Nothing is stored at ${input.location}.` };
  return { outcome: 'READY', ciphertext: bytes };
}

/**
 * Whether a tenant may be started on new hardware.
 *
 * The question a host failure actually poses. Both halves have to be true: the
 * old runtime must not be running, and there must be a verified copy to start
 * from. Saying yes without the first is how the same agent ends up running
 * twice, each believing it is alone, which for an agent that posts and trades
 * is worse than being down.
 */
export function mayRecoverElsewhere(input: {
  oldRuntimeState: string;
  hasVerifiedBackup: boolean;
}): { ok: true } | { ok: false; why: string } {
  if (!['HOST_UNREACHABLE', 'FAILED', 'RETAINED', 'SUSPENDED'].includes(input.oldRuntimeState)) {
    return {
      ok: false,
      why: `The runtime is ${input.oldRuntimeState}, which may still be running. Starting a second copy would have two agents acting as one.`,
    };
  }
  if (!input.hasVerifiedBackup) {
    return { ok: false, why: 'There is no verified backup to start from, so a restore would invent a partial agent.' };
  }
  return { ok: true };
}

/**
 * What a restore cannot bring back, stated rather than discovered.
 *
 * Chrome's signed-in state is tied to the profile and, on some platforms, to
 * the browser's own identity on that machine. AI17Z already knows profile
 * seeding does not carry a login on Windows because of App-Bound Encryption.
 * So a restored tenant may need to sign in to X again, and the product says so
 * instead of implying the session travelled.
 */
export const RESTORE_CAVEATS: readonly string[] = [
  'A browser session may not survive a restore and may need signing in again.',
  'A signed-in Chrome profile is tied to the machine that created it on some platforms.',
  'Durable agent state travels: identity, memories, relationships, beliefs, knowledge, goals and configuration.',
  'An irreversible action taken before the failure is reconciled rather than repeated.',
];
