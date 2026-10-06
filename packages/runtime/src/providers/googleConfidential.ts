/**
 * Google Cloud as a confidential host, rendered rather than called.
 *
 * Built from the official documentation read on 2026-10-05 and recorded in
 * `docs/architecture/CONFIDENTIAL_COMPUTE.md`.
 *
 * ## Why this adapter exists alongside the Azure one
 *
 * Both providers can gate secret release on attestation. They differ in what
 * the claims pin, and that difference is the whole of the provider decision.
 *
 * Confidential Space asserts `assertion.submods.container.image_digest` and
 * `assertion.dbgstat` as first-class claims. Those map directly onto two
 * requirements this product cannot do without: a modified runtime must not
 * receive tenant secrets, and a debug-enabled guest must be refused. So a
 * Google policy can be `PLATFORM_AND_RUNTIME` where the documented Azure CVM
 * release policy is `PLATFORM_ONLY`.
 *
 * ## What it costs to say that
 *
 * SEV-SNP on Google is `N2D` only, in 15 zones. The all-in instance price is
 * **not** recorded here: getting it needs a Cloud Billing Catalog credential
 * this repository does not have, and reciting N2D prices from memory is
 * exactly what the research document exists to avoid. So `skus()` returns
 * nothing, and `renderProvision` refuses on that ground rather than rendering
 * a request whose cost nobody computed. The premium is known and is small, and
 * a premium is not a price.
 */
import {
  CONFIDENTIAL_SPACE_DEBUG_OFF,
  ConfidentialSpaceClaims,
  type ConfidentialEvidence,
  type ConfidentialSku,
} from '@xbam/shared/contracts';

import { GOOGLE_SEV_SNP_PREMIUM_PER_VCPU_HOUR_USD } from '../confidentialSkus';
import {
  providerMayHold,
  requestProblems,
  type ConfidentialProviderAdapter,
  type KeyReleaseRequest,
  type LiveOperation,
  type LiveOutcome,
  type PolicyOutcome,
  type ProviderReadiness,
  type ProvisionOutcome,
  type RuntimeRequest,
} from '../confidentialProvider';

/** The Compute Engine API version these shapes were read against. */
export const COMPUTE_API_VERSION = 'v1';

/**
 * The only machine family that does SEV-SNP on Google.
 *
 * AMD SEV runs on N2D, C2D, C3D, C4D and G4. **SEV-SNP is N2D only.** A
 * request for anything else with SEV-SNP is a request that fails at the API,
 * so it is refused here with the reason rather than sent.
 */
export const SEV_SNP_FAMILY = 'n2d';

/** What `confidentialInstanceType` takes. The provider's own values. */
export const CONFIDENTIAL_INSTANCE_TYPES = { AMD_SEV_SNP: 'SEV_SNP', INTEL_TDX: 'TDX' } as const;

/** SEV-SNP needs a CPU platform that has it. */
export const SEV_SNP_MIN_CPU_PLATFORM = 'AMD Milan';

function missing(): readonly { name: string; how: string }[] {
  return [
    { name: 'GOOGLE_CLOUD_PROJECT', how: 'The project a confidential instance would be created in.' },
    { name: 'application default credentials', how: 'A service account authorised to create instances, disks and a workload identity pool.' },
    { name: 'a Confidential Space workload identity pool provider', how: 'The thing attribute conditions attach to, which is what gates Cloud KMS and Secret Manager.' },
    {
      name: 'the Cloud Billing Catalog API',
      how: 'Needed for the all-in instance price. Without it the compute cost of a Google runtime is unknown and no plan can be priced against it.',
    },
  ];
}

export class GoogleConfidentialAdapter implements ConfidentialProviderAdapter {
  readonly provider = 'GOOGLE_CLOUD' as const;
  readonly version = '0.1.0';

  private readonly project = process.env.GOOGLE_CLOUD_PROJECT?.trim() ?? '';
  private readonly zone = process.env.GOOGLE_CLOUD_ZONE?.trim() ?? '';
  private readonly workloadPool = process.env.GOOGLE_WORKLOAD_IDENTITY_POOL?.trim() ?? '';

  readiness(): ProviderReadiness {
    const absent = missing().filter((item) => {
      if (item.name === 'GOOGLE_CLOUD_PROJECT') return this.project === '';
      if (item.name === 'a Confidential Space workload identity pool provider') return this.workloadPool === '';
      return true;
    });
    if (absent.length === 0) return { ready: true, detail: 'A project and a workload identity pool are configured.' };
    return {
      ready: false,
      missing: absent,
      detail: `Google cannot be reached from here: ${absent.length} of the things it needs are absent. Requests can still be rendered and reviewed, except where the cost is unknown.`,
    };
  }

  /**
   * Nothing, and deliberately.
   *
   * A size with no price is a size a plan cannot be built on, and the all-in
   * Google instance price needs a billing catalog credential. Returning an
   * unpriced size would let `computeFloor` pick it.
   */
  skus(): readonly ConfidentialSku[] {
    return [];
  }

  renderProvision(request: RuntimeRequest): ProvisionOutcome {
    if (request.sku.provider !== 'GOOGLE_CLOUD') {
      return { rendered: false, why: `${request.sku.sku} is not a Google size.`, missing: [] };
    }
    // Checked before the cost refusal so a malformed request is reported as
    // malformed rather than as unpriced.
    const problems = requestProblems(request, [request.sku]);
    if (problems.length > 0) return { rendered: false, why: problems.join(' '), missing: [] };

    if (!request.sku.sku.startsWith(`${SEV_SNP_FAMILY}-`) && request.sku.tee === 'AMD_SEV_SNP') {
      return {
        rendered: false,
        why: `SEV-SNP on Google is ${SEV_SNP_FAMILY} only, and ${request.sku.sku} is not in that family. The API would refuse this.`,
        missing: [],
      };
    }

    return {
      rendered: false,
      why:
        "Google's all-in instance price is not recorded, so what this runtime would cost is unknown and no plan can be " +
        `priced against it. The SEV-SNP premium is known and small, $${GOOGLE_SEV_SNP_PREMIUM_PER_VCPU_HOUR_USD} per vCPU per hour, ` +
        'and a premium is not a price. The instance body this would send is available from renderInstanceBody for review.',
      missing: [missing().find((m) => m.name === 'the Cloud Billing Catalog API')!],
    };
  }

  /**
   * The instance body, for review, separate from provisioning.
   *
   * Rendering it is useful and provisioning from it is not, because the cost
   * is unknown. Keeping them apart means the shape can be reviewed and tested
   * without the refusal above having to be weakened to allow it.
   */
  renderInstanceBody(request: RuntimeRequest): Record<string, unknown> {
    const project = this.project || '{project}';
    const zone = this.zone || request.region;
    const confidentialInstanceType = CONFIDENTIAL_INSTANCE_TYPES[request.sku.tee];
    return {
      name: request.runtimeId,
      machineType: `zones/${zone}/machineTypes/${request.sku.sku}`,
      // The field that makes it confidential. enableConfidentialCompute alone
      // is plain SEV; the type is what selects SEV-SNP or TDX.
      confidentialInstanceConfig: { enableConfidentialCompute: true, confidentialInstanceType },
      ...(request.sku.tee === 'AMD_SEV_SNP' ? { minCpuPlatform: SEV_SNP_MIN_CPU_PLATFORM } : {}),
      shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
      scheduling: {
        // A confidential instance cannot be live migrated, so maintenance
        // terminates it. Saying so is better than discovering it.
        onHostMaintenance: 'TERMINATE',
        automaticRestart: true,
      },
      disks: [
        { boot: true, autoDelete: true, initializeParams: { sourceImage: '{confidentialSpaceImage}' } },
        {
          boot: false,
          autoDelete: true,
          initializeParams: { diskSizeGb: String(request.dataDiskGb), diskType: `zones/${zone}/diskTypes/pd-balanced` },
        },
      ],
      labels: {
        'ai17z-tenant': request.tenantId,
        'ai17z-runtime': request.runtimeId,
        'ai17z-generation': String(request.generation),
      },
      metadata: {
        items: [
          // Confidential Space takes its workload as a container image, and
          // the digest is what the release policy asserts. A tag would make
          // the policy meaningless.
          { key: 'tee-image-reference', value: `{registry}/ai17z-runtime@sha256:${request.imageMeasurement}` },
          { key: 'tee-restart-policy', value: 'Never' },
        ],
      },
      serviceAccounts: [{ email: '{workloadServiceAccount}', scopes: ['https://www.googleapis.com/auth/cloud-platform'] }],
      zone: `projects/${project}/zones/${zone}`,
    };
  }

  renderKeyReleasePolicy(request: KeyReleaseRequest): PolicyOutcome {
    const pool = this.workloadPool || '{workloadIdentityPoolProvider}';
    /*
      An attribute condition in Common Expression Language, which is what a
      workload identity pool provider takes. Every clause is one of the
      documented Confidential Space assertions.

      The debug clause is the one worth reading twice: dbgstat must be
      disabled-since-boot. "Not enabled" would not be the same thing, because
      a guest that had debug on at any point since boot is a guest whose
      memory may already have been read.
    */
    const conditions = [
      `assertion.submods.container.image_digest == "sha256:${request.imageMeasurement}"`,
      `assertion.dbgstat == "${CONFIDENTIAL_SPACE_DEBUG_OFF}"`,
      `assertion.hwmodel == "${request.tee === 'AMD_SEV_SNP' ? 'GCP_AMD_SEV' : 'INTEL_TDX'}"`,
      `assertion.submods.confidential_space.support_attributes.exists(a, a == "STABLE")`,
    ];
    return {
      rendered: true,
      policy: {
        provider: 'GOOGLE_CLOUD',
        attachesTo: `the attribute condition on workload identity pool provider ${pool}, which gates Cloud KMS and Secret Manager`,
        policy: { attributeCondition: conditions.join(' && ') },
        // The claim set pins the workload image and the debug flag, which is
        // what makes this bind the runtime rather than only the platform.
        binds: 'PLATFORM_AND_RUNTIME',
        refuses: [
          'a workload whose container digest is not the approved runtime, so a modified runtime receives nothing',
          'a guest with debug enabled at any point since boot, rather than merely debug-enabled now',
          'hardware that is not the expected confidential family',
          'a Confidential Space image that is not a stable one',
        ],
      },
    };
  }

  evidenceFrom(raw: unknown): { parsed: true; evidence: ConfidentialEvidence } | { parsed: false; why: string } {
    const claims = ConfidentialSpaceClaims.safeParse(raw);
    if (!claims.success) {
      return { parsed: false, why: `That is not a Confidential Space attestation's claim set: ${claims.error.issues[0]?.message ?? 'unknown'}` };
    }
    return { parsed: true, evidence: { provider: 'GOOGLE_CLOUD', claims: claims.data } };
  }

  live(operation: LiveOperation): LiveOutcome {
    const project = this.project || '{project}';
    const zone = this.zone || '{zone}';
    const base = `/compute/${COMPUTE_API_VERSION}/projects/${project}/zones/${zone}/instances/{runtimeId}`;
    const would: Record<LiveOperation, { method: string; path: string }> = {
      START: { method: 'POST', path: `${base}/start` },
      STOP: { method: 'POST', path: `${base}/stop` },
      DELETE: { method: 'DELETE', path: base },
      SNAPSHOT: { method: 'POST', path: `/compute/${COMPUTE_API_VERSION}/projects/${project}/zones/${zone}/disks/{diskName}/createSnapshot` },
      RESTORE: { method: 'POST', path: `/compute/${COMPUTE_API_VERSION}/projects/${project}/zones/${zone}/disks` },
      HEALTH: { method: 'GET', path: base },
      USAGE: { method: 'GET', path: `/v1/projects/${project}/skus` },
      FETCH_ATTESTATION: {
        // Confidential Space exposes its token through the launcher's own
        // socket inside the guest, not through a control-plane API. Which is
        // the point: the control plane cannot fetch a token on the guest's
        // behalf, so it cannot forge one either.
        method: 'GET',
        path: 'unix:/run/container_launcher/teeserver.sock /v1/token (inside the guest only)',
      },
    };
    const held = providerMayHold('GOOGLE_CLOUD');
    return {
      executed: false,
      operation,
      would: would[operation],
      why: `${held.why} This adapter holds no Google credential, so nothing was sent. ${this.readiness().detail}`,
    };
  }
}

export const googleConfidential = new GoogleConfidentialAdapter();
