import { PROVIDER_TIERS_ENABLED, TIER_REQUIREMENTS, type ProviderTier } from '@xbam/shared';

/**
 * What a confidential host would have to prove before it held a tenant key.
 *
 * `CONFIDENTIAL_COMPUTE` is designed and not enabled, and this module is what
 * "not enabled" looks like in code rather than in a comment. Nothing here can
 * return an approval: `attestationVerdict` refuses until a verifier has been
 * registered against a hardware vendor root of trust, and no verifier is
 * registered in this repository.
 *
 * It is written now rather than later because confidential compute is easy to
 * claim and the claim is worth nothing without exactly these checks, and
 * because the shape of the refusal is the part worth agreeing on while nobody
 * is under pressure to ship.
 *
 * The two mechanisms, as the vendor specifications describe them:
 *
 * On AMD SEV-SNP the guest asks the firmware for an attestation report, which
 * carries a launch MEASUREMENT and a 64-bit guest POLICY. The policy includes
 * a DEBUG bit, and a report whose policy permits debug describes a guest
 * somebody can attach to: accepting one would mean the measurement proved
 * nothing, because the thing it measured can be read and changed afterwards.
 *
 * On Intel TDX the guest obtains a TDREPORT through TDCALL[TDG.MR.REPORT],
 * reachable from Linux through `/dev/tdx-guest`. Its measurement is MRTD and
 * its equivalent of the policy is TD attributes, which carry a debug bit of
 * their own.
 *
 * The bit positions and field names below come from those specifications and
 * are not proved here. `attestationVerdict` refuses a report it cannot parse
 * rather than guessing at one, which is why being wrong about a position is a
 * refusal rather than a false approval.
 */

// ---------------------------------------------------------------------------
// What a report has to say
// ---------------------------------------------------------------------------

export const ATTESTATION_KINDS = ['SEV_SNP', 'TDX'] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

/** SEV-SNP guest policy bits, from the SEV-SNP ABI specification. */
export const SNP_POLICY_BITS = {
  /** Set means a debugger may attach to the guest. */
  DEBUG: 19,
  /** Set means the guest may run with hyperthread siblings in use. */
  SMT_ALLOWED: 16,
  /** Set means a migration agent is associated with the guest. */
  MIGRATE_MA: 18,
  /** Set means the guest is restricted to a single socket. */
  SINGLE_SOCKET: 20,
} as const;

/** Intel TDX TD attribute bits. */
export const TDX_ATTRIBUTE_BITS = {
  /** Set means the TD is debuggable. */
  DEBUG: 0,
} as const;

export interface AttestationReport {
  kind: AttestationKind;
  /**
   * The launch measurement, hex. SEV-SNP's MEASUREMENT or TDX's MRTD.
   *
   * This is the whole of the evidence about what booted, so a report carrying
   * no measurement is not a weaker report, it is not a report.
   */
  measurement: string;
  /** SEV-SNP's 64-bit POLICY or TDX's TD attributes, as a bigint. */
  policy: bigint;
  /** Nonce the verifier chose, echoed by the firmware. Hex. */
  reportData: string;
  /** Whatever the vendor's signature is over the report. Opaque here. */
  signature: string;
  /** The chip or platform identity the report names. */
  platformId: string;
  /** Firmware and TCB version the report claims. */
  tcbVersion: string;
}

export interface AttestationExpectation {
  kind: AttestationKind;
  /** Measurements for images AI17Z published and can reproduce. */
  allowedMeasurements: readonly string[];
  /** The nonce this verification asked for. Replaying an old report is the attack. */
  expectedReportData: string;
  /** TCB versions at or above the floor. Below it, known-broken firmware. */
  minimumTcbVersion: string;
}

// ---------------------------------------------------------------------------
// The verifier nobody has registered
// ---------------------------------------------------------------------------

/**
 * Checks a report's signature against the hardware vendor's root of trust.
 *
 * Deliberately an injected dependency with no default. A default would be
 * either a stub that approves, which is the worst possible thing to have in
 * this file, or a vendor client this repository does not have, and the honest
 * third option is that there is no verifier and the answer is a refusal.
 */
export interface VendorVerifier {
  kind: AttestationKind;
  /** The vendor root this verifier chains to, for the audit record. */
  rootDescription: string;
  verify(report: AttestationReport): Promise<{ signed: true } | { signed: false; why: string }>;
}

const verifiers = new Map<AttestationKind, VendorVerifier>();

/** Registers a verifier. Nothing in this repository calls this. */
export function registerVendorVerifier(verifier: VendorVerifier): void {
  verifiers.set(verifier.kind, verifier);
}

export function resetVendorVerifiersForTest(): void {
  verifiers.clear();
}

export function registeredVerifier(kind: AttestationKind): VendorVerifier | undefined {
  return verifiers.get(kind);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type AttestationVerdict =
  | { trusted: true; measurement: string; root: string }
  | { trusted: false; reasons: readonly string[] };

const HEX = /^[0-9a-f]+$/;

/**
 * Whether a host may be trusted with a tenant's key.
 *
 * Every reason rather than the first, and a refusal rather than a partial
 * trust, because the only thing this decides is whether a customer's master
 * key is released to a machine, and there is no useful middle answer to that.
 */
export async function attestationVerdict(
  report: AttestationReport,
  expect: AttestationExpectation,
): Promise<AttestationVerdict> {
  const reasons: string[] = [];

  if (report.kind !== expect.kind) {
    reasons.push(`This is a ${report.kind} report and a ${expect.kind} one was asked for.`);
  }

  // Parsed, not guessed. A report that cannot be read is refused rather than
  // treated optimistically, which is why being wrong about a field position
  // costs a refusal and never an approval.
  const measurement = report.measurement?.trim().toLowerCase() ?? '';
  if (!measurement || !HEX.test(measurement)) {
    reasons.push('The report carries no readable measurement, so it is not evidence about what booted.');
  } else if (!expect.allowedMeasurements.map((m) => m.toLowerCase()).includes(measurement)) {
    reasons.push('The launch measurement is not one of an image AI17Z published and can reproduce.');
  }

  const debugBit = report.kind === 'SEV_SNP' ? SNP_POLICY_BITS.DEBUG : TDX_ATTRIBUTE_BITS.DEBUG;
  if (bitSet(report.policy, debugBit)) {
    reasons.push(
      'The guest policy permits debug, which means the measurement proves nothing: the thing it measured can be attached to and changed afterwards.',
    );
  }

  if (report.kind === 'SEV_SNP' && bitSet(report.policy, SNP_POLICY_BITS.SMT_ALLOWED)) {
    // Not fatal on its own, and said rather than silently accepted: two
    // tenants on sibling threads is the arrangement every cross-thread side
    // channel has been demonstrated against.
    reasons.push('The guest policy permits hyperthread siblings, which this placement does not.');
  }

  const data = report.reportData?.trim().toLowerCase() ?? '';
  if (!data || data !== expect.expectedReportData.trim().toLowerCase()) {
    reasons.push('The report does not echo the nonce this verification asked for, so it may be an old one replayed.');
  }

  if (!report.signature?.trim()) {
    reasons.push('The report carries no signature.');
  }

  if (compareTcb(report.tcbVersion, expect.minimumTcbVersion) < 0) {
    reasons.push(`The platform reports TCB ${report.tcbVersion}, below the floor of ${expect.minimumTcbVersion}.`);
  }

  const verifier = verifiers.get(expect.kind);
  if (!verifier) {
    // The refusal that makes this file honest. There is no verifier here, so
    // there is no path through this function that trusts a host.
    reasons.push(
      `No ${expect.kind} verifier is registered, so nothing has checked this report against a hardware vendor root of trust.`,
    );
  } else {
    const signed = await verifier.verify(report);
    if (!signed.signed) reasons.push(`The vendor root refused this report: ${signed.why}`);
  }

  if (reasons.length > 0) return { trusted: false, reasons };
  return { trusted: true, measurement, root: verifier!.rootDescription };
}

function bitSet(value: bigint, bit: number): boolean {
  return ((value >> BigInt(bit)) & 1n) === 1n;
}

/**
 * Compares two dotted TCB versions.
 *
 * Rollback is refused rather than warned about: a firmware version below the
 * floor is one with a known break in it, and accepting it because it is only
 * one behind is how a fixed problem comes back.
 */
export function compareTcb(a: string, b: string): number {
  const parse = (v: string) => (v ?? '').split('.').map((p) => Number.parseInt(p, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Key release
// ---------------------------------------------------------------------------

export type KeyReleaseDecision = { release: true; measurement: string } | { release: false; why: readonly string[] };

/**
 * Whether a runtime's master key may be sent to a host.
 *
 * The one function that decides it, so a tier being enabled and a key being
 * released cannot disagree. A tier that is not in `PROVIDER_TIERS_ENABLED` is
 * refused before the report is even considered, and the requirements the tier
 * has not met are named from `TIER_REQUIREMENTS` rather than written again
 * here.
 */
export async function mayReleaseRuntimeKey(input: {
  tier: ProviderTier;
  report?: AttestationReport;
  expect?: AttestationExpectation;
}): Promise<KeyReleaseDecision> {
  const { tier, report, expect } = input;

  if (!PROVIDER_TIERS_ENABLED.includes(tier)) {
    return {
      release: false,
      why: [
        `${tier} may not hold a tenant yet.`,
        ...TIER_REQUIREMENTS[tier].map((r) => `Still required: ${r}`),
      ],
    };
  }

  if (tier !== 'CONFIDENTIAL_COMPUTE') {
    // First-party hosting seals the key on the host, which is a different
    // arrangement rather than a weaker form of this one. Saying so here keeps
    // "attested release" from being claimed for a host-sealed key.
    return {
      release: false,
      why: [
        `${tier} holds a key sealed on the host rather than released against an attestation.`,
        'Attested release is only available on the confidential tier, which is not enabled.',
      ],
    };
  }

  if (!report || !expect) {
    return { release: false, why: ['No attestation was presented, and a key is never released without one.'] };
  }

  const verdict = await attestationVerdict(report, expect);
  if (!verdict.trusted) return { release: false, why: verdict.reasons };
  return { release: true, measurement: verdict.measurement };
}

export const ATTESTATION_CAVEATS: readonly string[] = [
  'No verifier is registered in this repository, so attestationVerdict cannot return a trusted answer and mayReleaseRuntimeKey cannot release anything.',
  'The confidential tier is designed and not enabled. Hosting is first-party hardware and is never described as host-blind.',
  'A host-sealed key is readable by a host operator with root. That is the arrangement today, and calling it attested release would be false.',
  'Attestation proves what booted, not what the software does afterwards. A measured image with a flaw in it measures correctly.',
  'The field and bit positions here come from vendor specifications and have not been exercised against real hardware from this repository.',
];
