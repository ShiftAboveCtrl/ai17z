import type { CapacityClass, RadarSourceKind } from '@xbam/shared/contracts';
import { createLogger, errorMessage } from '@xbam/shared';
import {
  accounts as accountsRepo,
  cadences as cadencesRepo,
  xCapacity as capacityRepo,
  type XSignal,
} from '@xbam/database';
import type { AccountStatus } from '@xbam/shared/contracts';
import {
  readAllowance,
  settleCapacity,
  writeAllowance,
  type CapacityState,
  type CapacityVerdict,
} from './accountHealth';

const log = createLogger('capacity');

/**
 * One account's budget for asking X anything, and its breaker.
 *
 * This is the cadence engine's answer to "may this account read X now", the
 * way `checkAccountCadence` is its answer to "may it act". It adds no timer:
 * the breaker is settled lazily whenever somebody asks, which is often, and a
 * state that nobody asks about does not need to move.
 */

/** Which class of capacity a radar source spends. */
export function capacityClassForSource(kind: RadarSourceKind): CapacityClass {
  switch (kind) {
    case 'notifications':
    case 'mention_search':
    case 'reply_search':
    case 'own_threads':
      return 'DIRECT';
    case 'tracked_account':
      return 'TARGET';
    default:
      return 'BROAD';
  }
}

/** Which class of capacity work on an event spends. */
export function capacityClassForEvent(eventType: string | null | undefined): CapacityClass {
  switch (eventType) {
    case 'MENTION':
    case 'REPLY':
    case 'DIRECT_MESSAGE':
    case 'NEW_MESSAGE':
    case 'MANUAL_TRIGGER':
      return 'DIRECT';
    case 'TARGET_ACCOUNT_ACTIVITY':
      return 'TARGET';
    default:
      // Keyword matches and anything the agent originated itself. A post is
      // the agent speaking unasked, which is exactly what yields first.
      return 'BROAD';
  }
}

/**
 * What kind of pushback an error from X is, if it is pushback at all.
 *
 * Read off the sentence the reader already wrote rather than off a code,
 * because the sentence is what every path produces and a code is not. Not
 * found, protected and signed out are deliberately not pressure: they say
 * nothing about how hard the account is asking.
 */
export function classifyXSignal(message: string | null | undefined): XSignal | null {
  if (!message) return null;
  const text = message.toLowerCase();
  if (/slow down|rate.?limit|too many requests|\b429\b/.test(text)) return 'RATE_LIMITED';
  if (/never (finished|drew)|did not finish|loading screen|stopped answering|was given up on/.test(text)) return 'STALLED';
  if (/something went wrong|lost connectivity|try reloading|could not show/.test(text)) return 'BROKEN';
  return null;
}

async function loadState(accountId: string): Promise<{
  state: CapacityState;
  status: AccountStatus;
  changedAt: Date | null;
} | null> {
  const row = await capacityRepo.getState(accountId);
  if (!row) return null;
  return {
    state: {
      health: row.health,
      reason: row.healthReason,
      until: row.healthUntil ? new Date(row.healthUntil) : null,
      strikes: row.healthStrikes,
    },
    status: row.status as AccountStatus,
    changedAt: row.healthChangedAt ? new Date(row.healthChangedAt) : null,
  };
}

/**
 * Moves the breaker to wherever it should be now, and returns that.
 *
 * Counts start from the last time the breaker moved or an hour ago, whichever
 * is later, so a finished cooldown does not trip on the signals that caused it.
 */
export async function settleAccountCapacity(accountId: string, now = new Date()): Promise<CapacityState | null> {
  const loaded = await loadState(accountId);
  if (!loaded) return null;
  const config = (await cadencesRepo.activeCadence(accountId)).capacity;
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const since = loaded.changedAt && loaded.changedAt > hourAgo ? loaded.changedAt : hourAgo;
  const usage = await capacityRepo.usage(accountId, since);

  const next = settleCapacity(
    loaded.state,
    {
      status: loaded.status,
      rateLimits: usage.rateLimits,
      stalled: usage.stalled,
      // X's own error page counts as pressure only when several arrive
      // together; one is a page the source that asked backs off from itself.
      // See BROKEN_AS_PRESSURE.
      broken: usage.broken,
      quietForMs: loaded.changedAt ? now.getTime() - loaded.changedAt.getTime() : null,
      failedWrites: 0,
      /*
        Deliberately not the failing-source count. A source can fail for
        reasons that have nothing to do with how hard the account is asking --
        a keyword X will not show, a watched account gone private -- and two of
        those would hold the account slowed for ever. Pushback from X is what
        this breaker is for, and it is counted directly above.
      */
      failingSources: 0,
    },
    config,
    now,
  );

  const moved =
    next.health !== loaded.state.health ||
    next.strikes !== loaded.state.strikes ||
    next.reason !== loaded.state.reason ||
    (next.until?.getTime() ?? null) !== (loaded.state.until?.getTime() ?? null);
  if (moved) {
    await capacityRepo.setState({
      accountId,
      health: next.health,
      reason: next.reason,
      until: next.until,
      strikes: next.strikes,
    });
    if (next.health !== loaded.state.health) {
      log.info('x capacity moved', { accountId, from: loaded.state.health, to: next.health, reason: next.reason });
    }
  }
  return next;
}

/** Whether one more read of X may happen now, for this class of work. */
export async function checkReadCapacity(
  accountId: string,
  klass: CapacityClass,
  now = new Date(),
  options: { forReply?: boolean } = {},
): Promise<CapacityVerdict> {
  const state = await settleAccountCapacity(accountId, now);
  if (!state) return { allowed: true, message: 'No such account.', retryAfterMs: null };
  const config = (await cadencesRepo.activeCadence(accountId)).capacity;
  const usage = await capacityRepo.usage(accountId, now);
  return readAllowance({
    state,
    klass,
    readsLast10Minutes: usage.readsLast10Minutes,
    readsByClass: usage.readsByClass,
    config,
    now,
    forReply: options.forReply ?? false,
  });
}

/** Whether a public action of this class may start now. */
export async function checkWriteCapacity(
  accountId: string,
  klass: CapacityClass,
  now = new Date(),
): Promise<CapacityVerdict> {
  const state = await settleAccountCapacity(accountId, now);
  if (!state) return { allowed: true, message: 'No such account.', retryAfterMs: null };
  return writeAllowance(state, klass, now);
}

/**
 * Counts one read against the account. Never fails the caller: a meter that
 * cannot be written loses a tick, and a read that fails for that loses a reply.
 */
export async function noteXRead(accountId: string, klass: CapacityClass): Promise<void> {
  await capacityRepo.recordRead(accountId, klass).catch((error) => {
    log.warn('could not count an x read', { accountId, message: errorMessage(error) });
  });
}

/**
 * Records what a failed read said, if it was pushback, and moves the breaker.
 *
 * Returns the signal it recognised so the caller can say so. Anything that is
 * not pushback is left alone: a protected account does not make X any busier.
 */
export async function noteXFailure(
  accountId: string,
  klass: CapacityClass,
  message: string | null | undefined,
): Promise<XSignal | null> {
  const signal = classifyXSignal(message);
  if (!signal) return null;
  try {
    await capacityRepo.recordSignal(accountId, klass, signal, message ?? signal);
    await settleAccountCapacity(accountId);
  } catch (error) {
    log.warn('could not record x pushback', { accountId, signal, message: errorMessage(error) });
  }
  return signal;
}

/**
 * What an owner reads about one account's X budget.
 *
 * Reads the breaker as stored and never moves it. A status screen that
 * changed the thing it describes would be a screen that alters the system by
 * being looked at; the radar settles the breaker every few seconds anyway.
 */
export async function describeCapacity(accountId: string, now = new Date()) {
  const loaded = await loadState(accountId);
  const account = await accountsRepo.getAccount(accountId);
  if (!loaded || !account) return null;
  const state = loaded.state;
  const config = (await cadencesRepo.activeCadence(accountId)).capacity;
  const usage = await capacityRepo.usage(accountId, new Date(now.getTime() - 60 * 60_000));
  const signals = await capacityRepo.recentSignals(accountId, 5);
  return {
    health: state.health,
    reason: state.reason,
    until: state.until?.toISOString() ?? null,
    strikes: state.strikes,
    readsLast10Minutes: usage.readsLast10Minutes,
    readsByClass: usage.readsByClass,
    budgetPer10Minutes: config.readsPer10Minutes,
    pushbackLastHour: { rateLimited: usage.rateLimits, stalled: usage.stalled, broken: usage.broken },
    recentSignals: signals,
  };
}
