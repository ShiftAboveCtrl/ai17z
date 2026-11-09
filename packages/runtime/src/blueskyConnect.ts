import { describeSignIn, type Account } from '@xbam/shared/contracts';
import { BadRequestError, PipelineError, createLogger } from '@xbam/shared';
import { accountCredentials, accounts as accountsRepo, query } from '@xbam/database';
import {
  BLUESKY_WATERMARK_KEY,
  blueskyAdapter,
  blueskyServiceTargetFor,
  forgetBlueskySession,
  type ChannelContext,
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

/**
 * An account's settings after a reconnect.
 *
 * The Bluesky server is replaced by `next`'s, or by the default if `next` names
 * none, and everything else is kept. Exported so the case a test cannot reach
 * over the network (a reconnect to the default server) is still a test.
 */
export function settingsAfterReconnect(current: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const { bluesky: previous, ...rest } = current;
  const kept = previous && typeof previous === 'object' ? { ...(previous as Record<string, unknown>) } : {};
  delete kept.serviceUrl;
  const incoming = (next.bluesky ?? {}) as Record<string, unknown>;
  const merged = { ...kept, ...incoming };
  return Object.keys(merged).length > 0 ? { ...rest, bluesky: merged } : rest;
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
  account = await accountsRepo.updateAccount(account.id, {
    status: 'CONNECTED',
    enabled: true,
    remoteAccountId: connected.remoteAccountId,
    lastError: null,
    challengeKind: null,
    lastHealthStatus: 'connected',
    touchHealthCheck: true,
    // The server address is replaced, never merged: a reconnect that names no
    // server means the default one, and must not keep a custom address from an
    // earlier link. Every other setting on the account is left as it was.
    ...(existing ? { settings: settingsAfterReconnect(existing.settings, settings) } : {}),
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
 * Moves an account's notification mark forward after its events were ingested.
 *
 * Called by the poller once ingest has finished, never by the adapter, so the
 * mark only ever covers what was actually taken in. Forward only, in one
 * statement: a stale poller finishing late must not pull it back, and a
 * reconnect writing settings at the same moment must not lose it. The mark is
 * the newest `indexedAt` among the events, because the likes and follows that
 * may be newer are not events and are skipped again for free.
 */
export async function advanceNotificationWatermark(
  accountId: string,
  events: ReadonlyArray<{ raw: Record<string, unknown> }>,
): Promise<void> {
  let newest = 0;
  for (const event of events) {
    const at = typeof event.raw.indexedAt === 'string' ? Date.parse(event.raw.indexedAt) : NaN;
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  if (newest === 0) return;
  const iso = new Date(newest).toISOString();
  await query(
    `UPDATE accounts
        SET settings = jsonb_set(
              coalesce(settings, '{}'::jsonb),
              '{bluesky}',
              coalesce(settings->'bluesky', '{}'::jsonb) || jsonb_build_object($2::text, $3::text)
            )
      WHERE id = $1
        AND coalesce(settings->'bluesky'->>$2, '') < $3`,
    [accountId, BLUESKY_WATERMARK_KEY, iso],
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
  await blueskyAdapter.disconnect(await buildChannelContext(account, null));
}
