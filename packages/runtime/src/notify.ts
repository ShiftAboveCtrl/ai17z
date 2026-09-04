/**
 * The conditions worth interrupting somebody for.
 *
 * The hard part of a notification system is not delivering them. It is deciding
 * that a thing is worth saying at all, and then not saying it again nine
 * hundred times. Both decisions live here rather than at the call sites, so the
 * answer to "why was I told this" is one file rather than twenty.
 *
 * What belongs here and what does not:
 *
 *   - a mention waiting for an answer is the **inbox**, not a notification. It
 *     is work, it is already listed, and duplicating it produces two places to
 *     clear the same thing and one of them will be wrong
 *   - a job that failed and will retry is **activity**. Nobody needs waking for
 *     something the system is already handling
 *   - an account locked out of X, a worker that stopped, an agent with no model
 *     configured: these produce no job at all, which is exactly why a screen
 *     built out of jobs cannot show them. They are what this is for
 *
 * Severity is about what happens if it is ignored, never about how alarming the
 * words are:
 *
 *   CRITICAL  the agent is not working and will not start working by itself
 *   WARNING   it is working, but something is degraded or about to stop it
 *   INFO      worth knowing, nothing is broken
 *
 * Every condition names how to clear it, and every one that can fix itself is
 * cleared by the code that fixes it. A notification that stays on the screen
 * after the problem went away teaches people to ignore the screen.
 */
import {
  WORKER_PRESENT_SECONDS,
  accounts as accountsRepo,
  agents as agentsRepo,
  notifications as notificationsRepo,
  providers as providersRepo,
  workers as workersRepo,
} from '@xbam/database';
import type { NotificationRecord } from '@xbam/database';
import { createLogger } from '@xbam/shared';
import { pauseState } from './killSwitch';

const log = createLogger('notify');

/**
 * How long an acknowledgement silences a recurring problem by default.
 *
 * Long enough to fix something without being nagged, short enough that a
 * problem nobody actually fixed comes back the same day.
 */
export const DEFAULT_MUTE_MS = 4 * 60 * 60_000;

/** Dedupe keys, built in one place so a raise and its resolve cannot disagree. */
export const notificationKey = {
  accountNeedsUser: (accountId: string) => `account.needs-user:${accountId}`,
  accountSignedOut: (accountId: string) => `account.signed-out:${accountId}`,
  browserGone: (accountId: string) => `browser.gone:${accountId}`,
  noModel: (agentId: string) => `agent.no-model:${agentId}`,
  providerFailing: (credentialId: string) => `provider.failing:${credentialId}`,
  limitReached: (agentId: string, period: string) => `budget.reached:${agentId}:${period}`,
  workerStopped: () => 'worker.stopped',
  everythingPaused: () => 'runtime.paused',
};

/**
 * An account is waiting for a person to answer a challenge.
 *
 * Critical, because AI17Z never types a password and never answers a security
 * challenge: nothing will happen on this account until somebody goes and does
 * it. The window is open and waiting.
 */
export async function accountNeedsUser(input: {
  accountId: string;
  handle: string;
  challengeKind: string | null;
  detail: string;
}): Promise<NotificationRecord | null> {
  return notificationsRepo.raise({
    kind: 'ACCOUNT_NEEDS_USER',
    severity: 'CRITICAL',
    accountId: input.accountId,
    title: `@${input.handle} needs you to finish signing in`,
    body: `${input.detail} The browser window is open and nothing has been typed into it. AI17Z never answers a security challenge itself.`,
    actionLabel: 'Open accounts',
    actionHref: '/accounts',
    data: { challengeKind: input.challengeKind ?? 'unknown' },
    dedupeKey: notificationKey.accountNeedsUser(input.accountId),
  });
}

/** An account that was signed in no longer is. */
export async function accountSignedOut(input: {
  accountId: string;
  handle: string;
  detail: string;
}): Promise<NotificationRecord | null> {
  return notificationsRepo.raise({
    kind: 'ACCOUNT_SIGNED_OUT',
    severity: 'CRITICAL',
    accountId: input.accountId,
    title: `@${input.handle} is signed out`,
    body: `${input.detail} Nothing will be read or sent on this account until it is signed in again.`,
    actionLabel: 'Open accounts',
    actionHref: '/accounts',
    dedupeKey: notificationKey.accountSignedOut(input.accountId),
  });
}

/**
 * An account is well again.
 *
 * Called from wherever a health check succeeds. Both keys are cleared because
 * a sign-in fixes either problem and knowing which one it had is not worth a
 * second call site that could be forgotten.
 */
export async function accountIsWell(accountId: string): Promise<void> {
  await notificationsRepo.resolve(notificationKey.accountNeedsUser(accountId));
  await notificationsRepo.resolve(notificationKey.accountSignedOut(accountId));
  await notificationsRepo.resolve(notificationKey.browserGone(accountId));
}

export async function agentHasNoModel(input: { agentId: string; name: string }): Promise<NotificationRecord | null> {
  return notificationsRepo.raise({
    kind: 'AGENT_HAS_NO_MODEL',
    severity: 'CRITICAL',
    agentId: input.agentId,
    title: `${input.name} has no model configured`,
    body: 'It cannot write anything until a provider is connected and a primary model is chosen.',
    actionLabel: 'Choose a model',
    actionHref: `/agents/${input.agentId}#intelligence`,
    dedupeKey: notificationKey.noModel(input.agentId),
  });
}

export async function agentHasAModel(agentId: string): Promise<void> {
  await notificationsRepo.resolve(notificationKey.noModel(agentId));
}

/**
 * A provider is refusing calls.
 *
 * A warning rather than critical: a fallback role may be answering, so the
 * agent is often still working. The message says which provider and what it
 * said, because "a provider failed" is not something anybody can act on.
 */
export async function providerFailing(input: {
  credentialId: string;
  provider: string;
  label: string;
  detail: string;
  agentId?: string | null;
}): Promise<NotificationRecord | null> {
  return notificationsRepo.raise({
    kind: 'PROVIDER_FAILING',
    severity: 'WARNING',
    agentId: input.agentId ?? null,
    title: `${input.label} is refusing calls`,
    body: `${input.provider} said: ${input.detail}`,
    actionLabel: 'Open providers',
    actionHref: '/providers',
    dedupeKey: notificationKey.providerFailing(input.credentialId),
  });
}

export async function providerRecovered(credentialId: string): Promise<void> {
  await notificationsRepo.resolve(notificationKey.providerFailing(credentialId));
}

/**
 * A spending limit stopped something.
 *
 * A warning rather than critical, and deliberately: the agent stopped because
 * somebody told it to. It is here so that "the agent went quiet" has an answer
 * on the screen rather than only in a job's error field.
 */
export async function limitReached(input: {
  agentId: string;
  name: string;
  period: 'day' | 'month';
  message: string;
}): Promise<NotificationRecord | null> {
  return notificationsRepo.raise({
    kind: 'LIMIT_REACHED',
    severity: 'WARNING',
    agentId: input.agentId,
    title: `${input.name} has reached its ${input.period === 'day' ? 'daily' : 'monthly'} limit`,
    body: input.message,
    actionLabel: 'Change the limit',
    actionHref: `/agents/${input.agentId}#policies`,
    dedupeKey: notificationKey.limitReached(input.agentId, input.period),
  });
}

/**
 * Nothing is running.
 *
 * The one condition where every other screen looks fine: agents are active,
 * accounts are signed in, jobs are queued, and nothing moves because the
 * process that moves them is not there. Checked on a schedule rather than
 * raised by an event, because the event is an absence.
 *
 * The window comes from `present()` rather than from a constant here. Two
 * answers to "is a worker running" would eventually disagree, and the one that
 * disagreed would be the one telling somebody their installation was broken.
 */
export async function checkWorkerPresence(): Promise<NotificationRecord | null> {
  const alive = await workersRepo.present();

  if (alive.length > 0) {
    await notificationsRepo.resolve(notificationKey.workerStopped());
    return null;
  }

  log.warn('no worker has reported in', { withinSeconds: WORKER_PRESENT_SECONDS });
  return notificationsRepo.raise({
    kind: 'WORKER_STOPPED',
    severity: 'CRITICAL',
    title: 'No worker is running',
    body: `Nothing has reported in for over ${WORKER_PRESENT_SECONDS} seconds. Agents will not read, reply or post until a worker is running again. Start one with "npm run dev:worker".`,
    actionLabel: 'Open health',
    actionHref: '/health',
    dedupeKey: notificationKey.workerStopped(),
  });
}

/**
 * Everything is paused.
 *
 * Information rather than a problem: somebody pressed the button on purpose.
 * It exists so that a person who comes back an hour later and wonders why
 * nothing is happening is told, instead of debugging a pause they set.
 */
export async function everythingPaused(input: { by: string | null; reason: string }): Promise<NotificationRecord | null> {
  return notificationsRepo.raise({
    kind: 'EVERYTHING_PAUSED',
    severity: 'INFO',
    title: 'Everything is paused',
    body: `${input.reason} Nothing will be sent until it is released${input.by ? `. Paused by ${input.by}` : ''}.`,
    actionLabel: 'Release',
    actionHref: '/health',
    dedupeKey: notificationKey.everythingPaused(),
  });
}

export async function everythingReleased(): Promise<void> {
  await notificationsRepo.resolve(notificationKey.everythingPaused());
}

/**
 * The one-line summary a header badge shows.
 *
 * Counts rather than a list, because the header is not the place to read them,
 * and the worst open severity, because a badge that says "3" when one of them
 * is an account locked out reads the same as three things nobody needs.
 */
export async function notificationSummary(): Promise<{
  counts: { critical: number; warning: number; info: number };
  worst: 'CRITICAL' | 'WARNING' | 'INFO' | null;
  total: number;
}> {
  const counts = await notificationsRepo.countOpen();
  const total = counts.critical + counts.warning + counts.info;
  const worst = counts.critical > 0 ? 'CRITICAL' : counts.warning > 0 ? 'WARNING' : counts.info > 0 ? 'INFO' : null;
  return { counts, worst, total };
}

/**
 * Brings every condition on this list up to date with what is actually true.
 *
 * Derived from state on a schedule rather than raised from events, and
 * deliberately. There are a dozen places an account's status changes and one of
 * them will eventually be added without a notification call beside it; asking
 * "what is true now" cannot be forgotten in the same way. It is also what makes
 * clearing work: a problem that fixed itself is resolved by the same sweep that
 * would have raised it, without every recovery path having to remember.
 *
 * Cheap enough to run often: three small queries and a write only where
 * something changed.
 */
export async function sweepNotifications(): Promise<{ raised: number; resolved: number }> {
  let raised = 0;
  let resolved = 0;
  const count = (record: NotificationRecord | null) => {
    if (record) raised += 1;
  };

  if (await checkWorkerPresence()) raised += 1;

  const pause = await pauseState();
  if (pause.paused) count(await everythingPaused({ by: pause.by, reason: pause.reason }));
  else {
    await everythingReleased();
  }

  for (const account of await accountsRepo.allAccounts()) {
    if (account.status === 'CHALLENGE_REQUIRES_USER') {
      count(
        await accountNeedsUser({
          accountId: account.id,
          handle: account.handle,
          challengeKind: account.challengeKind ?? null,
          detail: account.lastHealthStatus ?? 'A security challenge is waiting.',
        }),
      );
    } else if (SIGNED_OUT_STATUSES.includes(account.status)) {
      count(
        await accountSignedOut({
          accountId: account.id,
          handle: account.handle,
          detail: account.lastHealthStatus ?? 'The stored session is no longer accepted.',
        }),
      );
    } else if (account.status === 'CONNECTED') {
      await accountIsWell(account.id);
      resolved += 1;
    }
  }

  for (const agent of await agentsRepo.allAgents()) {
    // Only agents somebody has switched on. An agent still being set up has no
    // model yet by definition, and saying so is noise rather than news.
    if (agent.state !== 'ACTIVE') continue;
    const models = await providersRepo.listModelConfigs(agent.id);
    if (models.some((config: { role: string }) => config.role === 'primary')) {
      await agentHasAModel(agent.id);
    } else {
      count(await agentHasNoModel({ agentId: agent.id, name: agent.name }));
    }
  }

  return { raised, resolved };
}

/**
 * States that mean a session stopped working, as opposed to one that never
 * started or one a person is in the middle of.
 */
const SIGNED_OUT_STATUSES: readonly string[] = ['SESSION_EXPIRED', 'NEEDS_AUTH', 'TIMEOUT'];
