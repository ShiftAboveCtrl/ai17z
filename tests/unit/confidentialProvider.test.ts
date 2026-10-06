import { describe, expect, it } from 'vitest';

import {
  ARM_API_VERSION,
  AzureConfidentialAdapter,
  CONFIDENTIAL_SKUS,
  GoogleConfidentialAdapter,
  PROVIDER_CAVEATS,
  SECURITY_ENCRYPTION_TYPE,
  SEV_SNP_FAMILY,
  judgeFromAdapter,
  judgeRuntimeBinding,
  providerMayHold,
  requestProblems,
  type RuntimeRecord,
  type RuntimeRequest,
} from '@xbam/runtime';

const azure = new AzureConfidentialAdapter();
const google = new GoogleConfidentialAdapter();

const AZURE_SKU = CONFIDENTIAL_SKUS.find((s) => s.sku === 'Standard_DC2as_v5')!;
const MEASUREMENT = 'a'.repeat(64);

const request = (over: Partial<RuntimeRequest> = {}): RuntimeRequest => ({
  runtimeId: 'rt-alpha',
  tenantId: 'tenant-alpha',
  sku: AZURE_SKU,
  region: AZURE_SKU.region,
  imageMeasurement: MEASUREMENT,
  dataDiskGb: 32,
  generation: 3,
  ...over,
});

describe('what a provider adapter may do at all', () => {
  it('refuses every provider while none is enabled', () => {
    // CONFIDENTIAL_PROVIDERS_ENABLED is empty and that is the honest state.
    for (const provider of ['AZURE', 'GOOGLE_CLOUD', 'FIRST_PARTY_HARDWARE'] as const) {
      const held = providerMayHold(provider);
      expect(held.may, provider).toBe(false);
      expect(held.why).toContain('empty');
    }
  });

  it('says plainly that nothing has been provisioned', () => {
    const all = PROVIDER_CAVEATS.join(' ');
    expect(all).toContain('No confidential VM has been provisioned');
    expect(all).toContain('source-inspected, never proven');
  });

  it('says no adapter holds a tenant master key', () => {
    expect(PROVIDER_CAVEATS.join(' ')).toContain('No adapter holds a tenant master key');
  });
});

describe('a request before anything is rendered', () => {
  it('accepts a sound one', () => {
    expect(requestProblems(request())).toEqual([]);
  });

  it('refuses a runtime id that would become a bad resource name', () => {
    expect(requestProblems(request({ runtimeId: 'no' })).join(' ')).toContain('not a usable runtime id');
  });

  it('refuses a runtime id equal to the tenant id', () => {
    // One tenant may hold several runtimes over time, and a runtime id that is
    // a tenant id makes a replacement indistinguishable from what it replaced.
    const problems = requestProblems(request({ runtimeId: 'tenant-alpha' })).join(' ');
    expect(problems).toContain('could not be told apart');
  });

  it('refuses a region the size was not priced in, because the cost would be unknown', () => {
    // The region spread on one size is more than twice.
    expect(requestProblems(request({ region: 'switzerlandnorth' })).join(' ')).toContain('cost would be unknown');
  });

  it('refuses a measurement that is not a hash', () => {
    expect(requestProblems(request({ imageMeasurement: 'latest' })).join(' ')).toContain('not a hash');
  });

  it('refuses a runtime with no deployment generation', () => {
    expect(requestProblems(request({ generation: 0 })).join(' ')).toContain('older one');
  });

  it('refuses a size that is not priced', () => {
    const unpriced = { ...AZURE_SKU, sku: 'Standard_DC48as_v5' };
    expect(requestProblems(request({ sku: unpriced })).join(' ')).toContain('not a priced size');
  });
});

describe('the Azure adapter', () => {
  it('is not ready, and names what it is missing rather than counting it', () => {
    const readiness = azure.readiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.missing.length).toBeGreaterThan(2);
    for (const item of readiness.missing) expect(item.how.length, item.name).toBeGreaterThan(20);
  });

  it('renders an ARM request that asserts the things that make it confidential', () => {
    const out = azure.renderProvision(request());
    expect(out.rendered).toBe(true);
    if (!out.rendered) return;
    const body = out.request.body as Record<string, any>;
    expect(body.properties.securityProfile.securityType).toBe('ConfidentialVM');
    expect(body.properties.securityProfile.uefiSettings.vTpmEnabled).toBe(true);
    expect(body.properties.storageProfile.osDisk.managedDisk.securityProfile.securityEncryptionType).toBe(SECURITY_ENCRYPTION_TYPE);
    expect(out.request.path).toContain(`api-version=${ARM_API_VERSION}`);
  });

  it("encrypts the tenant's data disk too, because the database is on it", () => {
    const out = azure.renderProvision(request());
    if (!out.rendered) throw new Error('expected a rendered request');
    const disks = (out.request.body as any).properties.storageProfile.dataDisks;
    expect(disks).toHaveLength(1);
    expect(disks[0].managedDisk.securityProfile.securityEncryptionType).toBe(SECURITY_ENCRYPTION_TYPE);
    expect(disks[0].diskSizeGB).toBe(32);
  });

  it('turns boot diagnostics off, because a console screenshot of a tenant is not ours to take', () => {
    const out = azure.renderProvision(request());
    if (!out.rendered) throw new Error('expected a rendered request');
    expect((out.request.body as any).properties.diagnosticsProfile.bootDiagnostics.enabled).toBe(false);
  });

  it('says what it costs and that it was not provisioned', () => {
    const out = azure.renderProvision(request());
    if (!out.rendered) throw new Error('expected a rendered request');
    expect(out.request.provisioned).toBe(false);
    expect(out.request.monthlyUsd).toBeCloseTo(62.78, 1);
  });

  it('refuses a Google size', () => {
    const notAzure = { ...AZURE_SKU, provider: 'GOOGLE_CLOUD' as const, sku: 'n2d-standard-2' };
    expect(azure.renderProvision(request({ sku: notAzure })).rendered).toBe(false);
  });

  it('renders the documented release policy and admits it binds the platform only', () => {
    const out = azure.renderKeyReleasePolicy({
      runtimeId: 'rt-alpha',
      tenantId: 'tenant-alpha',
      imageMeasurement: MEASUREMENT,
      generation: 3,
      tee: 'AMD_SEV_SNP',
    });
    expect(out.rendered).toBe(true);
    if (!out.rendered) return;
    // The two claims from the documented example, and the honest label.
    expect(out.policy.binds).toBe('PLATFORM_ONLY');
    expect(JSON.stringify(out.policy.policy)).toContain('x-ms-isolation-tee.x-ms-attestation-type');
    expect(JSON.stringify(out.policy.policy)).toContain('sevsnpvm');
  });

  it('refuses to render the SEV-SNP claim for a TDX runtime', () => {
    // A policy asserting sevsnpvm would refuse every real TDX token.
    const out = azure.renderKeyReleasePolicy({
      runtimeId: 'rt-alpha',
      tenantId: 'tenant-alpha',
      imageMeasurement: MEASUREMENT,
      generation: 3,
      tee: 'INTEL_TDX',
    });
    expect(out.rendered).toBe(false);
  });

  it('refuses to render a runtime-bound policy rather than guessing a claim name', () => {
    // Guessing one would make a platform-only policy look runtime-bound,
    // which is the single most expensive mistake available here.
    const out = azure.renderRuntimeBoundPolicy({
      runtimeId: 'rt-alpha',
      tenantId: 'tenant-alpha',
      imageMeasurement: MEASUREMENT,
      generation: 3,
      tee: 'AMD_SEV_SNP',
    });
    expect(out.rendered).toBe(false);
    if (out.rendered) return;
    expect(out.why).toContain('guessed claim name');
    expect(out.missing[0]!.how).toContain('hardware canary');
  });

  it('executes nothing, and says what it would have called', () => {
    for (const operation of ['START', 'STOP', 'DELETE', 'SNAPSHOT', 'RESTORE', 'HEALTH', 'USAGE', 'FETCH_ATTESTATION'] as const) {
      const out = azure.live(operation);
      expect(out.executed, operation).toBe(false);
      expect(out.would.path.length, operation).toBeGreaterThan(5);
    }
  });
});

describe('the Google adapter', () => {
  it('offers no sizes, because an unpriced size is one a plan cannot use', () => {
    // computeFloor would otherwise pick a size whose cost nobody computed.
    expect(google.skus()).toEqual([]);
  });

  it('refuses to provision because the all-in price is unknown, and says so', () => {
    const sku = { ...AZURE_SKU, provider: 'GOOGLE_CLOUD' as const, sku: 'n2d-standard-2', region: 'us-central1-a' };
    const out = google.renderProvision(request({ sku, region: 'us-central1-a' }));
    expect(out.rendered).toBe(false);
    if (out.rendered) return;
    expect(out.why).toContain('not recorded');
    expect(out.missing[0]!.name).toContain('Billing Catalog');
  });

  it('renders the instance body anyway, for review', () => {
    const sku = { ...AZURE_SKU, provider: 'GOOGLE_CLOUD' as const, sku: 'n2d-standard-2', region: 'us-central1-a' };
    const body = google.renderInstanceBody(request({ sku, region: 'us-central1-a' })) as Record<string, any>;
    expect(body.confidentialInstanceConfig.enableConfidentialCompute).toBe(true);
    expect(body.confidentialInstanceConfig.confidentialInstanceType).toBe('SEV_SNP');
    expect(body.minCpuPlatform).toBe('AMD Milan');
    // A confidential instance cannot be live migrated.
    expect(body.scheduling.onHostMaintenance).toBe('TERMINATE');
    expect(body.machineType).toContain(SEV_SNP_FAMILY);
  });

  it('names the workload by digest rather than by tag', () => {
    // A tag would make the release policy meaningless.
    const sku = { ...AZURE_SKU, provider: 'GOOGLE_CLOUD' as const, sku: 'n2d-standard-2', region: 'us-central1-a' };
    const body = google.renderInstanceBody(request({ sku, region: 'us-central1-a' })) as Record<string, any>;
    const image = body.metadata.items.find((i: any) => i.key === 'tee-image-reference');
    expect(image.value).toContain(`@sha256:${MEASUREMENT}`);
  });

  it('renders a policy that binds the runtime, not only the platform', () => {
    const out = google.renderKeyReleasePolicy({
      runtimeId: 'rt-alpha',
      tenantId: 'tenant-alpha',
      imageMeasurement: MEASUREMENT,
      generation: 3,
      tee: 'AMD_SEV_SNP',
    });
    expect(out.rendered).toBe(true);
    if (!out.rendered) return;
    expect(out.policy.binds).toBe('PLATFORM_AND_RUNTIME');
    const condition = String((out.policy.policy as any).attributeCondition);
    expect(condition).toContain('image_digest');
    // disabled-since-boot rather than "not enabled": a guest that had debug on
    // at any point since boot may already have been read.
    expect(condition).toContain('disabled-since-boot');
    expect(condition).toContain('hwmodel');
  });

  it('refuses a debug-enabled guest in its own words', () => {
    const out = google.renderKeyReleasePolicy({
      runtimeId: 'rt-alpha',
      tenantId: 'tenant-alpha',
      imageMeasurement: MEASUREMENT,
      generation: 3,
      tee: 'AMD_SEV_SNP',
    });
    if (!out.rendered) throw new Error('expected a policy');
    expect(out.policy.refuses.join(' ')).toContain('at any point since boot');
  });

  it('fetches its attestation inside the guest, which is why a control plane cannot forge one', () => {
    const out = google.live('FETCH_ATTESTATION');
    expect(out.would.path).toContain('inside the guest only');
  });
});

describe('evidence from an adapter', () => {
  it('parses a Confidential Space claim set', () => {
    const parsed = google.evidenceFrom({
      hardwareModel: 'GCP_AMD_SEV',
      imageDigest: `sha256:${MEASUREMENT}`,
      softwareVersion: '240900',
      debugStatus: 'disabled-since-boot',
      instanceId: '1234567890',
      supportAttributes: ['STABLE'],
      issuedAt: new Date().toISOString(),
      nonce: 'n'.repeat(24),
    });
    expect(parsed.parsed).toBe(true);
  });

  it('refuses something that is not its provider document', () => {
    const parsed = google.evidenceFrom({ hello: 'world' });
    expect(parsed.parsed).toBe(false);
    if (parsed.parsed) return;
    expect(parsed.why).toContain('Confidential Space');
  });

  it('does not judge its own evidence: the verdict comes from the one judge', () => {
    // An adapter that graded itself would be a provider marking its own work.
    const raw = {
      hardwareModel: 'GCP_AMD_SEV',
      imageDigest: `sha256:${MEASUREMENT}`,
      softwareVersion: '240900',
      debugStatus: 'disabled-since-boot',
      instanceId: '1234567890',
      supportAttributes: ['STABLE'],
      issuedAt: new Date().toISOString(),
      nonce: 'n'.repeat(24),
    };
    const verdict = judgeFromAdapter(google, raw, {
      provider: 'GOOGLE_CLOUD',
      tee: 'AMD_SEV_SNP',
      nonce: 'n'.repeat(24),
      allowedMeasurements: [`sha256:${MEASUREMENT}`],
      maxAgeMs: 60_000,
    });
    // Refused, because no provider is enabled. That is the point: a correct
    // token does not become a release while the tier is disabled.
    expect('trusted' in verdict ? verdict.trusted : verdict.ok).toBe(false);
  });
});

describe('binding a runtime to a tenant and a generation', () => {
  const record: RuntimeRecord = { runtimeId: 'rt-alpha', tenantId: 'tenant-alpha', instance: '1234567890', generation: 3 };
  const evidence = google.evidenceFrom({
    hardwareModel: 'GCP_AMD_SEV',
    imageDigest: `sha256:${MEASUREMENT}`,
    softwareVersion: '240900',
    debugStatus: 'disabled-since-boot',
    instanceId: '1234567890',
    supportAttributes: ['STABLE'],
    issuedAt: new Date().toISOString(),
    nonce: 'n'.repeat(24),
  });
  const expectation = {
    provider: 'GOOGLE_CLOUD' as const,
    tee: 'AMD_SEV_SNP' as const,
    nonce: 'n'.repeat(24),
    allowedMeasurements: [`sha256:${MEASUREMENT}`],
    maxAgeMs: 60_000,
    instance: '1234567890',
    runtimeId: 'rt-alpha',
  };

  it('binds, and keeps what was attested apart from what was asserted', () => {
    if (!evidence.parsed) throw new Error('expected parsed evidence');
    const out = judgeRuntimeBinding(evidence.evidence, expectation, record, 3);
    expect(out.bound).toBe(true);
    if (!out.bound) return;
    // The distinction this function exists for: a record is not a proof.
    expect(out.attested.join(' ')).toContain('came from instance');
    expect(out.asserted.join(' ')).toContain('belongs to tenant');
    expect(out.attested.join(' ')).not.toContain('belongs to tenant');
  });

  it('refuses a token from another instance, however well measured', () => {
    const other = google.evidenceFrom({
      hardwareModel: 'GCP_AMD_SEV',
      imageDigest: `sha256:${MEASUREMENT}`,
      softwareVersion: '240900',
      debugStatus: 'disabled-since-boot',
      instanceId: '9999999999',
      supportAttributes: ['STABLE'],
      issuedAt: new Date().toISOString(),
      nonce: 'n'.repeat(24),
    });
    if (!other.parsed) throw new Error('expected parsed evidence');
    const out = judgeRuntimeBinding(other.evidence, expectation, record, 3);
    expect(out.bound).toBe(false);
    if (out.bound) return;
    expect(out.reasons.join(' ')).toContain('9999999999');
  });

  it('refuses an older deployment generation', () => {
    if (!evidence.parsed) throw new Error('expected parsed evidence');
    const out = judgeRuntimeBinding(evidence.evidence, expectation, record, 4);
    expect(out.bound).toBe(false);
    if (out.bound) return;
    expect(out.reasons.join(' ')).toContain('must not unseal newer state');
  });

  it('refuses a record with no tenant', () => {
    if (!evidence.parsed) throw new Error('expected parsed evidence');
    const out = judgeRuntimeBinding(evidence.evidence, expectation, { ...record, tenantId: '  ' }, 3);
    expect(out.bound).toBe(false);
  });

  it('refuses a record for a different runtime', () => {
    if (!evidence.parsed) throw new Error('expected parsed evidence');
    const out = judgeRuntimeBinding(evidence.evidence, expectation, { ...record, runtimeId: 'rt-bravo' }, 3);
    expect(out.bound).toBe(false);
    if (out.bound) return;
    expect(out.reasons.join(' ')).toContain('rt-bravo');
  });

  it('refuses evidence carrying no instance at all, which is the documented Azure example', () => {
    const azureEvidence = azure.evidenceFrom({
      authority: 'https://sharedweu.weu.attest.azure.net',
      isolationTee: { attestationType: 'sevsnpvm', complianceStatus: 'azure-compliant-cvm' },
      issuedAt: new Date().toISOString(),
      nonce: 'n'.repeat(24),
    });
    if (!azureEvidence.parsed) throw new Error('expected parsed evidence');
    const out = judgeRuntimeBinding(azureEvidence.evidence, { ...expectation, provider: 'AZURE' }, record, 3);
    expect(out.bound).toBe(false);
    if (out.bound) return;
    expect(out.reasons.join(' ')).toContain('two-claim example');
  });
});
