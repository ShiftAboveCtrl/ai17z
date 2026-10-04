import { runtimeMayAct, type RuntimeState } from '@xbam/shared';

/**
 * What somebody is entitled to run, and what happens when that lapses.
 *
 * This is the core's half of hosted capacity, not a shop. Nothing here takes a
 * payment, prices anything, or talks to a payment provider: paying is the
 * owner's act, exactly as it is for a marketplace Plugin, and the one thing
 * this file decides is whether a runtime may be provisioned or may keep
 * acting. A website that sells capacity reads these answers; it does not
 * replace them.
 *
 * The property worth defending is that an entitlement bounds provisioning
 * **before** a runtime exists, rather than being reconciled afterwards. A
 * reconciliation that finds an extra runtime has already given somebody a
 * machine, and taking it back is the conversation nobody wants to have: either
 * a customer loses an agent they were using or the business absorbs capacity
 * it never sold. Refusing to start the eleventh runtime is a sentence on a
 * screen.
 *
 * And a lapse is never a deletion. `hostedLifecycle.ts` holds that, and this
 * file defers to it rather than reimplementing it, because two answers to
 * "what happens when somebody stops paying" is the one disagreement a customer
 * would discover by losing something.
 */

// ---------------------------------------------------------------------------
// An entitlement
// ---------------------------------------------------------------------------

export interface CapacityEntitlement {
  tenantId: string;
  /** The runtime class this covers. An entitlement is per class, not generic. */
  runtimeClassId: string;
  /** How many runtimes of that class may exist at once. */
  runtimes: number;
  /** Whether those runtimes may drive a browser, which costs a browser slot. */
  browser: boolean;
  /** When it stops covering anything. ISO. */
  coversUntil: string;
  /**
   * Where this entitlement came from, for the audit record.
   *
   * `OPERATOR_GRANT` is a human deciding, which is how every tenant that
   * exists today would be created. `SIGNED_LEASE` is a lease verified against
   * keys pinned at link time, which is the mechanism the Studio link already
   * uses for marketplace Plugins and is reused rather than reinvented.
   */
  source: 'OPERATOR_GRANT' | 'SIGNED_LEASE';
}

export interface TenantUsage {
  /** Runtimes that exist, whatever state they are in. */
  runtimes: readonly { runtimeClassId: string; state: RuntimeState; browser: boolean }[];
}

// ---------------------------------------------------------------------------
// Whether another one may be started
// ---------------------------------------------------------------------------

export type ProvisionVerdict = { allowed: true } | { allowed: false; why: string };

/**
 * Whether one more runtime may be provisioned.
 *
 * Counts runtimes whose state is kept rather than runtimes that are acting.
 * A suspended runtime still occupies the entitlement it was created under,
 * because it still has a database, a disk, a key and a backup, and counting
 * only the acting ones would let somebody hold ten suspended agents on an
 * entitlement for one.
 */
export function mayProvisionAnother(
  entitlement: CapacityEntitlement,
  usage: TenantUsage,
  now: Date = new Date(),
): ProvisionVerdict {
  const expiry = Date.parse(entitlement.coversUntil);
  if (!Number.isFinite(expiry)) {
    return { allowed: false, why: 'This entitlement has no readable expiry, and an unreadable one covers nothing.' };
  }
  if (expiry <= now.getTime()) {
    return {
      allowed: false,
      why: 'This entitlement has lapsed. Existing runtimes keep their state; a new one is not started on a lapsed entitlement.',
    };
  }
  if (entitlement.runtimes < 1) {
    return { allowed: false, why: 'This entitlement covers no runtimes.' };
  }

  const existing = usage.runtimes.filter(
    (r) => r.runtimeClassId === entitlement.runtimeClassId && r.state !== 'DELETED',
  );
  if (existing.length >= entitlement.runtimes) {
    return {
      allowed: false,
      why: `This entitlement covers ${entitlement.runtimes} runtime${entitlement.runtimes === 1 ? '' : 's'} of ${entitlement.runtimeClassId} and ${existing.length} already exist, counting suspended and retained ones, which still hold a database, a disk and a key.`,
    };
  }

  return { allowed: true };
}

/**
 * Whether a runtime may drive a browser under this entitlement.
 *
 * Asked separately because a browser slot is the scarcest thing on a hosted
 * machine: Chrome's renderers are the largest process on it, which is why
 * AI17Z already bounds their lifetime locally. An entitlement that does not
 * cover a browser is not a broken entitlement, it is a text-only agent.
 */
export function mayUseBrowser(entitlement: CapacityEntitlement): ProvisionVerdict {
  return entitlement.browser
    ? { allowed: true }
    : { allowed: false, why: 'This entitlement does not cover a browser, so this runtime runs without one.' };
}

// ---------------------------------------------------------------------------
// Changing one
// ---------------------------------------------------------------------------

export type ChangeVerdict =
  | { kind: 'WIDENED'; takesEffect: 'IMMEDIATELY' }
  | { kind: 'NARROWED'; takesEffect: 'AT_RENEWAL'; overBy: number; why: string }
  | { kind: 'UNCHANGED' };

/**
 * What happens when an entitlement changes.
 *
 * Widening takes effect at once, because somebody who just bought more
 * capacity should be able to use it. Narrowing does not, and that asymmetry is
 * the point: applying a reduction immediately would mean choosing which of
 * somebody's existing agents to stop, and nothing should make that choice. The
 * reduction takes effect at renewal, by which time the owner has decided which
 * one to export or delete.
 */
export function entitlementChange(
  previous: CapacityEntitlement,
  next: CapacityEntitlement,
  usage: TenantUsage,
): ChangeVerdict {
  if (next.runtimes > previous.runtimes) return { kind: 'WIDENED', takesEffect: 'IMMEDIATELY' };
  if (next.runtimes === previous.runtimes) return { kind: 'UNCHANGED' };

  const existing = usage.runtimes.filter(
    (r) => r.runtimeClassId === next.runtimeClassId && r.state !== 'DELETED',
  ).length;
  const overBy = Math.max(0, existing - next.runtimes);
  return {
    kind: 'NARROWED',
    takesEffect: 'AT_RENEWAL',
    overBy,
    why:
      overBy > 0
        ? `${overBy} runtime${overBy === 1 ? '' : 's'} more than the new entitlement covers already exist. Nothing is stopped: the reduction applies at renewal, and the owner chooses which to export or delete.`
        : 'Nothing exists above the new entitlement, so the reduction changes nothing in practice.',
  };
}

// ---------------------------------------------------------------------------
// What a lapse does, and what it does not
// ---------------------------------------------------------------------------

export type LapseEffect = { stopsActing: boolean; deletesAnything: false; why: string };

/**
 * What a lapsed entitlement does to a runtime that already exists.
 *
 * `deletesAnything` is typed as the literal `false`, so a future change that
 * wanted a lapse to delete something would not typecheck. That is deliberate:
 * the state machine in `hostedLifecycle.ts` already refuses to return a
 * deletion, and this is the same refusal expressed where somebody
 * implementing billing would be reading.
 */
export function lapseEffect(state: RuntimeState): LapseEffect {
  if (!runtimeMayAct(state)) {
    return {
      stopsActing: true,
      deletesAnything: false,
      why: 'This runtime had already stopped acting. Its state is kept and the owner can still export it.',
    };
  }
  return {
    stopsActing: true,
    deletesAnything: false,
    why: 'The runtime stops acting after its grace window. Its database, memories, keys and backups are kept, and the owner can export or renew.',
  };
}

/**
 * Whether a tenant is over the capacity they are entitled to.
 *
 * Reported rather than enforced, because every way of enforcing it is a
 * choice about which of somebody's agents to stop. An operator reads this and
 * talks to a customer.
 */
export function overCapacity(
  entitlements: readonly CapacityEntitlement[],
  usage: TenantUsage,
): readonly { runtimeClassId: string; entitled: number; existing: number }[] {
  const entitled = new Map<string, number>();
  for (const e of entitlements) {
    entitled.set(e.runtimeClassId, (entitled.get(e.runtimeClassId) ?? 0) + e.runtimes);
  }
  const existing = new Map<string, number>();
  for (const r of usage.runtimes) {
    if (r.state === 'DELETED') continue;
    existing.set(r.runtimeClassId, (existing.get(r.runtimeClassId) ?? 0) + 1);
  }

  const out: { runtimeClassId: string; entitled: number; existing: number }[] = [];
  for (const [runtimeClassId, count] of existing) {
    const allowed = entitled.get(runtimeClassId) ?? 0;
    if (count > allowed) out.push({ runtimeClassId, entitled: allowed, existing: count });
  }
  return out.sort((a, b) => a.runtimeClassId.localeCompare(b.runtimeClassId));
}

export const CAPACITY_CAVEATS: readonly string[] = [
  'Nothing here takes a payment, prices anything or talks to a payment provider. Paying is the owner act, and this file only decides whether a runtime may start or keep acting.',
  'A lapse never deletes anything. hostedLifecycle.ts holds that, and this file defers to it rather than answering the same question a second way.',
  'Being over capacity is reported, not enforced. Every way of enforcing it is a choice about which of somebody agents to stop, and nothing should make that choice on its own.',
  'A suspended runtime still occupies its entitlement, because it still holds a database, a disk, a key and a backup.',
  'No capacity has been sold and no entitlement has been issued from this repository.',
];
