/**
 * Getting an owner notification out of the building.
 *
 * The notification system already decides *whether* to tell somebody: it
 * raises a condition, dedupes it against a partial unique index, tracks
 * severity, honours a mute, and clears itself when the problem goes away. None
 * of that changes here. This is only the last step -- taking something that has
 * already survived those decisions and delivering it.
 *
 * The shape matters more than the transport:
 *
 *     runtime condition
 *       -> OwnerNotification          (does this deserve a person's attention?)
 *       -> dedupe, severity, mute     (has it already been said?)
 *       -> transports                 (this file: say it)
 *
 * The alternative -- Chrome code calling Telegram, the poller calling Telegram,
 * the provider adapter calling Telegram -- produces a system where nobody can
 * answer "why did I get eleven messages about one broken browser", because the
 * answer is spread across eleven files. Everything goes through the raise, and
 * a transport only ever sees what the raise decided was worth saying.
 *
 * Three properties every transport must have:
 *
 *   - **Failing is not an error anybody else hears about.** A notification is a
 *     courtesy. If Telegram is down, the agent whose job raised the condition
 *     carries on, and the failure is recorded where a person can see it.
 *   - **It never runs inside the raising path.** Delivery is a separate sweep,
 *     so a slow HTTPS call cannot hold a pipeline step open.
 *   - **It says nothing twice.** Delivery is recorded against the notification,
 *     so a transport added later does not replay a week of history.
 */
import { createLogger, errorMessage } from '@xbam/shared';
import { notifications as notificationsRepo, ops as opsRepo } from '@xbam/database';
import type { NotificationRecord } from '@xbam/database';

const log = createLogger('notify-transport');

/** What a transport is asked to do. Deliberately small. */
export interface NotificationTransport {
  /** Stable name, used in settings, health and the delivery record. */
  readonly name: string;
  /** Whether the owner has configured it. An unconfigured transport is skipped silently. */
  isConfigured(): Promise<boolean>;
  /** Whether this particular notification should go out on this transport. */
  wants(notification: NotificationRecord): Promise<boolean>;
  /** Deliver it. Throwing is fine and is recorded; it must not be swallowed here. */
  deliver(notification: NotificationRecord): Promise<void>;
}

const transports: NotificationTransport[] = [];

/**
 * Registers a transport.
 *
 * Called once at startup rather than discovered, so the set of things that can
 * message the owner is a list somebody can read.
 */
export function registerTransport(transport: NotificationTransport): void {
  if (transports.some((existing) => existing.name === transport.name)) return;
  transports.push(transport);
}

export function registeredTransports(): readonly NotificationTransport[] {
  return transports;
}

/** For tests, which must not inherit whatever a previous file registered. */
export function clearTransports(): void {
  transports.length = 0;
}

/** Where the record of what has been delivered lives. */
const DELIVERY_KEY = (transport: string) => `notifications.delivered.${transport}`;

interface DeliveryState {
  /** Notification ids already sent, most recent last. */
  sent: string[];
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

const EMPTY: DeliveryState = { sent: [], lastOkAt: null, lastErrorAt: null, lastError: null };

/**
 * How many delivered ids to remember.
 *
 * Enough that a transport cannot replay anything a person still remembers
 * receiving, small enough that the row stays a row. Older ids fall off; a
 * notification that old has been acknowledged or resolved long since, and the
 * unique index stops it being raised again anyway.
 */
const REMEMBER = 500;

export async function deliveryState(transport: string): Promise<DeliveryState> {
  return (await opsRepo.getSetting<DeliveryState>(DELIVERY_KEY(transport))) ?? EMPTY;
}

/**
 * Delivers anything open that has not been sent yet.
 *
 * Called from the worker sweep beside the notification sweep, never from the
 * code that raises one. Returns what happened, so a caller can log it and a
 * test can assert on it.
 */
export async function deliverNotifications(): Promise<{ delivered: number; failed: number; skipped: number }> {
  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  if (transports.length === 0) return { delivered, failed, skipped };

  const open = await notificationsRepo.listOpen({ limit: 50 });
  if (open.length === 0) return { delivered, failed, skipped };

  for (const transport of transports) {
    let configured: boolean;
    try {
      configured = await transport.isConfigured();
    } catch (error) {
      // A transport that cannot even answer whether it is configured is not a
      // reason to stop delivering on the others.
      log.warn('a transport could not report whether it is configured', {
        transport: transport.name,
        message: errorMessage(error),
      });
      continue;
    }
    if (!configured) continue;

    const state = await deliveryState(transport.name);
    const sent = new Set(state.sent);
    let changed = false;
    let lastOkAt = state.lastOkAt;
    let lastErrorAt = state.lastErrorAt;
    let lastError = state.lastError;

    for (const notification of open) {
      if (sent.has(notification.id)) continue;

      let wanted: boolean;
      try {
        wanted = await transport.wants(notification);
      } catch (error) {
        log.warn('a transport could not decide whether it wanted a notification', {
          transport: transport.name,
          message: errorMessage(error),
        });
        continue;
      }

      if (!wanted) {
        // Recorded as sent even though nothing was sent. Otherwise turning a
        // category on would deliver every old notification it had declined,
        // which is the worst possible first impression of a new setting.
        sent.add(notification.id);
        changed = true;
        skipped += 1;
        continue;
      }

      try {
        await transport.deliver(notification);
        sent.add(notification.id);
        changed = true;
        delivered += 1;
        lastOkAt = new Date().toISOString();
        lastError = null;
      } catch (error) {
        failed += 1;
        lastErrorAt = new Date().toISOString();
        lastError = errorMessage(error).slice(0, 300);
        // Not marked sent, so it goes again next sweep. A transient outage
        // delays a notification rather than losing it.
        log.warn('a notification could not be delivered', {
          transport: transport.name,
          notification: notification.kind,
          message: lastError,
        });
        // Stop trying this transport this round. If it is rate limiting or
        // down, the next forty attempts will fail the same way.
        break;
      }
    }

    if (changed || lastError !== state.lastError) {
      await opsRepo.setSetting(DELIVERY_KEY(transport.name), {
        sent: [...sent].slice(-REMEMBER),
        lastOkAt,
        lastErrorAt,
        lastError,
      });
    }
  }

  return { delivered, failed, skipped };
}

/**
 * Marks everything currently open as already delivered, without sending it.
 *
 * Used the moment a transport is connected. Somebody who has just pasted a bot
 * token does not want the last fortnight of notifications arriving at once, and
 * a first impression of forty messages is how a transport gets disconnected
 * again immediately.
 */
export async function markCaughtUp(transport: string): Promise<number> {
  const open = await notificationsRepo.listOpen({ limit: 500 });
  const state = await deliveryState(transport);
  const sent = new Set([...state.sent, ...open.map((row) => row.id)]);
  await opsRepo.setSetting(DELIVERY_KEY(transport), {
    ...state,
    sent: [...sent].slice(-REMEMBER),
  });
  return open.length;
}
