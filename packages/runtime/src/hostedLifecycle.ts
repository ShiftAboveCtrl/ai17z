import { runtimeMayAct, type RuntimeState } from '@xbam/shared/contracts';

/**
 * What happens to a hosted agent when the subscription lapses.
 *
 * The product decision underneath this file: a hosted agent is somebody's
 * durable thing, so an expiry stops it acting and does not destroy it. The
 * worst possible behaviour would be to delete a year of memories because a
 * card expired, and the second worst would be to keep spending the owner's
 * model budget on an agent they stopped paying for.
 *
 * So the lifecycle is: still working, still working but late, stopped but
 * intact, stopped and parked, scheduled for deletion, gone. Each boundary is a
 * number somebody in the business sets rather than a constant in the code,
 * because none of those durations is an engineering fact. The defaults below
 * exist so the system has behaviour before that conversation happens, and they
 * are deliberately generous: erring towards keeping an agent costs storage,
 * and erring the other way costs somebody their agent.
 */

export interface LifecyclePolicy {
  /** How long a lapsed runtime keeps working. */
  graceDays: number;
  /** How long after that it stays suspended before being parked. */
  suspendedDays: number;
  /** How long a parked runtime is kept before deletion is scheduled. */
  retainedDays: number;
  /** Warning before deletion actually happens. */
  deletionNoticeDays: number;
}

/**
 * Defaults, not policy.
 *
 * Every one of these is a business decision this code has no authority to
 * make, so they live in one place that is obviously configuration and are
 * generous in the direction that does not lose somebody's work.
 */
export const DEFAULT_LIFECYCLE: LifecyclePolicy = {
  graceDays: 7,
  suspendedDays: 30,
  retainedDays: 60,
  deletionNoticeDays: 14,
};

export interface LifecycleView {
  state: RuntimeState;
  entitledUntil: string | null;
  /** When the current state was entered, for working out what is next. */
  since: string;
}

export type LifecycleAction =
  | { action: 'NONE'; detail: string }
  | { action: 'TO_GRACE'; detail: string }
  | { action: 'TO_SUSPENDED'; detail: string }
  | { action: 'TO_RETAINED'; detail: string }
  | { action: 'SCHEDULE_DELETION'; deleteAfter: string; detail: string }
  | { action: 'TO_ACTIVE'; detail: string };

const DAY_MS = 86_400_000;
const daysSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY_MS;

/**
 * What should happen to this runtime now.
 *
 * A pure function of the row, the policy and the clock, so a sweep can be
 * tested without waiting a month and an owner can be shown what is coming
 * before it happens.
 *
 * Deliberately never returns a deletion. The furthest it goes is scheduling
 * one, because the act of destroying somebody's agent should require a
 * separate, later, deliberate step that a person can still stop.
 */
export function lifecycleAction(view: LifecycleView, policy: LifecyclePolicy = DEFAULT_LIFECYCLE, now: Date = new Date()): LifecycleAction {
  /*
    Three answers, not two. An expiry in the future is entitled; one in the
    past has lapsed; and no expiry at all is unrecorded, which is neither.
    Reading the third as a lapse made a runtime nobody had written an expiry
    for march to a scheduled deletion in about three months, and an
    operator-created runtime has no expiry.
  */
  const expiry = view.entitledUntil === null ? null : Date.parse(view.entitledUntil);
  const unrecorded = expiry === null || !Number.isFinite(expiry);
  const entitled = !unrecorded && (expiry as number) > now.getTime();

  if (unrecorded) {
    return {
      action: 'NONE',
      detail:
        view.entitledUntil === null
          ? 'No entitlement is recorded for this runtime, so nothing is due. An absent expiry is not an expired one.'
          : `The recorded entitlement (${view.entitledUntil}) is not a date anything can read, so nothing is due.`,
    };
  }

  // Paying again brings an agent straight back, from anywhere it has not been
  // deleted. That is the whole reason state is kept.
  if (entitled && view.state !== 'ACTIVE' && view.state !== 'DELETED' && view.state !== 'DELETION_SCHEDULED') {
    return { action: 'TO_ACTIVE', detail: 'The entitlement is in force again.' };
  }
  if (entitled && view.state === 'DELETION_SCHEDULED') {
    // Renewing while deletion is pending cancels it. Somebody came back.
    return { action: 'TO_ACTIVE', detail: 'Renewed before deletion. The agent is restored rather than removed.' };
  }

  switch (view.state) {
    case 'ACTIVE':
      if (!entitled) {
        return { action: 'TO_GRACE', detail: `The entitlement lapsed. ${policy.graceDays} days of grace.` };
      }
      return { action: 'NONE', detail: 'Entitled and running.' };

    case 'GRACE':
      if (daysSince(view.since, now) >= policy.graceDays) {
        return {
          action: 'TO_SUSPENDED',
          detail: 'Grace is over. The agent stops acting and keeps everything it knows.',
        };
      }
      return { action: 'NONE', detail: 'In grace. Still working.' };

    case 'SUSPENDED':
      if (daysSince(view.since, now) >= policy.suspendedDays) {
        return { action: 'TO_RETAINED', detail: 'Parked. Still exportable, no longer provisioned.' };
      }
      return { action: 'NONE', detail: 'Suspended. Nothing is running and nothing is lost.' };

    case 'RETAINED':
      if (daysSince(view.since, now) >= policy.retainedDays) {
        const deleteAfter = new Date(now.getTime() + policy.deletionNoticeDays * DAY_MS).toISOString();
        return {
          action: 'SCHEDULE_DELETION',
          deleteAfter,
          detail: `Deletion scheduled for ${deleteAfter}, which an owner can still stop.`,
        };
      }
      return { action: 'NONE', detail: 'Retained. Export is still available.' };

    default:
      return { action: 'NONE', detail: `Nothing is due for a runtime that is ${view.state}.` };
  }
}

/**
 * What a runtime in this state is allowed to spend.
 *
 * One function, because "suspended" has to mean the same thing to the model
 * gateway, the browser, the trading engine and the scheduler. Four separate
 * opinions about it is how an agent that is supposed to be stopped keeps
 * quietly costing somebody money.
 */
export interface SpendPermission {
  autonomousActions: boolean;
  browserWork: boolean;
  trading: boolean;
  modelSpend: boolean;
  /** An owner reaching in to look, export or delete. Allowed far longer. */
  ownerAccess: boolean;
}

export function spendPermissionFor(state: RuntimeState): SpendPermission {
  const acting = runtimeMayAct(state);
  return {
    autonomousActions: acting,
    browserWork: acting,
    trading: acting,
    modelSpend: acting,
    // Reaching your own agent to get it out survives everything but deletion.
    ownerAccess: state !== 'DELETED',
  };
}

/**
 * What an owner can do from here, as a product answer rather than a state name.
 *
 * Shown to a person, so it says what is possible instead of listing which
 * enum value they are in.
 */
export function ownerOptionsFor(state: RuntimeState): readonly string[] {
  if (state === 'DELETED') return [];
  const options = ['Export or move this agent', 'Delete this agent'];
  if (state !== 'ACTIVE') options.unshift('Renew to start it working again');
  if (state === 'ACTIVE' || state === 'GRACE') options.unshift('Pause this agent');
  return options;
}
