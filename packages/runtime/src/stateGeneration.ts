import { createHash } from 'node:crypto';

/**
 * Noticing when a host has rolled a tenant's durable state backwards.
 *
 * Confidential memory solves the live case: a host operator cannot read or
 * alter what is running. It does nothing about the disk. An operator who keeps
 * last week's encrypted snapshot can restore it, and the runtime that boots
 * decrypts it perfectly, attests perfectly, and has no idea that a week of its
 * own life is missing. Every signature is genuine; the ciphertext is the
 * ciphertext AI17Z wrote. The host is choosing which of its own past states to
 * hand back.
 *
 * So the defence cannot be cryptographic in the usual sense. It has to be a
 * number that only goes up, recorded somewhere the host cannot also roll back.
 *
 * Three pieces, and the third is the one that makes it work.
 *
 * The runtime advances a **state generation** every time it commits something
 * durable, and signs the advance with its own key.
 *
 * It writes that generation into its own state, so a restore brings the old
 * number with it.
 *
 * And it publishes the generation to a **witness** the host does not control.
 * On a restore the runtime asks the witness what the highest generation ever
 * was: if its own state says less, it has been rolled back. Without the
 * witness there is nothing to compare against, because the only other copy of
 * the number went backwards with everything else.
 *
 * An owner-requested restore to an older backup stays possible, and is the
 * reason this is a refusal with an override rather than a lock: it is recorded
 * as a deliberate act with the generation it went back to, and the witness is
 * told, so the next boot is not mistaken for an attack.
 */

// ---------------------------------------------------------------------------
// The witness
// ---------------------------------------------------------------------------

/**
 * Somewhere outside the compute host that remembers one number per runtime.
 *
 * Deliberately tiny. The more a witness does, the more likely it lives on the
 * machine it is supposed to be independent of, and the only thing it must do
 * is refuse to go backwards.
 */
export interface GenerationWitness {
  id: string;
  /** The highest generation ever recorded, or null if this runtime is new. */
  highest(runtimeId: string): Promise<number | null>;
  /**
   * Records a generation, and must refuse to lower one.
   *
   * The refusal belongs in the witness rather than in its caller: a witness
   * that accepts a lower number on request is a witness the host can reset by
   * asking nicely.
   */
  advance(runtimeId: string, generation: number, proof: string): Promise<{ accepted: boolean; highest: number }>;
}

let witness: GenerationWitness | null = null;

export function registerGenerationWitness(next: GenerationWitness): void {
  witness = next;
}

export function resetGenerationWitnessForTest(): void {
  witness = null;
}

export function witnessReadiness(): { ready: boolean; detail: string } {
  if (witness) return { ready: true, detail: `Generations are witnessed by ${witness.id}.` };
  return {
    ready: false,
    detail:
      'No generation witness is registered, so a rolled-back runtime cannot be told from a correctly restored one: the only other copy of the number went backwards with the state.',
  };
}

// ---------------------------------------------------------------------------
// What a runtime records
// ---------------------------------------------------------------------------

export interface StateMark {
  runtimeId: string;
  /** Monotonic per runtime. Advanced on every durable commit. */
  generation: number;
  /** When the runtime advanced it. */
  at: string;
  /**
   * A digest over the state this generation describes.
   *
   * Not a defence against the host, which can produce a consistent older pair
   * of state and digest. It catches the other thing: a restore that half
   * worked, where the generation moved and the bytes did not.
   */
  stateDigest: string;
  /** Signed by the runtime's own key, so a host cannot mint a higher one. */
  proof: string;
}

/** One digest spelling, so two marks over one state agree. */
export function stateDigestOf(parts: readonly string[]): string {
  const h = createHash('sha256');
  // Sorted, because a digest that depends on the order a caller happened to
  // list things in is a digest that changes for no reason.
  for (const part of [...parts].sort()) h.update(part).update('\u0000');
  return `sha256:${h.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// The judgement
// ---------------------------------------------------------------------------

export type RollbackVerdict =
  /** The state is at least as new as anything ever witnessed. */
  | { verdict: 'CURRENT'; generation: number; detail: string }
  /** Brand new runtime: nothing has ever been witnessed for it. */
  | { verdict: 'FIRST_BOOT'; detail: string }
  /** Witnessed higher than the state claims. Somebody served an older disk. */
  | { verdict: 'ROLLED_BACK'; witnessed: number; found: number; detail: string }
  /** An owner asked for this older state, and said so. */
  | { verdict: 'OWNER_RESTORE'; witnessed: number; found: number; detail: string }
  /** Nothing can be said, which is not the same as nothing being wrong. */
  | { verdict: 'UNWITNESSED'; detail: string };

export interface RollbackQuestion {
  mark: StateMark;
  /**
   * An owner-authorised restore to this generation, if there is one.
   *
   * Required to be the exact generation rather than a boolean, because
   * "the owner approved a restore" without saying to what is a permission
   * that covers any older state at all, including one the owner never saw.
   */
  ownerApprovedRestoreTo?: number | null;
}

/**
 * Whether this runtime's durable state has been moved backwards.
 *
 * `UNWITNESSED` is reported rather than treated as fine. A runtime with no
 * witness is not a runtime that has not been rolled back; it is a runtime
 * where nobody could tell, and those are different sentences on a status
 * screen.
 */
export async function judgeStateGeneration(question: RollbackQuestion): Promise<RollbackVerdict> {
  if (!witness) {
    return { verdict: 'UNWITNESSED', detail: witnessReadiness().detail };
  }

  const highest = await witness.highest(question.mark.runtimeId);
  if (highest === null) {
    return {
      verdict: 'FIRST_BOOT',
      detail: 'Nothing has ever been witnessed for this runtime, which is what a new one looks like.',
    };
  }

  const found = question.mark.generation;
  if (found >= highest) {
    return {
      verdict: 'CURRENT',
      generation: found,
      detail: `State is at generation ${found} and the witness has never seen higher than ${highest}.`,
    };
  }

  if (question.ownerApprovedRestoreTo === found) {
    return {
      verdict: 'OWNER_RESTORE',
      witnessed: highest,
      found,
      detail: `The owner asked for generation ${found}, and generation ${highest} was the newest. This is a deliberate act and is recorded as one.`,
    };
  }

  return {
    verdict: 'ROLLED_BACK',
    witnessed: highest,
    found,
    detail: `The witness has seen generation ${highest} and this state claims ${found}. Nothing was forged: an older encrypted snapshot decrypts and attests perfectly, which is why a signature cannot catch this and a number that only goes up can.`,
  };
}

/** Whether a runtime may act, given what the judgement said. */
export function mayActOnState(verdict: RollbackVerdict): { act: boolean; why: string } {
  switch (verdict.verdict) {
    case 'CURRENT':
      return { act: true, why: verdict.detail };
    case 'FIRST_BOOT':
      return { act: true, why: verdict.detail };
    case 'OWNER_RESTORE':
      // Allowed because somebody asked, and the generation they asked for is
      // the generation they got.
      return { act: true, why: verdict.detail };
    case 'ROLLED_BACK':
      /*
        Stopped rather than repaired. An agent acting on a world it half
        remembers republishes things it already said and re-answers people who
        have moved on, and the owner is the only one who can say whether this
        is a restore or an attack.
      */
      return { act: false, why: `${verdict.detail} The runtime does not act until somebody decides which this is.` };
    case 'UNWITNESSED':
      /*
        Permitted, and said. Refusing would make a runtime unable to start
        wherever a witness has not been deployed yet, which would be a
        security feature that stops the product working; reporting it keeps the
        gap visible instead.
      */
      return { act: true, why: `${verdict.detail} The runtime acts, and the gap is reported rather than hidden.` };
  }
}

/**
 * Advances the generation after a durable commit.
 *
 * Returns what the witness said rather than assuming it agreed, because a
 * witness that refused is the interesting case: two runtimes both believing
 * they are the live copy is the two-copies problem arriving through the back
 * door.
 */
export async function advanceStateGeneration(mark: StateMark): Promise<
  { advanced: true; highest: number } | { advanced: false; why: string; highest?: number }
> {
  if (!witness) return { advanced: false, why: witnessReadiness().detail };
  const result = await witness.advance(mark.runtimeId, mark.generation, mark.proof);
  if (result.accepted) return { advanced: true, highest: result.highest };
  return {
    advanced: false,
    why: `The witness refused generation ${mark.generation} and holds ${result.highest}. Another runtime may believe it is the live copy of this tenant.`,
    highest: result.highest,
  };
}

export const ROLLBACK_CAVEATS: readonly string[] = [
  'Confidential memory does not solve durable-state rollback. An operator who keeps an old encrypted snapshot can restore it, and the runtime decrypts and attests it perfectly.',
  'A signature cannot catch this, because nothing is forged: the host is choosing which of its own past states to hand back.',
  'The witness has to be somewhere the host does not control. A generation recorded only inside the state goes backwards with it.',
  'UNWITNESSED is not the same as not rolled back. It means nobody could tell, and it is reported rather than hidden.',
  'An owner-approved restore names the exact generation. Approval without a generation is permission for any older state, including one the owner never saw.',
  'No witness has been deployed and no generation has been published, so nothing is currently detectable.',
];
