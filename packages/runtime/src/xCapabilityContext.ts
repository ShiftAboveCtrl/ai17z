import { accounts as accountsRepo, workers as workersRepo } from '@xbam/database';
import { capabilitiesFor, type WorkerRole } from '@xbam/jobs';
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
    /*
      Says which of the two things it is, because they are not the same and the
      old sentence only described one of them.

      A job with no account is almost always a typed rehearsal: the Response Lab
      runs those on the mock channel on purpose, so nothing external is touched
      while somebody is still editing a persona. An agent whose owner has linked
      X sees "this agent has no X account", which is false and unactionable. The
      thing to do is rehearse against a real post instead, and this now says so.
    */
    return {
      status: 'UNAVAILABLE' as const,
      why:
        'Nothing here is attached to an X account, so X cannot be read as anybody. ' +
        'A typed rehearsal runs on the mock channel by design; rehearse against a real post to read X.',
    };
  }
  const present = await workersRepo.browserWorkerPresent().catch(() => false);
  if (!present) {
    return {
      status: 'UNAVAILABLE' as const,
      why: 'Nothing that can open a browser is running. This is AI17Z itself rather than anything about this agent.',
    };
  }

  /*
    And whether *this* process is the one that can.

    The question above is about the installation and this one is about the
    program asking it, and they are not the same. A jobs-only worker passes the
    first check happily, because a browser worker is indeed running somewhere,
    and then fails in the implementation with "Google Chrome could not be
    found". Measured on a live installation: `x.read_profile` shortlisted,
    offered, chosen by the model and executed inside the container, which has
    no Chrome and is never going to have one.

    That is the third place this same mistake has been found in one day, the
    others being the engagement loop and the actions it left in flight. The
    rule the product states is that only the worker owns browsers; what was
    missing is that each process has to know whether it is that worker.

    Unset means `all`, which is what a checkout, the tests and a single-process
    installation are, so nothing that could drive a browser stops being able to.
  */
  const role = (process.env.AI17Z_WORKER_ROLE ?? 'all') as WorkerRole;
  if (!capabilitiesFor(role).browserCapable) {
    return {
      status: 'UNAVAILABLE' as const,
      why: 'This part of AI17Z does not drive a browser. The one that does will pick this up instead.',
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
