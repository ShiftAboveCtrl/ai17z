import type { ActionResult } from '@xbam/channels';

/**
 * Whether an original post has proof that it is public.
 *
 * A post has no target to look at afterwards, so the evidence is the remote's
 * own id or address for it, read back from the account. A submit that returned
 * and a composer that closed are what the legacy poster reported as success;
 * neither is evidence on its own, and the X adapter says so by returning no id
 * with `readBackConfirmed: false` when it could not find the post.
 *
 * An adapter that states `readBackConfirmed: false` is believed even if it also
 * supplied an id, because it is the only party that knows how the id was got.
 */
export function postHasReadBack(result: Pick<ActionResult, 'remoteActionId' | 'remoteActionUrl' | 'verification'>): boolean {
  if ((result.verification?.evidence as { readBackConfirmed?: unknown } | undefined)?.readBackConfirmed === false) return false;
  return Boolean(result.remoteActionId || result.remoteActionUrl);
}

/** Marker on the action row's verification, so a later attempt knows what came before it. */
export const POST_OUTCOME_AMBIGUOUS = 'AMBIGUOUS';

/** True when an action row records an earlier post attempt nobody could confirm. */
export function priorPostWasAmbiguous(verification: Record<string, unknown> | null | undefined): boolean {
  return verification?.postOutcome === POST_OUTCOME_AMBIGUOUS;
}
