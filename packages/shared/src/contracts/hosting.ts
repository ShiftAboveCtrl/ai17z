import { z } from 'zod';

/**
 * Running AI17Z somewhere the owner does not control.
 *
 * There is one AI17Z. Hosted mode is this vocabulary plus a runtime that is
 * placed, bounded and reachable through an authorised gateway; it is not a
 * second product, a second memory system or a cloud fork. Local mode is the
 * default and nothing here is required to run AI17Z on your own machine.
 *
 * The decisions encoded below come from the hosted threat model, and two of
 * them are worth restating where somebody will read them:
 *
 * A container is not the boundary between two customers. Firecracker's own
 * design document says the first layer of isolation is KVM and that it can
 * run workloads from different customers on one machine, and it says equally
 * plainly that it does not filter guest network traffic. So the boundary is a
 * guest with its own kernel, and egress filtering is work AI17Z owes rather
 * than something it inherits.
 *
 * And only one provider tier may hold secrets today. Confidential compute is
 * the only thing that genuinely reduces what a host operator can read, and it
 * requires verified attestation with debug refused and key release conditioned
 * on a measurement. Until that exists and is exercised, hosting is first-party
 * hardware and is never described as host-blind.
 */

// ---------------------------------------------------------------------------
// Who may hold a tenant
// ---------------------------------------------------------------------------

/**
 * How much a provider's hardware is trusted with, in order.
 *
 * `FIRST_PARTY_TRUSTED` is hardware the operator controls. It is the only tier
 * that may hold a secret-bearing tenant, and that is a statement about what
 * has been proved rather than about ambition.
 *
 * `VERIFIED_PROVIDER` is a known operator under agreement, without attested
 * key release. `CONFIDENTIAL_COMPUTE` is a measured guest whose master key is
 * released only against an attestation report that matches a published image
 * and refuses a policy permitting debug. Both are designed and neither is
 * enabled: `PROVIDER_TIERS_ENABLED` is the list that may actually be
 * scheduled onto, and it has one entry.
 */
export const PROVIDER_TIERS = ['FIRST_PARTY_TRUSTED', 'VERIFIED_PROVIDER', 'CONFIDENTIAL_COMPUTE'] as const;
export const ProviderTier = z.enum(PROVIDER_TIERS);
export type ProviderTier = (typeof PROVIDER_TIERS)[number];

/**
 * The tiers a tenant may actually be placed on.
 *
 * Deliberately not derived from `PROVIDER_TIERS`, so adding a tier to the
 * vocabulary does not quietly enable scheduling onto it. Widening this list is
 * a decision somebody has to make on purpose, and
 * `tests/unit/hostingTrust.test.ts` fails if it is widened without the
 * attestation requirements being met.
 */
export const PROVIDER_TIERS_ENABLED: readonly ProviderTier[] = ['FIRST_PARTY_TRUSTED'];

export function tierMayHoldTenants(tier: ProviderTier): boolean {
  return PROVIDER_TIERS_ENABLED.includes(tier);
}

/**
 * What a tier would have to prove before it may hold a tenant.
 *
 * Kept as data rather than prose so the readiness screen and the scheduler
 * answer from the same place, and so "why can I not use my own machine yet"
 * has a specific answer.
 */
export const TIER_REQUIREMENTS: Record<ProviderTier, readonly string[]> = {
  FIRST_PARTY_TRUSTED: [],
  VERIFIED_PROVIDER: [
    'A named operator under agreement, with an audited access policy.',
    'Host identity enrolled by an administrator rather than self-asserted.',
  ],
  CONFIDENTIAL_COMPUTE: [
    'An attestation report verified against the hardware vendor root of trust.',
    'A launch measurement matching an image AI17Z published and can reproduce.',
    'A guest policy that forbids debug, refused otherwise.',
    'Runtime master key released only against a report that passed all of the above.',
    'A defined firmware and TCB update policy, with rollback refused and revocation possible.',
  ],
};

// ---------------------------------------------------------------------------
// Host nodes
// ---------------------------------------------------------------------------

/**
 * A machine that can hold tenant runtimes.
 *
 * A host connects outward to the control plane and exposes no inbound
 * management port, so nothing here records a public address to dial. Identity
 * is an asymmetric key the host proves it holds; there is no shared bearer
 * secret deployed to every node, because one leaked copy of that is every
 * node.
 */
export const HOST_STATES = [
  /** Key submitted, not yet approved by an administrator. */
  'PENDING_ENROLMENT',
  'ACTIVE',
  /** Finishing what it holds, accepting nothing new. */
  'DRAINING',
  /** Heartbeats stopped. Its runtimes are unavailable, not reassigned. */
  'UNREACHABLE',
  /** Key refused from now on. Cannot be undone by the host. */
  'REVOKED',
] as const;
export const HostState = z.enum(HOST_STATES);
export type HostState = (typeof HOST_STATES)[number];

/** States in which a host may be given new work. */
export const HOST_SCHEDULABLE_STATES: readonly HostState[] = ['ACTIVE'];

/**
 * What a host says it has.
 *
 * Every number is something measured on the machine, not a plan. A browser
 * slot is counted separately from a plain runtime slot because a tenant
 * driving real Chrome is not comparable to a text-only agent: Chrome's
 * renderers are the largest thing on a hosted machine, which is why AI17Z
 * already bounds their lifetime locally.
 */
export const HostCapacity = z
  .object({
    cpuCores: z.number().int().min(1).max(4096),
    memoryMb: z.number().int().min(512).max(64 * 1024 * 1024),
    diskGb: z.number().int().min(1).max(1024 * 1024),
    /** Runtimes this host may hold at once, browser-capable or not. */
    runtimeSlots: z.number().int().min(0).max(10_000),
    /** Of those, how many may drive a browser. */
    browserSlots: z.number().int().min(0).max(10_000),
    gpus: z.number().int().min(0).max(64).default(0),
    /** Where it is, for stable placement. Opaque to a tenant. */
    region: z.string().trim().min(1).max(64),
    /** Runtime image versions this host can run. */
    runtimeVersions: z.array(z.string().trim().min(1).max(64)).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.browserSlots > c.runtimeSlots) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A host cannot hold more browser runtimes than runtimes.',
        path: ['browserSlots'],
      });
    }
  });
export type HostCapacity = z.infer<typeof HostCapacity>;

// ---------------------------------------------------------------------------
// Runtime classes
// ---------------------------------------------------------------------------

/**
 * What one tenant runtime reserves.
 *
 * A class is a reservation, not a limit discovered later: the scheduler
 * subtracts these from a host before anything starts, so a machine cannot be
 * promised twice. The numbers here are deliberately not marketing figures and
 * no slot count is asserted anywhere in this repository without being measured
 * on the hardware it is claimed for.
 */
export const RuntimeClass = z
  .object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(120),
    cpuCores: z.number().min(0.25).max(256),
    memoryMb: z.number().int().min(512).max(1024 * 1024),
    diskGb: z.number().int().min(1).max(65_536),
    /** Whether this class may drive a browser, which costs a browser slot. */
    browser: z.boolean(),
    /** Agents the tenant may run in it. Several agents, one owner. */
    maxAgents: z.number().int().min(1).max(1000),
  })
  .strict();
export type RuntimeClass = z.infer<typeof RuntimeClass>;

// ---------------------------------------------------------------------------
// Runtime lifecycle
// ---------------------------------------------------------------------------

/**
 * Where a tenant runtime is in its life.
 *
 * `SUSPENDED` and `RETAINED` exist so that an expiry is not a deletion. A
 * hosted agent is somebody's durable thing, and the worst possible answer to
 * a lapsed subscription is to destroy it: it stops acting, and it keeps
 * existing until the owner renews, exports or deletes it on purpose.
 */
export const RUNTIME_STATES = [
  'PROVISIONING',
  'MIGRATING',
  'READY',
  /** Running and reachable, with an entitlement in force. */
  'ACTIVE',
  /** Entitlement lapsed, still acting, inside a grace window. */
  'GRACE',
  /** Not acting at all: no autonomy, no browser, no trading, no model spend. */
  'SUSPENDED',
  /** Not running. State kept. Nothing is deleted from here without being asked. */
  'RETAINED',
  'DELETION_SCHEDULED',
  'DELETED',
  /** Its host stopped answering. Deliberately not reassigned on its own. */
  'HOST_UNREACHABLE',
  'FAILED',
] as const;
export const RuntimeState = z.enum(RUNTIME_STATES);
export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** States in which a runtime may act on its own, spend or browse. */
export const RUNTIME_ACTIVE_STATES: readonly RuntimeState[] = ['ACTIVE', 'GRACE'];

/**
 * Whether a runtime may do anything that costs money or touches the world.
 *
 * One function so a suspension cannot be enforced in four places and forgotten
 * in a fifth. Autonomy, browsing, trading and model spend are the same
 * question: is this runtime allowed to act.
 */
export function runtimeMayAct(state: RuntimeState): boolean {
  return RUNTIME_ACTIVE_STATES.includes(state);
}

/** Whether a runtime's durable state still exists and can be exported. */
export function runtimeStateKept(state: RuntimeState): boolean {
  return state !== 'DELETED';
}

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

/**
 * What a tenant guest may never reach, whatever it is browsing.
 *
 * Firecracker filters nothing, so this is AI17Z's to enforce at the host. The
 * list is infrastructure rather than content: a hosted agent researching the
 * open web is the product working, and a hosted agent reaching the cloud
 * metadata endpoint is a credential theft. Nothing here is for geography, and
 * nothing here is to be used to evade anybody's security controls.
 */
export const EGRESS_DENIED_CIDRS: readonly string[] = [
  // Cloud instance metadata, on every major provider. The single most
  // valuable address to a compromised guest.
  '169.254.169.254/32',
  // The rest of link-local, which carries more than metadata.
  '169.254.0.0/16',
  // Loopback, which from inside a guest means the guest's own services.
  '127.0.0.0/8',
  // Private ranges: the control plane, other tenants, management networks.
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // Carrier-grade NAT, which is private in practice.
  '100.64.0.0/10',
  // Unspecified and broadcast.
  '0.0.0.0/8',
  '255.255.255.255/32',
  // IPv6 equivalents, because an allowlist that forgets v6 is not one.
  '::1/128',
  'fe80::/10',
  'fc00::/7',
];

export const EgressPolicy = z
  .object({
    /** Denials are not optional and cannot be emptied by configuration. */
    deniedCidrs: z.array(z.string()).default([...EGRESS_DENIED_CIDRS]),
    /** Hosts a tenant additionally may not reach, by name. */
    deniedHosts: z.array(z.string().trim().min(1)).default([]),
    /**
     * Whether ordinary public egress is allowed. False only for a runtime
     * that has no business on the internet at all.
     */
    publicInternet: z.boolean().default(true),
  })
  .strict();
export type EgressPolicy = z.infer<typeof EgressPolicy>;
