import { describeSignIn, type Account } from '@xbam/shared/contracts';
import { BadRequestError, PipelineError, createLogger } from '@xbam/shared';
import { accountCredentials, accounts as accountsRepo, query, withTransaction } from '@xbam/database';
import {
  BLUESKY_RESUME_KEY,
  BLUESKY_SESSION_GENERATION_KEY,
  BLUESKY_VERSION_KEY,
  BLUESKY_WATERMARK_KEY,
  blueskyAdapter,
  blueskyNotificationsResume,
  blueskyNotificationsSeenThrough,
  blueskyNotificationsVersionOf,
  blueskyServiceTargetFor,
  forgetBlueskySession,
  type ChannelContext,
  type IngestProgress,
} from '@xbam/channels';
import { buildChannelContext, storageDir } from './channelContext';

const log = createLogger('bluesky-connect');

/**
 * Linking a Bluesky account.
 *
 * The one place an app password is accepted. It is checked against Bluesky
 * **before anything is saved**, so a typo creates neither an account row nor a
 * sealed credential, and what is saved afterwards is saved sealed under the
 * master key in `account_credentials`, the table an X sign-in already uses.
 * Nothing here returns it, logs it, or writes it to an audit row or a browser
 * task, and there is no browser task: this channel has no browser.
 *
 * ### Only an app password
 *
 * The form Bluesky gives them is `xxxx-xxxx-xxxx-xxxx`, and anything else is
 * refused with a sentence about where to make one. That is a safeguard for the
 * owner rather than a convenience: an app password can be revoked on its own and
 * cannot change the account's email or delete it, and the main password can do
 * both. A form that accepted either would invite pasting the one that must never
 * be stored. It also means the email-code challenge cannot arise at all.
 */

const APP_PASSWORD = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i;

export interface ConnectBlueskyInput {
  ownerId: string;
  /** The handle (`name.bsky.social`) or the account's email. */
  identifier: string;
  appPassword: string;
  /** Only for an account on its own server. Absent means bsky.social. */
  serviceUrl?: string | null;
}

export interface ConnectBlueskyResult {
  account: Account;
  /** True when this call made the account, false when it refreshed an existing one. */
  created: boolean;
}

/** A context for a sign-in that has no account row yet. Holds the password for one call. */
function probeContext(settings: Record<string, unknown>, identifier: string, appPassword: string): ChannelContext {
  const now = new Date().toISOString();
  return {
    account: {
      id: 'synthetic-bluesky-connect',
      ownerId: 'synthetic',
      channel: 'bluesky',
      remoteAccountId: null,
      handle: identifier,
      displayName: identifier,
      status: 'DISCONNECTED',
      enabled: true,
      capabilities: [],
      settings,
      lastHealthCheckAt: null,
      lastHealthStatus: null,
      lastActivityAt: null,
      lastError: null,
      authStartedAt: null,
      authDeadlineAt: null,
      challengeKind: null,
      createdAt: now,
      updatedAt: now,
    },
    session: null,
    storageDir: storageDir(),
    logger: log,
    jobId: null,
    credentials: async () => ({ loginUsername: identifier, loginPassword: appPassword }),
  };
}

export async function connectBlueskyAccount(input: ConnectBlueskyInput): Promise<ConnectBlueskyResult> {
  const identifier = input.identifier.trim().replace(/^@+/, '');
  if (!identifier) throw new BadRequestError('Give the Bluesky handle, for example name.bsky.social.');
  if (!APP_PASSWORD.test(input.appPassword)) {
    throw new BadRequestError(
      'That does not look like an app password, which has the form xxxx-xxxx-xxxx-xxxx. ' +
        'Create one in Bluesky under Settings, Privacy and security, App passwords. ' +
        'AI17Z never asks for your main password.',
    );
  }

  const custom = input.serviceUrl?.trim();
  const settings: Record<string, unknown> = custom ? { bluesky: { serviceUrl: custom } } : {};
  try {
    // Throws for an address that is not https, so a bad one is refused here
    // with the sentence rather than stored and silently treated as absent.
    blueskyServiceTargetFor(settings);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : 'That server address is not usable.');
  }

  // 1. Prove the details before keeping anything.
  const probe = probeContext(settings, identifier, input.appPassword);
  const connected = await blueskyAdapter.connect(probe);
  forgetBlueskySession(probe.account.id);
  if (connected.status !== 'CONNECTED' || !connected.handle || !connected.remoteAccountId) {
    // `detail` is the adapter's sentence and never carries the password.
    throw new BadRequestError(connected.detail);
  }

  // 2. Keep the account, and seal the details under the master key.
  const handle = connected.handle.toLowerCase();
  const existing = await accountsRepo.findByHandle(input.ownerId, 'bluesky', handle);
  let account: Account;
  let created = false;
  if (existing) {
    account = existing;
  } else {
    account = await accountsRepo.createAccount({
      ownerId: input.ownerId,
      channel: 'bluesky',
      handle,
      displayName: handle,
      remoteAccountId: connected.remoteAccountId,
      capabilities: [...blueskyAdapter.capabilities],
      settings,
    });
    created = true;
  }
  await accountCredentials.setCredentials({
    accountId: account.id,
    loginUsername: identifier,
    loginPassword: input.appPassword,
  });
  /*
    The server address and the session generation are written by one statement
    against the row as it is now, never from the copy read above.

    A poll finishing in between moves the notification mark, and writing back a
    snapshot taken before it would put the mark back or lose it. Only the two
    keys this link owns are touched. A reconnect that names no server means the
    default one and must not keep a custom address from an earlier link, and a
    new link is a new sign-in, so every process holding the old session drops it.
  */
  if (existing) await replaceServerAndEndSessions(account.id, custom || null);
  account = await accountsRepo.updateAccount(account.id, {
    status: 'CONNECTED',
    enabled: true,
    remoteAccountId: connected.remoteAccountId,
    lastError: null,
    challengeKind: null,
    lastHealthStatus: 'connected',
    touchHealthCheck: true,
  });

  // 3. Prime the session cache for the real account, so the first poll does not
  // spend a sign-in. A failure here is not the connection failing; it was proved.
  await blueskyAdapter
    .connect(await buildChannelContext(account, null))
    .catch(() => undefined);

  log.info('bluesky account linked', { accountId: account.id, handle, created });
  return { account, created };
}

/** Tells a person why an account is not connected, in the words they need. */
export function describeBlueskyFailure(error: unknown): string {
  if (error instanceof PipelineError) return error.message;
  return error instanceof Error ? error.message : 'Bluesky could not be reached.';
}

/**
 * Records what a poll read, after its events were ingested.
 *
 * Called by the poller and never by the adapter, so nothing here covers an event
 * that was not taken in. One transaction over the locked row, merging into the
 * settings as they are now, so a reconnect or another poll writing at the same
 * moment is not overwritten.
 *
 * **Compare and set.** `startedAtVersion` is the version of the notification
 * state the poll read when it began. The row lock serialises writers but does not
 * say whose continuation this is: a newer poll can have stored `throughAt = 400`
 * and a cursor, and an older one that completes afterwards would inherit that,
 * move the mark to 400 and clear the cursor with everything between unread. So the
 * write applies only if the version is still the one the poll started from. A poll
 * that lost the race writes nothing (its events were ingested and the unique index
 * makes that harmless) and returns false; the state it did not touch is whatever
 * the newer poll left, and the next poll resumes from it.
 *
 * - **Complete** (the poll reached the mark, or the history ran out): the mark
 *   moves to the newest event of the burst, forward only, and the continuation is
 *   cleared.
 * - **Incomplete** (the page limit or the read budget stopped it): the mark does
 *   **not** move. What is left unread is older than everything read, so moving the
 *   mark to the newest event would skip it for ever. The cursor is kept and the
 *   newest event so far is remembered as `throughAt`, to become the mark when the
 *   burst has been read to its end.
 */
export async function advanceNotificationWatermark(
  accountId: string,
  events: ReadonlyArray<{ raw: Record<string, unknown> }>,
  progress: IngestProgress | undefined,
  startedAtVersion: number,
): Promise<boolean> {
  let newest = 0;
  for (const event of events) {
    const at = typeof event.raw.indexedAt === 'string' ? Date.parse(event.raw.indexedAt) : NaN;
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  const time = (value: string | null | undefined) => (value ? Date.parse(value) : 0) || 0;

  return withTransaction(async (tx) => {
    const row = await tx.one<{ settings: Record<string, unknown> | null }>(
      'SELECT settings FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    );
    if (!row) return false;
    // Somebody else wrote the state since this poll read it. What this poll
    // knows is out of date, so it must not decide anything.
    if (blueskyNotificationsVersionOf(row.settings) !== startedAtVersion) return false;
    const current = (row.settings?.bluesky ?? {}) as Record<string, unknown>;
    const mark = time(blueskyNotificationsSeenThrough(row.settings));
    const resume = blueskyNotificationsResume(row.settings);
    const next: Record<string, unknown> = { ...current };

    // A continuation the adapter had to abandon is not one to keep carrying.
    const through = Math.max(newest, progress?.restarted ? 0 : time(resume?.throughAt));

    if (progress && !progress.complete) {
      if (progress.resume) {
        next[BLUESKY_RESUME_KEY] = {
          cursor: progress.resume,
          throughAt: through > 0 ? new Date(through).toISOString() : null,
        };
      } else {
        // Not finished and nowhere to carry on from: a stored cursor the server
        // refused was dropped and the budget ran out before starting again. The
        // mark does not move; the stale continuation goes, so the next poll
        // starts from the newest.
        delete next[BLUESKY_RESUME_KEY];
      }
    } else {
      delete next[BLUESKY_RESUME_KEY];
      const moved = Math.max(mark, through);
      if (moved > 0) next[BLUESKY_WATERMARK_KEY] = new Date(moved).toISOString();
    }

    next[BLUESKY_VERSION_KEY] = startedAtVersion + 1;
    await tx.query(
      `UPDATE accounts
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{bluesky}', $2::jsonb)
        WHERE id = $1`,
      [accountId, JSON.stringify(next)],
    );
    return true;
  });
}

/**
 * Replaces the account's Bluesky server and bumps its session generation, in one
 * statement over the row as it is now.
 *
 * `$2` is `{"serviceUrl": ...}` or `{}`: the server is removed and then put back
 * if one was named, so naming none means the default. Everything else under
 * `bluesky` (the notification mark, its continuation) and every other settings
 * key is carried through untouched by the database rather than by a copy.
 */
export async function replaceServerAndEndSessions(accountId: string, serviceUrl: string | null): Promise<void> {
  await query(
    `UPDATE accounts
        SET settings = jsonb_set(
              coalesce(settings, '{}'::jsonb),
              '{bluesky}',
              (coalesce(settings->'bluesky', '{}'::jsonb) - 'serviceUrl')
                || $2::jsonb
                || jsonb_build_object($3::text, coalesce((settings->'bluesky'->>$3)::int, 0) + 1)
            )
      WHERE id = $1`,
    [accountId, JSON.stringify(serviceUrl ? { serviceUrl } : {}), BLUESKY_SESSION_GENERATION_KEY],
  );
}

/**
 * Makes every process stop using the sessions it holds for this account.
 *
 * Sessions are in the memory of whichever process made them, and the API cannot
 * reach the worker's. So the account's generation is bumped, which each process
 * reads before reusing a session (`ensureSession`): one made under an older
 * generation is ended on Bluesky's side by the process that holds its tokens, and
 * not used. Atomic, so two bumps are two.
 */
export async function bumpSessionGeneration(accountId: string): Promise<void> {
  await query(
    `UPDATE accounts
        SET settings = jsonb_set(
              coalesce(settings, '{}'::jsonb),
              '{bluesky}',
              coalesce(settings->'bluesky', '{}'::jsonb)
                || jsonb_build_object($2::text, coalesce((settings->'bluesky'->>$2)::int, 0) + 1)
            )
      WHERE id = $1`,
    [accountId, BLUESKY_SESSION_GENERATION_KEY],
  );
}

/**
 * Signs a Bluesky account back in with the app password already stored for it.
 *
 * What "Reconnect" means here. On X it switches the account on and a person
 * signs in; Bluesky has no window, and an account left DISCONNECTED is never
 * polled, so switching it on and stopping there would be a button that does
 * nothing. The stored password is proved against Bluesky exactly as at link
 * time, and the account's status says what came of it. Nothing is typed that
 * the owner did not store, and a challenge ends it as it always does.
 */
export async function reconnectBlueskyAccount(accountId: string): Promise<Account> {
  const account = await accountsRepo.requireAccount(accountId);
  if (account.channel !== 'bluesky') return account;
  forgetBlueskySession(account.id);
  const result = await blueskyAdapter.connect(await buildChannelContext(account, null));
  const explanation = describeSignIn('bluesky', result.status);
  return accountsRepo.updateAccount(account.id, {
    status: result.status,
    lastError: result.status === 'CONNECTED' ? null : result.detail.slice(0, 500),
    lastHealthStatus: result.status === 'CONNECTED' ? 'connected' : (explanation?.what ?? result.detail).slice(0, 300),
    challengeKind: result.status === 'CHALLENGE_REQUIRES_USER' ? 'EMAIL_CODE' : null,
    touchHealthCheck: true,
    ...(result.remoteAccountId ? { remoteAccountId: result.remoteAccountId } : {}),
  });
}

/** Ends the account's session on Bluesky's side. Best effort; the account is switched off either way. */
export async function disconnectBlueskyAccount(accountId: string): Promise<void> {
  const account = await accountsRepo.getAccount(accountId);
  if (!account || account.channel !== 'bluesky') return;
  // First, so that by the time this returns no process may reuse a session it
  // holds, whichever process that is. Ending this process's own is the easy half.
  await bumpSessionGeneration(account.id);
  await blueskyAdapter.disconnect(await buildChannelContext(account, null));
}
