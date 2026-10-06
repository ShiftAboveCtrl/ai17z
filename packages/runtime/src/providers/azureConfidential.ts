/**
 * Azure as a confidential host, rendered rather than called.
 *
 * Built from the official documentation read on 2026-10-05 and recorded in
 * `docs/architecture/CONFIDENTIAL_COMPUTE.md`. Every shape below is Azure's
 * own: the ARM resource, the security profile fields, the disk encryption
 * type, and the Key Vault release policy. Nothing is invented, because an
 * invented request renders cleanly and fails the first time somebody has a
 * credential.
 *
 * ## What Azure gives and what it does not
 *
 * A confidential VM has its own vTPM, outside the reach of any VM, and
 * confidential OS disk encryption binds the disk keys to it. The VM boots only
 * after the platform attests. Secure Key Release on Key Vault Premium or
 * Managed HSM is the attestation-gated release mechanism.
 *
 * **And the trap its own FAQ names.** Secure Key Release is a Key Vault
 * feature that works independently of the compute type, so a Trusted Launch
 * VM, which is not confidential, also produces attestation tokens and can
 * satisfy a carelessly written policy. The policy has to assert the TEE
 * claims. A policy that does not is attestation-gated release with nothing
 * behind it, and this adapter will not render one.
 *
 * ## The honest limit of the documented example
 *
 * The documented CVM release policy asserts two claims: the attestation type
 * is `sevsnpvm` and the compliance status is `azure-compliant-cvm`. Both are
 * real and strong, and together they say **the platform** is a compliant
 * confidential VM. They say nothing about which image booted. So this adapter
 * reports `binds: 'PLATFORM_ONLY'` for that policy and renders the guest
 * measurement claim as well where one is configured, because binding release
 * to an approved AI17Z runtime is the requirement and the two-claim example is
 * not sufficient for it.
 */
import {
  type ConfidentialEvidence,
  type ConfidentialSku,
  AZURE_COMPLIANT_CVM,
  AZURE_SEVSNP_ATTESTATION_TYPE,
  AzureAttestationClaims,
  monthlyComputeUsd,
} from '@xbam/shared/contracts';

import { CONFIDENTIAL_SKUS } from '../confidentialSkus';
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

/** The ARM API version these shapes were read against. Pinned, not latest. */
export const ARM_API_VERSION = '2024-07-01';

/**
 * Azure's own word for encrypting the OS disk and the guest state.
 *
 * `DiskWithVMGuestState` encrypts both; `VMGuestStateOnly` encrypts only the
 * guest state and leaves the OS disk unencrypted. For a tenant whose database
 * is on that disk the weaker one is not an option, so it is not offered.
 */
export const SECURITY_ENCRYPTION_TYPE = 'DiskWithVMGuestState';

/** What this adapter needs before it could send anything. */
function missing(): readonly { name: string; how: string }[] {
  return [
    { name: 'AZURE_SUBSCRIPTION_ID', how: 'The subscription a confidential VM would be created in.' },
    { name: 'AZURE_TENANT_ID', how: 'The Entra tenant the credential belongs to.' },
    { name: 'a service principal or managed identity', how: 'Authorised to create virtual machines, disks and a Key Vault key in that subscription.' },
    { name: 'AZURE_KEY_VAULT_URI', how: 'A Key Vault Premium or Managed HSM, which is where an exportable key with a release policy can exist.' },
    { name: 'an attestation endpoint', how: 'A Microsoft Azure Attestation instance, or the shared regional endpoint, whose authority the release policy names.' },
  ];
}

export class AzureConfidentialAdapter implements ConfidentialProviderAdapter {
  readonly provider = 'AZURE' as const;
  readonly version = '0.1.0';

  /** Set only where an environment genuinely supplies them; absent here. */
  private readonly subscriptionId = process.env.AZURE_SUBSCRIPTION_ID?.trim() ?? '';
  private readonly resourceGroup = process.env.AZURE_RESOURCE_GROUP?.trim() ?? '';
  private readonly keyVaultUri = process.env.AZURE_KEY_VAULT_URI?.trim() ?? '';
  private readonly attestationAuthority = process.env.AZURE_ATTESTATION_AUTHORITY?.trim() ?? '';

  readiness(): ProviderReadiness {
    const absent = missing().filter((item) => {
      if (item.name === 'AZURE_SUBSCRIPTION_ID') return this.subscriptionId === '';
      if (item.name === 'AZURE_KEY_VAULT_URI') return this.keyVaultUri === '';
      if (item.name === 'an attestation endpoint') return this.attestationAuthority === '';
      return true;
    });
    if (absent.length === 0) {
      return { ready: true, detail: 'A subscription, a vault and an attestation authority are all configured.' };
    }
    return {
      ready: false,
      missing: absent,
      detail: `Azure cannot be reached from here: ${absent.length} of the things it needs are absent. Requests can still be rendered and reviewed.`,
    };
  }

  skus(): readonly ConfidentialSku[] {
    return CONFIDENTIAL_SKUS.filter((sku) => sku.provider === 'AZURE');
  }

  renderProvision(request: RuntimeRequest): ProvisionOutcome {
    const problems = requestProblems(request, this.skus());
    if (problems.length > 0) {
      return { rendered: false, why: problems.join(' '), missing: [] };
    }
    if (request.sku.provider !== 'AZURE') {
      return { rendered: false, why: `${request.sku.sku} is not an Azure size.`, missing: [] };
    }

    const subscription = this.subscriptionId || '{subscriptionId}';
    const group = this.resourceGroup || '{resourceGroup}';

    return {
      rendered: true,
      request: {
        provider: 'AZURE',
        operation: 'Microsoft.Compute/virtualMachines - Create Or Update',
        method: 'PUT',
        path: `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Compute/virtualMachines/${request.runtimeId}?api-version=${ARM_API_VERSION}`,
        body: {
          location: request.region,
          tags: {
            // The tenant is tagged because an operator has to be able to find
            // a runtime to delete it, and nothing about a tag is secret. The
            // measurement is tagged so a VM can be compared with the policy
            // that gates its key.
            'ai17z-tenant': request.tenantId,
            'ai17z-runtime': request.runtimeId,
            'ai17z-generation': String(request.generation),
            'ai17z-measurement': request.imageMeasurement,
          },
          properties: {
            hardwareProfile: { vmSize: request.sku.sku },
            securityProfile: {
              // The field that makes this a confidential VM rather than an
              // ordinary one. Without it everything else here is decoration.
              securityType: 'ConfidentialVM',
              uefiSettings: { secureBootEnabled: true, vTpmEnabled: true },
            },
            storageProfile: {
              osDisk: {
                createOption: 'FromImage',
                deleteOption: 'Delete',
                managedDisk: {
                  storageAccountType: 'Premium_LRS',
                  securityProfile: { securityEncryptionType: SECURITY_ENCRYPTION_TYPE },
                },
              },
              dataDisks: [
                {
                  // The tenant's own disk, and the only writable one. Its
                  // lun and createOption are the provider's; its size is the
                  // request's.
                  lun: 0,
                  createOption: 'Empty',
                  diskSizeGB: request.dataDiskGb,
                  deleteOption: 'Delete',
                  managedDisk: {
                    storageAccountType: 'Premium_LRS',
                    securityProfile: { securityEncryptionType: SECURITY_ENCRYPTION_TYPE },
                  },
                },
              ],
            },
            // Confidential VMs do not support accelerated networking, and
            // asking for it is a provisioning failure rather than a warning.
            networkProfile: { networkInterfaces: [{ id: '{networkInterfaceId}', properties: { primary: true } }] },
            diagnosticsProfile: {
              // Boot diagnostics screenshots are not available on a
              // confidential VM, and a screenshot of a tenant's console is
              // not a thing this product should want anyway.
              bootDiagnostics: { enabled: false },
            },
          },
        },
        provisioned: false,
        monthlyUsd: monthlyComputeUsd(request.sku),
        asserts: [
          'securityType ConfidentialVM, without which none of the rest is confidential',
          'vTPM and secure boot enabled, which is what the disk keys bind to',
          `OS and data disks encrypted as ${SECURITY_ENCRYPTION_TYPE}, so the tenant's database is not in the clear`,
          'boot diagnostics off, because a console screenshot of a tenant is not ours to take',
          'no accelerated networking, which a confidential VM does not support',
        ],
      },
    };
  }

  renderKeyReleasePolicy(request: KeyReleaseRequest): PolicyOutcome {
    if (request.tee !== 'AMD_SEV_SNP') {
      // The documented claim value is sevsnpvm. A TDX size on Azure attests
      // differently, and rendering the SEV-SNP claim for it would produce a
      // policy that refuses every real token.
      return {
        rendered: false,
        why: `This policy asserts ${AZURE_SEVSNP_ATTESTATION_TYPE}, which is the SEV-SNP claim value. A ${request.tee} runtime needs its own claim and this adapter does not have a documented value for it.`,
        missing: [],
      };
    }

    const authority = this.attestationAuthority || '{attestationAuthority}';

    return {
      rendered: true,
      policy: {
        provider: 'AZURE',
        attachesTo: `an exportable key in ${this.keyVaultUri || '{keyVaultUri}'} created with --exportable true`,
        policy: {
          version: '1.0.0',
          anyOf: [
            {
              authority,
              allOf: [
                // The two claims from the documented example. They assert the
                // platform is a compliant confidential VM.
                { claim: 'x-ms-isolation-tee.x-ms-attestation-type', equals: AZURE_SEVSNP_ATTESTATION_TYPE },
                { claim: 'x-ms-isolation-tee.x-ms-compliance-status', equals: AZURE_COMPLIANT_CVM },
              ],
            },
          ],
        },
        binds: 'PLATFORM_ONLY',
        refuses: [
          'a platform that is not a compliant Azure confidential VM',
          'a platform that does not attest as SEV-SNP',
          'anything the named attestation authority did not sign',
        ],
      },
    };
  }

  /**
   * The same policy, with the guest measurement as well.
   *
   * Separate from the documented example rather than folded into it, because
   * the two are different claims and the difference is the one this product
   * turns on. The documented example binds the platform; this binds the
   * runtime. It is rendered as a design with an explicit gap rather than as
   * something ready to use: the claim name for a guest measurement is not in
   * the CVM release-policy documentation, and inventing one would produce a
   * policy that looks stronger than it is.
   */
  renderRuntimeBoundPolicy(request: KeyReleaseRequest): PolicyOutcome {
    const base = this.renderKeyReleasePolicy(request);
    if (!base.rendered) return base;
    return {
      rendered: false,
      why:
        'A runtime-bound Azure policy needs a claim that carries the guest measurement. ' +
        'The SEV-SNP report and the measured-boot PCR values hold it, and the documentation names ' +
        'x-ms-azurevm-attested-pcr-values in the Trusted Launch context rather than in the CVM release-policy example. ' +
        'That is a design task with a documented path, and rendering a guessed claim name would make a platform-only ' +
        'policy look runtime-bound. The platform-only policy above is what this adapter will render today.',
      missing: [
        {
          name: 'the documented CVM release-policy claim for a guest measurement',
          how: 'From Azure attestation documentation, or from a measured token read off a real confidential VM, which needs the hardware canary.',
        },
      ],
    };
  }

  evidenceFrom(raw: unknown): { parsed: true; evidence: ConfidentialEvidence } | { parsed: false; why: string } {
    const claims = AzureAttestationClaims.safeParse(raw);
    if (!claims.success) {
      return { parsed: false, why: `That is not an Azure attestation token's claim set: ${claims.error.issues[0]?.message ?? 'unknown'}` };
    }
    return { parsed: true, evidence: { provider: 'AZURE', claims: claims.data } };
  }

  live(operation: LiveOperation): LiveOutcome {
    const subscription = this.subscriptionId || '{subscriptionId}';
    const group = this.resourceGroup || '{resourceGroup}';
    const vm = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Compute/virtualMachines/{runtimeId}`;
    const would: Record<LiveOperation, { method: string; path: string }> = {
      START: { method: 'POST', path: `${vm}/start?api-version=${ARM_API_VERSION}` },
      STOP: { method: 'POST', path: `${vm}/deallocate?api-version=${ARM_API_VERSION}` },
      DELETE: { method: 'DELETE', path: `${vm}?api-version=${ARM_API_VERSION}` },
      SNAPSHOT: {
        method: 'PUT',
        path: `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Compute/snapshots/{snapshotName}?api-version=${ARM_API_VERSION}`,
      },
      RESTORE: {
        method: 'PUT',
        path: `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Compute/disks/{diskName}?api-version=${ARM_API_VERSION}`,
      },
      HEALTH: { method: 'GET', path: `${vm}/instanceView?api-version=${ARM_API_VERSION}` },
      USAGE: { method: 'GET', path: `/subscriptions/${subscription}/providers/Microsoft.CostManagement/query?api-version=2024-08-01` },
      FETCH_ATTESTATION: {
        method: 'POST',
        path: `${this.attestationAuthority || '{attestationAuthority}'}/attest/AzureGuest?api-version=2022-08-01`,
      },
    };
    const held = providerMayHold('AZURE');
    return {
      executed: false,
      operation,
      would: would[operation],
      why: `${held.why} This adapter holds no Azure credential, so nothing was sent. ${this.readiness().detail}`,
    };
  }
}

export const azureConfidential = new AzureConfidentialAdapter();
