/**
 * The contract a confidential host provider implements, and what it must refuse.
 *
 * `confidential.ts` says what evidence looks like and
 * `confidentialAttestation.ts` judges it. Neither of them can bring a runtime
 * into existence, and nothing here could: no confidential VM has been
 * provisioned and this repository holds no cloud credential.
 *
 * ## So what is this for
 *
 * Every operation below either **renders the request that would be sent** or
 * **refuses and names the credential it lacks**. That split is the point. An
 * adapter that can render a correct request is an adapter whose remaining work
 * is configuration, and a request that can be rendered can be read, reviewed
 * and tested by somebody who is not paying a cloud bill to find out whether it
 * was right.
 *
 * It also keeps the honest line in one place: a rendered request is
 * SOURCE-INSPECTED, never PROVEN. `provisioned: false` is on every result and
 * no caller can set it.
 *
 * ## Cloud-neutral, and the reason
 *
 * `hostScheduler.ts` contains no provider name and must not acquire one. The
 * provider is chosen by evidence (`CONFIDENTIAL_REQUIREMENTS`, the cost
 * ledger, the attestation claims each one actually asserts), and a scheduler
 * that knew which cloud it was on would make that choice unfalsifiable.
 *
 * ## What an adapter may never do
 *
 * It may not hold a tenant's master key, see tenant plaintext, or report an
 * attestation it did not verify through `judgeConfidentialEvidence`. The key
 * travels from a release service to an attested guest; a control plane that
 * handled it on the way has held it, which is the one thing the design forbids.
 */
import {
  CONFIDENTIAL_PROVIDERS_ENABLED,
  type ConfidentialEvidence,
  type ConfidentialProvider,
  type ConfidentialSku,
  type TeeKind,
} from '@xbam/shared/contracts';

import { judgeConfidentialEvidence, type ConfidentialVerdict } from './confidentialAttestation';
import { CONFIDENTIAL_SKUS } from './confidentialSkus';

// ---------------------------------------------------------------------------
// What an adapter needs before it can do anything
// ---------------------------------------------------------------------------

/** One thing an adapter cannot proceed without, named so somebody can supply it. */
export interface MissingCredential {
  /** The provider's own name for it, so a search finds the right documentation. */
  name: string;
  /** Where it comes from, in a sentence. */
  how: string;
}

export type ProviderReadiness =
  | { ready: true; detail: string }
  | {
      ready: false;
      /** Named rather than counted: "needs credentials" is not actionable. */
      missing: readonly MissingCredential[];
      detail: string;
    };

// ---------------------------------------------------------------------------
// What a runtime request is
// ---------------------------------------------------------------------------

export interface RuntimeRequest {
  /** Opaque to the tenant and used as the resource name. */
  runtimeId: string;
  /** The tenant this runtime belongs to. One tenant per runtime, always. */
  tenantId: string;
  sku: ConfidentialSku;
  /** Where the provider should put it. A region the SKU was not priced in is refused. */
  region: string;
  /** The approved runtime image, by its measurement rather than by a tag. */
  imageMeasurement: string;
  /** The disk the tenant's state lives on, in GB. */
  dataDiskGb: number;
  /**
   * Which deployment generation this runtime belongs to.
   *
   * Carried into the key release policy, so a runtime from an older generation
   * cannot unseal a newer tenant's state: see `stateGeneration.ts`.
   */
  generation: number;
}

/** A request an adapter would send, rendered so it can be read instead of paid for. */
export interface RenderedRequest {
  provider: ConfidentialProvider;
  /** The provider's own operation, verbatim, so documentation can be found. */
  operation: string;
  /** HTTP method and path or resource id, as the provider's API defines it. */
  method: 'PUT' | 'POST' | 'GET' | 'DELETE' | 'PATCH';
  path: string;
  /** The body, in the provider's own schema. */
  body: Record<string, unknown>;
  /** Always false here. Rendering is not provisioning. */
  provisioned: false;
  /** What the owner would be charged a month if this ran. */
  monthlyUsd: number;
  /** The security properties this request asserts, for review. */
  asserts: readonly string[];
}

export type ProvisionOutcome =
  | { rendered: true; request: RenderedRequest }
  | { rendered: false; why: string; missing: readonly MissingCredential[] };

// ---------------------------------------------------------------------------
// Key release
// ---------------------------------------------------------------------------

export interface KeyReleaseRequest {
  runtimeId: string;
  tenantId: string;
  /** The measurement the policy will insist on. */
  imageMeasurement: string;
  generation: number;
  /** The TEE the policy will insist on. Never left to the provider's default. */
  tee: TeeKind;
}

/** A release policy, rendered in the provider's own schema. */
export interface RenderedPolicy {
  provider: ConfidentialProvider;
  /** The provider's own name for the thing this policy attaches to. */
  attachesTo: string;
  policy: Record<string, unknown>;
  /**
   * Whether this policy binds the **runtime** or only the **platform**.
   *
   * The distinction the whole provider comparison turns on. A policy that
   * asserts a compliant confidential platform and nothing about which image
   * booted is a real claim and not the claim this product needs.
   */
  binds: 'PLATFORM_ONLY' | 'PLATFORM_AND_RUNTIME';
  /** What it refuses, in sentences, for review by somebody who is not reading JSON. */
  refuses: readonly string[];
}

export type PolicyOutcome =
  | { rendered: true; policy: RenderedPolicy }
  | { rendered: false; why: string; missing: readonly MissingCredential[] };

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** An operation that needs a live provider, which nothing here has. */
export type LiveOperation =
  | 'START'
  | 'STOP'
  | 'DELETE'
  | 'SNAPSHOT'
  | 'RESTORE'
  | 'HEALTH'
  | 'USAGE'
  | 'FETCH_ATTESTATION';

export type LiveOutcome = {
  /** Always false. There is no credential here and no adapter may pretend otherwise. */
  executed: false;
  operation: LiveOperation;
  /** The call that would be made, so the remaining work is visibly configuration. */
  would: { method: string; path: string };
  why: string;
};

export interface ConfidentialProviderAdapter {
  readonly provider: ConfidentialProvider;
  /** This adapter's own version, so a rendered request can be traced to the code that made it. */
  readonly version: string;

  /** Whether this adapter could act, and what it is missing if not. */
  readiness(): ProviderReadiness;

  /** The sizes it offers, from the priced list rather than from a live call. */
  skus(): readonly ConfidentialSku[];

  /** The request that would create a runtime. */
  renderProvision(request: RuntimeRequest): ProvisionOutcome;

  /** The policy that would gate this tenant's key release. */
  renderKeyReleasePolicy(request: KeyReleaseRequest): PolicyOutcome;

  /** Turn this provider's own attestation document into evidence AI17Z can judge. */
  evidenceFrom(raw: unknown): { parsed: true; evidence: ConfidentialEvidence } | { parsed: false; why: string };

  /** Anything that needs the live provider. Always a refusal here. */
  live(operation: LiveOperation): LiveOutcome;
}

// ---------------------------------------------------------------------------
// Checks that apply to every adapter
// ---------------------------------------------------------------------------

/**
 * Whether a request is sound before an adapter renders it.
 *
 * Shared, because an adapter that validated its own inputs would validate them
 * differently from the next one, and the rules are about the product rather
 * than about a cloud.
 */
export function requestProblems(request: RuntimeRequest, skus: readonly ConfidentialSku[] = CONFIDENTIAL_SKUS): readonly string[] {
  const problems: string[] = [];

  if (!/^[A-Za-z0-9_-]{4,64}$/.test(request.runtimeId)) {
    problems.push(`${request.runtimeId} is not a usable runtime id, and it becomes a resource name.`);
  }
  if (!request.tenantId.trim()) problems.push('A runtime with no tenant is a runtime nobody owns.');
  if (request.runtimeId === request.tenantId) {
    // They are different identifiers on purpose: one tenant may hold several
    // runtimes over time, and a runtime id that is a tenant id makes a
    // replacement runtime indistinguishable from the one it replaced.
    problems.push('The runtime id and the tenant id are the same, so a replacement runtime could not be told apart.');
  }

  const known = skus.find((sku) => sku.sku === request.sku.sku);
  if (!known) problems.push(`${request.sku.sku} is not a priced size, so what it costs is unknown.`);

  if (request.region !== request.sku.region) {
    // A size priced in one region and provisioned in another is a cost nobody
    // computed: the region spread on one size is more than twice.
    problems.push(`${request.sku.sku} is priced in ${request.sku.region} and this asks for ${request.region}, so the cost would be unknown.`);
  }

  if (!/^[0-9a-f]{32,128}$/.test(request.imageMeasurement)) {
    problems.push('The image measurement is not a hash, so nothing could be bound to it.');
  }
  if (request.dataDiskGb < 1) problems.push('A tenant needs a disk to keep anything on.');
  if (!Number.isInteger(request.generation) || request.generation < 1) {
    problems.push('A runtime with no deployment generation cannot be told from an older one.');
  }

  return problems;
}

/**
 * Whether this provider may hold a tenant at all.
 *
 * Asked before anything is rendered, because rendering a request for a
 * provider that is not enabled is how a disabled tier gets used by accident.
 * `CONFIDENTIAL_PROVIDERS_ENABLED` is empty and that is the honest state.
 */
export function providerMayHold(provider: ConfidentialProvider): { may: boolean; why: string } {
  if (CONFIDENTIAL_PROVIDERS_ENABLED.includes(provider)) {
    return { may: true, why: `${provider} is enabled.` };
  }
  return {
    may: false,
    why: `${provider} is not in CONFIDENTIAL_PROVIDERS_ENABLED, which is empty: no confidential provider has been provisioned or proved, so none may hold a tenant.`,
  };
}

/**
 * The one way an adapter's evidence reaches a verdict.
 *
 * Exported so an adapter cannot grow its own judgement. An adapter parses its
 * provider's document into `ConfidentialEvidence`; what that evidence is worth
 * is `judgeConfidentialEvidence`'s decision and nobody else's.
 */
export function judgeFromAdapter(
  adapter: ConfidentialProviderAdapter,
  raw: unknown,
  expected: Parameters<typeof judgeConfidentialEvidence>[1],
): ConfidentialVerdict | { ok: false; why: string } {
  const parsed = adapter.evidenceFrom(raw);
  if (!parsed.parsed) return { ok: false, why: parsed.why };
  return judgeConfidentialEvidence(parsed.evidence, expected);
}

export const PROVIDER_CAVEATS: readonly string[] = [
  'No confidential VM has been provisioned. Every operation here either renders a request or refuses, and nothing has been sent to any provider.',
  'A rendered request is source-inspected, never proven. It says what would be asked for, not that asking worked.',
  'No adapter holds a tenant master key. The key goes from a release service to an attested guest, and a control plane that handled it would have held it.',
  'An adapter does not judge its own attestation. It parses its provider document into evidence and judgeConfidentialEvidence decides what that evidence is worth.',
  'CONFIDENTIAL_PROVIDERS_ENABLED is empty, so providerMayHold refuses every provider. Enabling one is a decision that needs a hardware canary behind it.',
];
