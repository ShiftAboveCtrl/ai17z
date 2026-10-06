import { z } from 'zod';

/**
 * Hardware-backed confidential compute, in the vocabulary both providers use.
 *
 * `hosting.ts` already has a `CONFIDENTIAL_COMPUTE` provider tier that is
 * designed and refused. This is what it would take to enable it: the shapes of
 * the evidence, the policy that judges the evidence, and the facts a provider
 * has to report. Nothing here provisions anything, and
 * `docs/architecture/CONFIDENTIAL_COMPUTE.md` records which provider document
 * each field came from.
 *
 * The reason this exists separately from `hosting.ts` is the distinction the
 * owner asked for. A microVM protects a tenant from its neighbours. Only
 * confidential compute addresses the host operator, and the two guarantees must
 * not be described in one vocabulary or they get claimed as one thing.
 *
 * It is cloud-neutral because the agent architecture must not care. A provider
 * is a set of SKUs, an attestation format and a key-release mechanism; an
 * agent is identity, memory and policy, and nothing about the second should
 * mention the first.
 */

// ---------------------------------------------------------------------------
// What the hardware is
// ---------------------------------------------------------------------------

/**
 * The technologies that actually protect a guest from its host.
 *
 * Deliberately not a list of every TEE: these are the two that current cloud
 * confidential VMs are built on, and a third would arrive with its own
 * attestation format rather than fitting into one of these.
 */
export const TEE_KINDS = ['AMD_SEV_SNP', 'INTEL_TDX'] as const;
export const TeeKind = z.enum(TEE_KINDS);
export type TeeKind = (typeof TEE_KINDS)[number];

/**
 * Providers whose confidential offering has been read in current
 * documentation. Being here is not approval: `CONFIDENTIAL_PROVIDERS_ENABLED`
 * is what may hold a tenant, and it is empty.
 */
export const CONFIDENTIAL_PROVIDERS = ['AZURE', 'GOOGLE_CLOUD', 'FIRST_PARTY_HARDWARE'] as const;
export const ConfidentialProvider = z.enum(CONFIDENTIAL_PROVIDERS);
export type ConfidentialProvider = (typeof CONFIDENTIAL_PROVIDERS)[number];

/**
 * Providers a production tenant may actually be placed on.
 *
 * Empty, and written out rather than derived, for the same reason
 * `PROVIDER_TIERS_ENABLED` is: researching a provider must not enable it. It
 * becomes non-empty when a canary has verified an attestation against real
 * hardware and a key has been released to an attested runtime and to nothing
 * else.
 */
export const CONFIDENTIAL_PROVIDERS_ENABLED: readonly ConfidentialProvider[] = [];

/**
 * What each provider would still have to prove, as data rather than prose.
 *
 * The readiness screen and the scheduler answer from here, so "why can I not
 * use Azure yet" has one answer.
 */
export const CONFIDENTIAL_REQUIREMENTS: Record<ConfidentialProvider, readonly string[]> = {
  AZURE: [
    'A confidential VM provisioned on a DCas or DCes size, and its attestation report verified against the Microsoft Azure Attestation authority.',
    'A Secure Key Release policy on Key Vault Premium or Managed HSM that asserts the TEE claims, because Secure Key Release is a Key Vault feature that a non-confidential Trusted Launch VM can also satisfy.',
    'Release additionally bound to a particular AI17Z runtime measurement, which the two-claim documented example does not do: the guest measurement is in the SEV-SNP report and in measured-boot PCR values.',
    'A key released to an attested runtime, and refused to a debug-enabled one, demonstrated rather than assumed.',
  ],
  GOOGLE_CLOUD: [
    'A Confidential Space workload running on an N2D SEV-SNP or C3/C4 TDX instance, with its attestation token verified.',
    'A workload identity pool attribute condition that pins assertion.submods.container.image_digest to a published AI17Z runtime digest.',
    'The same condition refusing assertion.dbgstat of "enable", demonstrated rather than assumed.',
    'Cloud KMS or Secret Manager access gated on that pool, and a key released to the attested workload and to nothing else.',
  ],
  FIRST_PARTY_HARDWARE: [
    'SEV-SNP or TDX capable hardware under the operator control, with firmware at or above a recorded TCB floor.',
    'An attestation report verified against the hardware vendor root of trust rather than against a cloud attestation service.',
    'A key release path that does not depend on the operator being honest, which is the whole difficulty of doing this on your own metal.',
  ],
};

export function confidentialProviderMayHoldTenants(provider: ConfidentialProvider): boolean {
  return CONFIDENTIAL_PROVIDERS_ENABLED.includes(provider);
}

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

/**
 * An Azure attestation result, in the claim names the release policy uses.
 *
 * Nested under `x-ms-isolation-tee` exactly as the documented policy example
 * is, because a claim read from the wrong level is a claim about the host
 * rather than about the trusted environment, and those look identical in a
 * log.
 */
export const AzureAttestationClaims = z
  .object({
    /** The attestation authority that signed this. Pinned, never taken from the token. */
    authority: z.string().url(),
    isolationTee: z
      .object({
        /** `sevsnpvm` for a SEV-SNP confidential VM. */
        attestationType: z.string().trim().min(1),
        /** `azure-compliant-cvm` for a platform Azure attests as compliant. */
        complianceStatus: z.string().trim().min(1),
      })
      .strict(),
    /**
     * Measured-boot PCR values, where the guest measurement actually lives.
     *
     * Optional in the shape and required by policy, because the documented
     * two-claim example omits it and a policy that omits it is not bound to a
     * runtime.
     */
    attestedPcrValues: z.record(z.string()).optional(),
    /**
     * `x-ms-azurevm-vmid`: which VM this token came from.
     *
     * Optional in the shape and required by policy, for the same reason as the
     * PCR values. Without it a token from one correctly-measured runtime
     * satisfies another runtime's expectation, and a host that holds two of
     * them can put a nonce it was given to either.
     */
    vmId: z.string().trim().min(1).optional(),
    /** When the token was issued, for refusing a replayed one. */
    issuedAt: z.string().datetime(),
    nonce: z.string().trim().min(16),
  })
  .strict();
export type AzureAttestationClaims = z.infer<typeof AzureAttestationClaims>;

/**
 * A Google Confidential Space attestation token, in its own claim names.
 *
 * Every field here is one the reference documents, and the two that matter
 * most are `imageDigest` and `debugStatus`: the first is what makes release
 * conditional on an approved runtime rather than on an approved platform, and
 * the second is the one that must be refused.
 */
export const ConfidentialSpaceClaims = z
  .object({
    /** `assertion.hwmodel`: `GCP_AMD_SEV` or `INTEL_TDX`. */
    hardwareModel: z.string().trim().min(1),
    /** `assertion.submods.container.image_digest`: the workload's own digest. */
    imageDigest: z.string().trim().min(1),
    /** `assertion.swversion`: the Confidential Space image version. */
    softwareVersion: z.string().trim().min(1),
    /** `assertion.dbgstat`: `enable` or `disabled-since-boot`. */
    debugStatus: z.string().trim().min(1),
    /** `assertion.submods.gce.instance_id`. */
    instanceId: z.string().trim().min(1),
    /** `assertion.submods.confidential_space.support_attributes`. */
    supportAttributes: z.array(z.string()).default([]),
    issuedAt: z.string().datetime(),
    nonce: z.string().trim().min(16),
  })
  .strict();
export type ConfidentialSpaceClaims = z.infer<typeof ConfidentialSpaceClaims>;

/** The value `assertion.dbgstat` carries when debug is off for the whole boot. */
export const CONFIDENTIAL_SPACE_DEBUG_OFF = 'disabled-since-boot';
/** And the value that must never be accepted. */
export const CONFIDENTIAL_SPACE_DEBUG_ON = 'enable';

/** What Azure's attestation type claim says for a SEV-SNP confidential VM. */
export const AZURE_SEVSNP_ATTESTATION_TYPE = 'sevsnpvm';
/** And the compliance status Azure gives a platform it attests as compliant. */
export const AZURE_COMPLIANT_CVM = 'azure-compliant-cvm';

/** Hardware model values Confidential Space reports. */
export const CONFIDENTIAL_SPACE_HARDWARE: Record<string, TeeKind> = {
  GCP_AMD_SEV: 'AMD_SEV_SNP',
  INTEL_TDX: 'INTEL_TDX',
};

/** Either provider's evidence, tagged so nothing reads one as the other. */
export const ConfidentialEvidence = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('AZURE'), claims: AzureAttestationClaims }).strict(),
  z.object({ provider: z.literal('GOOGLE_CLOUD'), claims: ConfidentialSpaceClaims }).strict(),
]);
export type ConfidentialEvidence = z.infer<typeof ConfidentialEvidence>;

// ---------------------------------------------------------------------------
// What a provider has to be able to do
// ---------------------------------------------------------------------------

/**
 * One confidential VM size a provider offers, with its measured price.
 *
 * `pricePerHourUsd` is a figure read from a provider's own pricing interface
 * and is dated, because a price nobody can date is a price somebody remembered.
 * `confidentialPremiumPerHourUsd` is separate where a provider charges it
 * separately, which Google does and Azure does not.
 */
export const ConfidentialSku = z
  .object({
    provider: ConfidentialProvider,
    /** The provider's own name for it, verbatim: `Standard_DC2as_v5`, `n2d-standard-2`. */
    sku: z.string().trim().min(1).max(120),
    tee: TeeKind,
    vcpus: z.number().int().min(1).max(1024),
    memoryMb: z.number().int().min(512),
    /** Null where the size has no local disk, which changes what a tenant needs. */
    localDiskGb: z.number().int().min(0).nullable(),
    region: z.string().trim().min(1).max(64),
    pricePerHourUsd: z.number().min(0),
    confidentialPremiumPerHourUsd: z.number().min(0).default(0),
    /** When this price was read, and from where. */
    pricedAt: z.string().datetime(),
    priceSource: z.string().trim().min(1),
  })
  .strict();
export type ConfidentialSku = z.infer<typeof ConfidentialSku>;

/** Hours in the month this project prices against, stated once. */
export const HOURS_PER_MONTH = 730;

/** What one of these costs for a month of being switched on. */
export function monthlyComputeUsd(sku: Pick<ConfidentialSku, 'pricePerHourUsd' | 'confidentialPremiumPerHourUsd'>): number {
  return (sku.pricePerHourUsd + (sku.confidentialPremiumPerHourUsd ?? 0)) * HOURS_PER_MONTH;
}

/**
 * The smallest confidential unit that exists anywhere, measured.
 *
 * Two vCPUs: there is no one-vCPU confidential size on either provider. This
 * is the number the whole hosted economy rests on, because it cannot be
 * subdivided, and it is the strongest argument for several of one owner's
 * agents sharing one runtime rather than each getting its own.
 */
export const SMALLEST_CONFIDENTIAL_VCPUS = 2;

export const CONFIDENTIAL_CAVEATS: readonly string[] = [
  'A microVM protects a tenant from its neighbours. Only confidential compute addresses the host operator, and the two must never be described as one guarantee.',
  'Availability is not confidentiality. A host operator can always power a machine off, and nothing here claims otherwise.',
  'Secure Key Release on Azure is a Key Vault feature that a non-confidential Trusted Launch VM can also satisfy, so a release policy that does not assert the TEE claims is attestation-gated release with nothing behind it.',
  'Azure documented release policy asserts the platform is a compliant confidential VM. Binding release to a particular AI17Z runtime needs the guest measurement as well, which is in the SEV-SNP report and the measured-boot PCR values.',
  'Google Confidential Space pins the workload image digest and a debug flag as first-class claims, which is what conditions release on an approved runtime rather than an approved platform.',
  'No confidential VM has been provisioned, no attestation verified against real hardware, and no key released. CONFIDENTIAL_PROVIDERS_ENABLED is empty and that is the honest state.',
];
