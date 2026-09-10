import { accounts as accountsRepo, workers as workersRepo } from '@xbam/database';
import { buildChannelContext } from './channelContext';

/**
 * What every X capability needs before it can do anything.
 *
 * Extracted so that the capabilities themselves can be split across files
 * without two copies of "which account is this" appearing. Both of these
 * answers have to be the same everywhere: an agent told "you have not enabled
 * this" about something that could not have worked anyway learns the wrong
 * thing, and two readiness checks that disagree produce exactly that.
 */

/**
 * Which account a capability runs as.
 *
 * A capability arrives with an account id when the job has one. Without it
 * there is nothing to read X as: `docs/ENGINEERING.md` is explicit that X's own
 * index is reachable only as the agent's own signed-in account, and guessing an
 * account would mean reading X as somebody the owner did not choose.
 */
export async function contextFor(accountId: string | null, jobId: string | null) {
  if (!accountId) return null;
  const account = await accountsRepo.getAccount(accountId);
  if (!account || account.channel !== 'x') return null;
  return buildChannelContext(account, jobId);
}

/**
 * Whether anything could drive a browser right now.
 *
 * Asked before the permission model, because an owner told "you have not
 * enabled this" about something that could not have worked anyway learns the
 * wrong thing. The same heartbeat the interface reads, so the two cannot
 * disagree about whether a browser exists.
 */
export async function browserReadiness(accountId: string | null) {
  if (!accountId) {
    return { status: 'UNAVAILABLE' as const, why: 'This agent has no X account to read as.' };
  }
  const present = await workersRepo.browserWorkerPresent().catch(() => false);
  if (!present) {
    return {
      status: 'UNAVAILABLE' as const,
      why: 'Nothing that can open a browser is running. This is AI17Z itself rather than anything about this agent.',
    };
  }
  return { status: 'AVAILABLE' as const };
}

/** A post reference the action path will accept: always a full status URL. */
export function normaliseStatus(reference: string): string {
  const id = reference.match(/\/status\/(\d{5,25})/)?.[1] ?? reference.trim();
  return `https://x.com/i/web/status/${id}`;
}

/**
 * The argument a model actually gets wrong, refused with the field named.
 *
 * `@someone` is a plausible-looking value for a post: it would send a read to a
 * profile page and return nothing about any post. Shape-checked at the schema
 * so the refusal names the field, rather than in the implementation where it
 * would surface as a failure.
 */
export function looksLikeAPost(value: string): boolean {
  return /\/status\/\d{5,25}/.test(value) || /^\d{5,25}$/.test(value.trim());
}
