# Confidential compute

**Status: researched and designed. Not provisioned.** No confidential VM has
been created, no attestation has been verified against real hardware, and no
cloud resource has been paid for. Everything below is from current official
documentation and, for Azure, the public retail prices API, read on
2026-10-05. Where a figure needed a credential this repository does not have,
it says so instead of estimating.

## Why a microVM is not enough

The Firecracker lab in `packaging/hosted-lab/` boots a real guest under the
jailer, in its own network namespace, with egress rules a kernel accepted and a
guest could not get past. That proves tenants are isolated **from one another**.

It proves nothing about the host operator. KVM protects a guest from its
neighbours; it does not protect a guest from whoever controls the hypervisor.
An administrator on the host can read guest memory, attach a debugger, or
substitute a different kernel, and nothing in a microVM stops them.

The owner's requirement is specifically about that person. So production hosted
AI17Z needs hardware-backed confidential computing, and the Firecracker lab
stays what it is: a development and isolation lab, never described as
protection from the host.

## Availability and confidentiality are different guarantees

A host operator can always deny service. They can power the machine off, pull
its network, or delete the disk. **No architecture here promises immunity from
that, and none should.**

What the architecture does have to prevent is the operator being able to:

- read tenant plaintext memory
- read the tenant database in the clear
- read provider API keys, wallet material or X session cookies
- substitute a modified runtime and still receive the tenant's decryption keys
- enable debug on the guest and still receive them
- replay a stale attestation
- roll the tenant back to an older state without the owner noticing
- forge an owner-authorised financial action

Those are confidentiality and integrity. Availability is separate, and
conflating the two is how a security claim becomes untrue.

## What the two providers actually offer

### Azure confidential VMs

Sizes, from the current overview: `DCasv5`, `DCasv6`, `DCesv6` (general
purpose, no local disk); `DCadsv5`, `DCadsv6`, `DCedsv6` (with local disk);
`ECasv5`, `ECasv6`, `ECesv6` and the `ECads`/`ECeds` equivalents (memory
optimised); `NCCadsH100v5` (GPU). The `a` families are AMD SEV-SNP and the `e`
families are Intel TDX.

Each confidential VM has its **own vTPM**, which the documentation says "runs
in a secure environment outside the reach of any VM". Confidential OS disk
encryption binds the disk keys to that vTPM, with either a platform-managed or
a customer-managed key, and the documentation states the keys "securely bypass
Azure components, including the hypervisor and host operating system".

A confidential VM **boots only after successful attestation**. If SEV-SNP is
not enabled, Azure Attestation does not attest the platform and the VM does not
start.

**Secure Key Release** is the attestation-gated release mechanism, on Azure Key
Vault Premium or Managed HSM. A key is created `--exportable true` with a
release policy, and the policy conditions on Microsoft Azure Attestation
claims. The documented example is exactly the shape needed:

```json
{ "version": "1.0.0", "anyOf": [ { "authority": "https://sharedweu.weu.attest.azure.net",
  "allOf": [ { "claim": "x-ms-isolation-tee.x-ms-attestation-type", "equals": "sevsnpvm" },
             { "claim": "x-ms-isolation-tee.x-ms-compliance-status", "equals": "azure-compliant-cvm" } ] } ] }
```

**The trap in that feature, stated by its own FAQ.** Secure Key Release is a
Key Vault feature and works independently of the compute type: a Trusted Launch
VM, which is not confidential, also produces attestation tokens and a release
policy can be written that it satisfies. So SKR by itself is not a confidential
guarantee. **The policy has to assert the TEE claims**, and a policy that does
not is attestation-gated release with no confidentiality behind it.

Limitations that matter here: no live migration, no accelerated networking, no
boot diagnostics screenshots, confidential disk encryption only for disks under
128 GB, offline key rotation only, and Azure Backup support for confidential
VMs in public preview. From 30 March 2026 encrypted OS disks cost more.

### Google Cloud confidential VMs

AMD SEV: `N2D`, `C2D`, `C3D`, `C4D`, `G4`. **AMD SEV-SNP: `N2D` only**, in 15
zones. Intel TDX: `C3-standard-*`, `C3-standard-*-lssd`, `C4-standard-*` and
`a3-highgpu-1g`, in 24 or more zones, up to 192 vCPUs.

Limitations: no `kdump` on SEV-SNP or TDX, no reservation support on either, no
sole-tenant provisioning for TDX, TDX instances take longer to shut down, and
the SEV-SNP documentation warns of longer boot times and performance changes
between August and November 2026.

**Confidential Space** is the part that matters for key release, and its claim
set is unusually well suited to this requirement:

| Claim | What it pins |
| --- | --- |
| `assertion.submods.container.image_digest` | the workload container's digest |
| `assertion.swversion` | the Confidential Space image version |
| `assertion.dbgstat` | `"enable"` or `"disabled-since-boot"` |
| `assertion.hwmodel` | `GCP_AMD_SEV` or `INTEL_TDX` |
| `assertion.submods.gce.instance_id` | the VM instance |
| `assertion.submods.confidential_space.support_attributes` | image maturity |

Those are used as attribute conditions on a workload identity pool, which is
what gates Cloud KMS and Secret Manager.

### The difference that bears on the decision

Both providers can condition secret release on attestation. They differ in
**what the claims pin**.

Google's Confidential Space asserts the **workload image digest** and a
**debug flag** as first-class claims. That maps directly onto three of the
owner's requirements: a modified runtime cannot receive tenant secrets, a
debug-enabled guest is rejected, and release is conditioned on an approved
runtime policy.

Azure's documented CVM release policy asserts that the **platform** is a
compliant SEV-SNP confidential VM. That is a real and strong claim, and it is
not the same claim. Binding release to a particular AI17Z runtime image on
Azure needs more than the two claims in the documented example: the guest
measurement lives in the SEV-SNP report and in measured-boot PCR values, and
the FAQ names `x-ms-azurevm-attested-pcr-values` in the Trusted Launch context.
That is a design task with a documented path, not a gap, but it is more work
than the example suggests and it is the reason the example is not sufficient.

## Cost, measured rather than remembered

From the Azure retail prices API, `eastus`, Linux, consumption, read
2026-10-05. The smallest confidential VM is **two vCPUs**; there is no
one-vCPU confidential size.

| Size | vCPU | per hour | per month at 730h |
| --- | --- | --- | --- |
| `Standard_DC2as_v5` | 2 | $0.08600 | $62.78 |
| `Standard_DC4as_v5` | 4 | $0.17200 | $125.56 |
| `Standard_DC8as_v5` | 8 | $0.34400 | $251.12 |
| `Standard_DC2es_v6` | 2 | $0.11100 | $81.03 |
| `Standard_DC4es_v6` | 4 | $0.22200 | $162.06 |

Region spread for `Standard_DC2as_v5`, across the 18 regions the API lists:

| Region | per month |
| --- | --- |
| `centralindia`, `jioindiacentral`, `jioindiawest` | $40.59 |
| `eastus`, `eastus2` | $62.78 |
| `northeurope` | $70.08 |
| `switzerlandnorth` (dearest) | $89.79 |

Commitment, `eastus`: **1 year reserved $603.00, which is $50.25 a month. Three
years $1,356.00, which is $37.67 a month.**

So the compute floor for one confidential tenant runtime is between roughly
**$38 and $90 a month** depending on region and commitment, before disk,
egress, backup storage, or the control plane. That figure, not a guess about
it, is what the pricing model has to clear.

**These prices are data rather than a table here**, in
`packages/runtime/src/confidentialSkus.ts`, each carrying when it was read and
from where, so one can go stale and say so instead of ageing quietly.
`npm run hosted:cost` computes the floor from them and from the measured
tenant: it asks `sizeHoldsTenant` which sizes hold one, takes the cheapest that
does, and refuses when nothing fits or the measurement has expired. A price in
prose is a price nobody can check against a measurement, and the floor above
was exactly that until it was computed.

The computation also makes plain the fact that decides the shape of a plan, and
it is not about AI17Z at all: **the floor is set by what can be bought rather
than by what a tenant needs.** A tenant sized at 863 MB from the measurement is
given 8,192 because nothing smaller is sold, so 7,329 MB of it is spare. That
is the measured argument for several of one owner's agents sharing a runtime,
and for a browser living in that spare room rather than in a size up.

Google's SEV-SNP premium is **$0.0027502 per vCPU per hour** on demand, which
is small; the premium sits on top of the N2D instance price. The all-in Google
figure is **not recorded here**, because getting it from the Cloud Billing
Catalog API needs an API key this repository does not have, and reciting N2D
prices from memory is exactly what this document is written to avoid.

## What this means for the product

Two vCPUs and eight gigabytes is the smallest confidential unit that exists, so
a tenant runtime is at least that whether the agent needs it or not. That is
the strongest argument for the per-tenant model the mission already chose: one
confidential runtime holding **several of one owner's agents** amortises a cost
that cannot be subdivided. One VM per agent would multiply a floor rather than
share it.

It is also why BYOK for model providers is the right initial policy. A hosting
margin computed against a $38 to $90 floor does not survive unmetered token
spend on top.

## What has not been done

- No confidential VM has been provisioned on either provider.
- No attestation has been verified against real hardware. The verifier in
  `hostAttestation.ts` has no vendor root registered and refuses accordingly.
- No Secure Key Release policy has been created, and no key has been released.
- Google's all-in confidential instance cost is unmeasured, pending a billing
  catalog credential.
- No AI17Z runtime image has been built, so no measurement exists to pin.
- Azure Backup for confidential VMs is in public preview and has not been
  exercised.

## Sources

Read 2026-10-05, all current official documentation:

- [About Azure confidential VMs](https://learn.microsoft.com/en-us/azure/confidential-computing/confidential-vm-overview)
- [Secure Key Release with Azure Key Vault](https://learn.microsoft.com/en-us/azure/confidential-computing/concept-skr-attestation)
- [Azure retail prices API](https://prices.azure.com/api/retail/prices)
- [Confidential VM supported configurations](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/supported-configurations)
- [Confidential Space attestation assertions](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/attestation-assertions)
- [Confidential VM pricing](https://cloud.google.com/confidential-computing/confidential-vm/pricing)
- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
