import { thisWorkerId } from '@xbam/shared';
import type { Account } from '@xbam/shared/contracts';
import { accounts as accountsRepo, workers as workersRepo } from '@xbam/database';

/**
 * The one place an X session is recorded as having lapsed.
 *
 * There were two, with the same rule written out twice: the canonical read path
 * and the radar's own handling. Two implementations of one rule is the thing
 * this codebase keeps saying it does not want, and here it was worse than
 * untidy, because the guard below had to be added to both or it protected
 * neither.
 *
 * ## Only from CONNECTED
 *
 * An account that never had a session is NEEDS_AUTH and is a different thing to
 * tell somebody. And a rate limit is left alone deliberately: sending an owner
 * to re-authenticate a working account over a slow-down is worse than saying
 * nothing.
 *
 * ## And only from the process that owns the browser
 *
 * This is the half that was missing, and it cost a live account.
 *
 * A NEEDS_SIGN_IN means the profile that was read has no session in it. That is
 * only evidence about the account when the profile read is the one the
 * account's session actually lives in. `resolveProfileDir` derives that path
 * locally from the account id and this process's own storage directory, by
 * design, so a process running from somewhere else derives a different
 * directory, finds an empty profile, and is asked to sign in. It then knows
 * nothing whatever about the installation's session.
 *
 * Measured rather than reasoned about: a harness run outside ai17z-main opened
 * a Chrome on a profile that had never been signed in, X asked it to sign in,
 * and a healthy CONNECTED account was marked SESSION_EXPIRED while the real
 * signed-in browser beside it was serving four tabs perfectly well.
 *
 * The standing is the worker registration, because that is what already
 * distinguishes them. `apps/worker` is the only thing that writes a row to
 * `workers`, and a script, a harness or a checkout has none under its id. This
 * is deliberately not `browserWorkerPresent`: that asks whether the
 * installation has a browser worker somewhere, which was true throughout the
 * incident and is exactly why it did not help.
 *
 * Never awaited by its callers. Telling the owner must not slow a poll down or
 * fail one.
 */
export async function noteSessionExpired(
  account: Pick<Account, 'id' | 'status'> | null | undefined,
  outcome: string,
  detail: string,
): Promise<void> {
  if (outcome !== 'NEEDS_SIGN_IN') return;
  if (!account || account.status !== 'CONNECTED') return;
  if (!(await workersRepo.isLiveBrowserWorker(thisWorkerId()).catch(() => false))) return;
  await accountsRepo
    .updateAccount(account.id, { status: 'SESSION_EXPIRED', lastError: detail || 'X asked for a sign-in.' })
    .catch(() => undefined);
}
