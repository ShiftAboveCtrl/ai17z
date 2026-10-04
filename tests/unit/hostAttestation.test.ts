import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTESTATION_CAVEATS,
  SNP_POLICY_BITS,
  TDX_ATTRIBUTE_BITS,
  attestationVerdict,
  compareTcb,
  mayReleaseRuntimeKey,
  registerVendorVerifier,
  registeredVerifier,
  resetVendorVerifiersForTest,
  type AttestationExpectation,
  type AttestationReport,
} from '@xbam/runtime';

/**
 * The tier that is designed and refused.
 *
 * The property that matters most is the one a reviewer should be able to check
 * in one test: with no verifier registered there is no path through any of
 * this that trusts a host or releases a key. Everything else pins a refusal
 * that would otherwise be easy to drop, in particular a report whose policy
 * permits debug, which looks like a valid report and proves nothing.
 */

afterEach(() => resetVendorVerifiersForTest());

const MEASUREMENT = 'ab'.repeat(24);
const NONCE = 'cd'.repeat(32);

const report = (over: Partial<AttestationReport> = {}): AttestationReport => ({
  kind: 'SEV_SNP',
  measurement: MEASUREMENT,
  policy: 0n,
  reportData: NONCE,
  signature: 'a-vendor-signature',
  platformId: 'chip-1',
  tcbVersion: '1.55.0',
  ...over,
});

const expectation = (over: Partial<AttestationExpectation> = {}): AttestationExpectation => ({
  kind: 'SEV_SNP',
  allowedMeasurements: [MEASUREMENT],
  expectedReportData: NONCE,
  minimumTcbVersion: '1.55.0',
  ...over,
});

const goodVerifier = () =>
  registerVendorVerifier({
    kind: 'SEV_SNP',
    rootDescription: 'A test root, which is not a vendor root.',
    verify: async () => ({ signed: true }),
  });

describe('with no verifier registered', () => {
  it('registers none by default', () => {
    expect(registeredVerifier('SEV_SNP')).toBeUndefined();
    expect(registeredVerifier('TDX')).toBeUndefined();
  });

  it('refuses an otherwise perfect report', () => {
    // The whole of "not enabled", in one assertion.
    return attestationVerdict(report(), expectation()).then((out) => {
      expect(out.trusted).toBe(false);
      if (out.trusted) return;
      expect(out.reasons.join(' ')).toContain('hardware vendor root of trust');
    });
  });

  it('releases no key', async () => {
    const out = await mayReleaseRuntimeKey({
      tier: 'CONFIDENTIAL_COMPUTE',
      report: report(),
      expect: expectation(),
    });
    expect(out.release).toBe(false);
  });
});

describe('a report that must be refused', () => {
  it('refuses a policy permitting debug', async () => {
    // A guest somebody can attach to measures correctly and then changes.
    goodVerifier();
    const out = await attestationVerdict(report({ policy: 1n << BigInt(SNP_POLICY_BITS.DEBUG) }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('proves nothing');
  });

  it('refuses a TDX report with its own debug bit set', async () => {
    registerVendorVerifier({ kind: 'TDX', rootDescription: 'test', verify: async () => ({ signed: true }) });
    const out = await attestationVerdict(
      report({ kind: 'TDX', policy: 1n << BigInt(TDX_ATTRIBUTE_BITS.DEBUG) }),
      expectation({ kind: 'TDX' }),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('permits debug');
  });

  it('refuses a measurement that is not an image AI17Z published', async () => {
    goodVerifier();
    const out = await attestationVerdict(report({ measurement: 'ff'.repeat(24) }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('can reproduce');
  });

  it('refuses a report carrying no readable measurement', async () => {
    goodVerifier();
    for (const bad of ['', '   ', 'not hex at all']) {
      const out = await attestationVerdict(report({ measurement: bad }), expectation());
      expect(out.trusted, bad).toBe(false);
    }
  });

  it('refuses an old report replayed', async () => {
    // The nonce is the only thing making this about now.
    goodVerifier();
    const out = await attestationVerdict(report({ reportData: 'ee'.repeat(32) }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('replayed');
  });

  it('refuses firmware below the floor rather than warning', async () => {
    goodVerifier();
    const out = await attestationVerdict(report({ tcbVersion: '1.54.9' }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('below the floor');
  });

  it('refuses a report of the wrong kind', async () => {
    goodVerifier();
    const out = await attestationVerdict(report({ kind: 'TDX' }), expectation({ kind: 'SEV_SNP' }));
    expect(out.trusted).toBe(false);
  });

  it('refuses when the vendor root refuses', async () => {
    registerVendorVerifier({
      kind: 'SEV_SNP',
      rootDescription: 'test',
      verify: async () => ({ signed: false, why: 'the chain did not validate' }),
    });
    const out = await attestationVerdict(report(), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('did not validate');
  });

  it('gives every reason rather than the first', async () => {
    goodVerifier();
    const out = await attestationVerdict(
      report({ policy: 1n << BigInt(SNP_POLICY_BITS.DEBUG), measurement: 'ff'.repeat(24), reportData: 'x', signature: '', tcbVersion: '0.1.0' }),
      expectation(),
    );
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.length).toBeGreaterThanOrEqual(5);
  });

  it('says so when hyperthread siblings are permitted', async () => {
    goodVerifier();
    const out = await attestationVerdict(report({ policy: 1n << BigInt(SNP_POLICY_BITS.SMT_ALLOWED) }), expectation());
    expect(out.trusted).toBe(false);
    if (out.trusted) return;
    expect(out.reasons.join(' ')).toContain('hyperthread siblings');
  });
});

describe('a report that passes everything, with a registered verifier', () => {
  it('is trusted and names the root it rested on', async () => {
    // Proving the function can say yes, so the refusals above are refusals
    // rather than a function that always says no.
    goodVerifier();
    const out = await attestationVerdict(report(), expectation());
    expect(out.trusted).toBe(true);
    if (!out.trusted) return;
    expect(out.measurement).toBe(MEASUREMENT);
    expect(out.root).toContain('not a vendor root');
  });

  it('accepts firmware above the floor', async () => {
    goodVerifier();
    expect((await attestationVerdict(report({ tcbVersion: '1.56.0' }), expectation())).trusted).toBe(true);
  });
});

describe('comparing TCB versions', () => {
  it('orders them', () => {
    expect(compareTcb('1.55.0', '1.55.0')).toBe(0);
    expect(compareTcb('1.55.1', '1.55.0')).toBe(1);
    expect(compareTcb('1.54.9', '1.55.0')).toBe(-1);
    expect(compareTcb('2.0', '1.99.99')).toBe(1);
  });

  it('treats a missing component as zero rather than throwing', () => {
    expect(compareTcb('1.55', '1.55.0')).toBe(0);
    expect(compareTcb('', '0.0.0')).toBe(0);
  });
});

describe('releasing a key', () => {
  it('refuses a tier that may not hold a tenant, and says what is still required', async () => {
    const out = await mayReleaseRuntimeKey({ tier: 'VERIFIED_PROVIDER' });
    expect(out.release).toBe(false);
    if (out.release) return;
    expect(out.why.some((w) => w.startsWith('Still required:'))).toBe(true);
  });

  it('refuses attested release for the first-party tier', async () => {
    // Host-sealed is a different arrangement, not a weaker form of this one,
    // and calling it attested release would be false.
    const out = await mayReleaseRuntimeKey({ tier: 'FIRST_PARTY_TRUSTED' });
    expect(out.release).toBe(false);
    if (out.release) return;
    expect(out.why.join(' ')).toContain('sealed on the host');
  });

  it('refuses the confidential tier before it even looks for an attestation', async () => {
    // The tier gate is first on purpose: not enabled is the stronger refusal,
    // and it is the one an operator needs to read. The guard that refuses a
    // missing attestation sits behind it and becomes reachable only when the
    // tier is enabled, which is why nothing here can reach it.
    const out = await mayReleaseRuntimeKey({ tier: 'CONFIDENTIAL_COMPUTE' });
    expect(out.release).toBe(false);
    if (out.release) return;
    expect(out.why[0]).toContain('may not hold a tenant yet');
    expect(out.why.some((w) => w.startsWith('Still required:'))).toBe(true);
  });

  it('refuses the confidential tier even with a perfect report, because it is not enabled', async () => {
    goodVerifier();
    const out = await mayReleaseRuntimeKey({ tier: 'CONFIDENTIAL_COMPUTE', report: report(), expect: expectation() });
    expect(out.release).toBe(false);
  });
});

describe('what this does not claim', () => {
  it('says no verifier is registered', () => {
    expect(ATTESTATION_CAVEATS.join(' ').toLowerCase()).toContain('no verifier is registered');
  });

  it('refuses to call a host-sealed key attested release', () => {
    expect(ATTESTATION_CAVEATS.join(' ').toLowerCase()).toContain('would be false');
  });

  it('says attestation proves what booted and not what it does afterwards', () => {
    expect(ATTESTATION_CAVEATS.join(' ').toLowerCase()).toContain('not what the software does afterwards');
  });

  it('says the bit positions have not been exercised against real hardware', () => {
    expect(ATTESTATION_CAVEATS.join(' ').toLowerCase()).toContain('not been exercised against real hardware');
  });
});
