import { describe, expect, it } from 'vitest';
import {
  AZURE_COMPLIANT_CVM,
  AZURE_SEVSNP_ATTESTATION_TYPE,
  CONFIDENTIAL_CAVEATS,
  CONFIDENTIAL_PROVIDERS,
  CONFIDENTIAL_PROVIDERS_ENABLED,
  CONFIDENTIAL_REQUIREMENTS,
  CONFIDENTIAL_SPACE_DEBUG_OFF,
  CONFIDENTIAL_SPACE_DEBUG_ON,
  HOURS_PER_MONTH,
  SMALLEST_CONFIDENTIAL_VCPUS,
  monthlyComputeUsd,
  type ConfidentialEvidence,
} from '@xbam/shared';
import {
  FORBIDDEN_UNTIL_PROVEN,
  describesMoreThanProven,
  judgeConfidentialEvidence,
  mayReleaseToConfidentialRuntime,
  type ConfidentialExpectation,
} from '@xbam/runtime';

/**
 * The tier that would address the host operator, and the refusals that keep it
 * honest until it does.
 *
 * Two of these are the whole point. A Google token with debug enabled measures
 * correctly and proves nothing, and an Azure token carrying only the two
 * claims from the documented release policy says the platform is compliant and
 * says nothing about what is running on it. Both look like valid evidence.
 */

const DIGEST = 'sha256:' + 'a'.repeat(64);
const NONCE = 'n'.repeat(32);
const PCR = 'b'.repeat(64);

const azure = (over: Partial<ConfidentialEvidence & { provider: 'AZURE' }> = {}): ConfidentialEvidence =>
  ({
    provider: 'AZURE',
    claims: {
      authority: 'https://sharedweu.weu.attest.azure.net',
      isolationTee: { attestationType: AZURE_SEVSNP_ATTESTATION_TYPE, complianceStatus: AZURE_COMPLIANT_CVM },
      attestedPcrValues: { '11': PCR },
      issuedAt: new Date().toISOString(),
      nonce: NONCE,
      ...(over as { claims?: Record<string, unknown> }).claims,
    },
  }) as ConfidentialEvidence;

const google = (claims: Record<string, unknown> = {}): ConfidentialEvidence =>
  ({
    provider: 'GOOGLE_CLOUD',
    claims: {
      hardwareModel: 'GCP_AMD_SEV',
      imageDigest: DIGEST,
      softwareVersion: '250901',
      debugStatus: CONFIDENTIAL_SPACE_DEBUG_OFF,
      instanceId: '1234567890',
      supportAttributes: ['STABLE'],
      issuedAt: new Date().toISOString(),
      nonce: NONCE,
      ...claims,
    },
  }) as ConfidentialEvidence;

const expectation = (over: Partial<ConfidentialExpectation> = {}): ConfidentialExpectation => ({
  provider: 'GOOGLE_CLOUD',
  tee: 'AMD_SEV_SNP',
  nonce: NONCE,
  allowedMeasurements: [DIGEST, PCR],
  maxAgeMs: 120_000,
  ...over,
});

describe('nothing is enabled, and that is the state rather than a gap', () => {
  it('enables no confidential provider', () => {
    expect([...CONFIDENTIAL_PROVIDERS_ENABLED]).toEqual([]);
    expect(CONFIDENTIAL_PROVIDERS.length).toBeGreaterThan(0);
  });

  it('releases nothing, whatever the evidence says', () => {
    const out = mayReleaseToConfidentialRuntime({ evidence: google(), expect: expectation() });
    expect(out.release).toBe(false);
    if (out.release) return;
    expect(out.why.join(' ')).toContain('No confidential provider is enabled');
  });

  it('says what each provider would still have to prove', () => {
    for (const provider of CONFIDENTIAL_PROVIDERS) {
      expect(CONFIDENTIAL_REQUIREMENTS[provider].length, provider).toBeGreaterThan(0);
    }
    // The Azure trap, named where somebody writing the policy would read it.
    expect(CONFIDENTIAL_REQUIREMENTS.AZURE.join(' ')).toContain('Trusted Launch VM can also satisfy');
  });
});

describe('a Google token that must be refused', () => {
  it('refuses debug enabled, because the measurement then proves nothing', () => {
    const out = judgeConfidentialEvidence(google({ debugStatus: CONFIDENTIAL_SPACE_DEBUG_ON }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('proves nothing');
  });

  it('refuses a workload digest AI17Z did not publish', () => {
    const out = judgeConfidentialEvidence(google({ imageDigest: 'sha256:' + 'f'.repeat(64) }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('can reproduce');
  });

  it('refuses a replayed token', () => {
    const out = judgeConfidentialEvidence(google({ nonce: 'x'.repeat(32) }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('replayed');
  });

  it('refuses one held past its window, and one from the future', () => {
    const old = judgeConfidentialEvidence(
      google({ issuedAt: new Date(Date.now() - 600_000).toISOString() }),
      expectation(),
    );
    expect(old.trusted).toBe(false);
    const ahead = judgeConfidentialEvidence(
      google({ issuedAt: new Date(Date.now() + 60_000).toISOString() }),
      expectation(),
    );
    expect(ahead.trusted).toBe(false);
    if (ahead.trusted) return;
    expect(ahead.reasons.join(' ')).toContain('after now');
  });

  it('refuses hardware that is not the technology asked for', () => {
    const out = judgeConfidentialEvidence(google({ hardwareModel: 'INTEL_TDX' }), expectation({ tee: 'AMD_SEV_SNP' }));
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('INTEL_TDX');
  });

  it('refuses a hardware model it does not know rather than assuming', () => {
    expect(judgeConfidentialEvidence(google({ hardwareModel: 'SOMETHING_NEW' }), expectation()).trusted).toBe(false);
  });

  it('gives every reason rather than the first', () => {
    const out = judgeConfidentialEvidence(
      google({ debugStatus: CONFIDENTIAL_SPACE_DEBUG_ON, imageDigest: 'sha256:' + 'f'.repeat(64), nonce: 'bad', softwareVersion: '' }),
      expectation(),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe('an Azure token that looks valid and binds to nothing', () => {
  it('refuses evidence carrying only the two claims from the documented policy', () => {
    /*
      This is the important one. Those two claims say the platform is a
      compliant SEV-SNP confidential VM and say nothing about the image running
      on it, so a host could boot a modified AI17Z on compliant hardware and
      the documented policy would be satisfied.
    */
    const out = judgeConfidentialEvidence(
      azure({ claims: { attestedPcrValues: undefined } } as never),
      expectation({ provider: 'AZURE', tee: 'AMD_SEV_SNP' }),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('binds to a compliant platform and not to a runtime');
  });

  it('refuses a platform that is not a confidential VM, and says what Secure Key Release would do', () => {
    const out = judgeConfidentialEvidence(
      azure({ claims: { isolationTee: { attestationType: 'tpm', complianceStatus: AZURE_COMPLIANT_CVM } } } as never),
      expectation({ provider: 'AZURE' }),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('Trusted Launch VM just as happily');
  });

  it('refuses a token from an authority that was not pinned', () => {
    const out = judgeConfidentialEvidence(
      azure({ claims: { authority: 'https://attacker.example.com' } } as never),
      expectation({ provider: 'AZURE', azureAuthority: 'https://sharedweu.weu.attest.azure.net' }),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('pinned authority');
  });

  it('refuses a PCR value that is not a published measurement', () => {
    const out = judgeConfidentialEvidence(
      azure({ claims: { attestedPcrValues: { '11': 'c'.repeat(64) } } } as never),
      expectation({ provider: 'AZURE' }),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('No measured-boot PCR value matches');
  });

  it('refuses evidence from the wrong provider entirely', () => {
    const out = judgeConfidentialEvidence(google(), expectation({ provider: 'AZURE' }));
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('was asked for');
  });
});

describe('what may be said about it', () => {
  it('refuses every phrase that claims more than has been proved', () => {
    for (const entry of FORBIDDEN_UNTIL_PROVEN) {
      const out = describesMoreThanProven(`Your agent runs ${entry.phrase} on our platform.`);
      expect(out.ok, entry.phrase).toBe(false);
    }
  });

  it('names what each phrase would need', () => {
    for (const entry of FORBIDDEN_UNTIL_PROVEN) {
      expect(entry.needs.length, entry.phrase).toBeGreaterThan(20);
    }
  });

  it('allows an accurate sentence', () => {
    expect(describesMoreThanProven('Your hosted agent runs in an isolated runtime and its durable state is encrypted.').ok).toBe(true);
  });

  it('refuses the word confidential while nothing is enabled', () => {
    // A container is not, a normal VM is not, and a microVM is not against the
    // host administrator.
    expect(describesMoreThanProven('a confidential environment').ok).toBe(false);
  });
});

describe('the economics the smallest unit forces', () => {
  it('records that two vCPUs is the floor, because there is no smaller confidential size', () => {
    expect(SMALLEST_CONFIDENTIAL_VCPUS).toBe(2);
  });

  it('prices a month the same way everywhere', () => {
    expect(HOURS_PER_MONTH).toBe(730);
    // The measured Azure figure for the smallest confidential VM in eastus.
    expect(monthlyComputeUsd({ pricePerHourUsd: 0.086, confidentialPremiumPerHourUsd: 0 })).toBeCloseTo(62.78, 2);
  });

  it('adds a separately charged confidential premium where a provider has one', () => {
    // Google charges the premium on top; Azure does not charge one separately.
    expect(monthlyComputeUsd({ pricePerHourUsd: 0.1038, confidentialPremiumPerHourUsd: 0.0055 })).toBeCloseTo(79.79, 1);
  });
});

describe('what the caveats refuse to let anybody forget', () => {
  it('separates tenant isolation from host-operator protection', () => {
    expect(CONFIDENTIAL_CAVEATS.join(' ')).toContain('Only confidential compute addresses the host operator');
  });

  it('says availability is not confidentiality', () => {
    expect(CONFIDENTIAL_CAVEATS.join(' ')).toContain('Availability is not confidentiality');
  });

  it('names the Secure Key Release trap', () => {
    expect(CONFIDENTIAL_CAVEATS.join(' ')).toContain('Trusted Launch VM can also satisfy');
  });

  it('says nothing has been provisioned or released', () => {
    expect(CONFIDENTIAL_CAVEATS.join(' ')).toContain('no key released');
  });
});
