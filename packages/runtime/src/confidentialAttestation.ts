import {
  AZURE_COMPLIANT_CVM,
  AZURE_SEVSNP_ATTESTATION_TYPE,
  CONFIDENTIAL_PROVIDERS_ENABLED,
  CONFIDENTIAL_REQUIREMENTS,
  CONFIDENTIAL_SPACE_DEBUG_OFF,
  CONFIDENTIAL_SPACE_HARDWARE,
  confidentialProviderMayHoldTenants,
  type ConfidentialEvidence,
  type ConfidentialProvider,
  type TeeKind,
} from '@xbam/shared';

/**
 * Judging a confidential runtime's evidence, and refusing it.
 *
 * `hostAttestation.ts` is the vendor-root path for hardware AI17Z holds
 * itself. This is the cloud path, where a provider's attestation service has
 * already verified the hardware and hands back claims. The two are deliberately
 * separate files: they trust different things, and a function that accepted
 * either would be a function whose refusals nobody could reason about.
 *
 * Every judgement here is a refusal unless four things hold, and the fourth is
 * the one the documentation makes easy to miss.
 *
 * The provider must be enabled. `CONFIDENTIAL_PROVIDERS_ENABLED` is empty, so
 * nothing passes today, and that is the honest state rather than a gap.
 *
 * Debug must be off. A guest somebody can attach a debugger to measures
 * correctly and then changes, so a measurement from a debuggable guest proves
 * nothing at all.
 *
 * The nonce must be the one this verification asked for. A token is a statement
 * about a moment, and a token that does not echo the challenge is a statement
 * about some other moment.
 *
 * And the evidence must bind to **this runtime image**, not merely to a
 * compliant platform. Azure's documented release policy asserts
 * `x-ms-attestation-type` and `x-ms-compliance-status`, which say the platform
 * is a compliant SEV-SNP confidential VM and say nothing about what is running
 * inside it. Accepting that alone would let a host boot a modified AI17Z on
 * compliant hardware and receive the tenant's keys, which is precisely the
 * thing this is for.
 */

// ---------------------------------------------------------------------------
// What is expected
// ---------------------------------------------------------------------------

export interface ConfidentialExpectation {
  provider: ConfidentialProvider;
  tee: TeeKind;
  /** The nonce this verification issued. Anything else is a replay. */
  nonce: string;
  /**
   * Runtime images whose measurement may receive tenant keys.
   *
   * On Google this is a container image digest; on Azure it is a measured-boot
   * PCR value. Either way it is a list rather than one value, because a
   * legitimate runtime update has to be possible without the previous version
   * becoming unbootable mid-rollout, and it is signed where it is stored (see
   * `runtimeMeasurement.ts`) so the list itself is not something a host can
   * add to.
   */
  allowedMeasurements: readonly string[];
  /**
   * How old a token may be. Short, because the only thing a nonce cannot
   * catch is a token minted legitimately and held.
   */
  maxAgeMs: number;
  /** Where Azure's token must have come from. Pinned, never read from the token. */
  azureAuthority?: string;
}

export type ConfidentialVerdict =
  | { trusted: true; measurement: string; tee: TeeKind; detail: string }
  | { trusted: false; reasons: readonly string[] };

/**
 * Whether this evidence may unlock a tenant's keys.
 *
 * Every reason rather than the first: an operator looking at a refused runtime
 * wants the shape of the problem, and a second attempt to find the second
 * reason is a second chance to decide the first one did not matter.
 */
export function judgeConfidentialEvidence(
  evidence: ConfidentialEvidence,
  expect: ConfidentialExpectation,
  now: Date = new Date(),
): ConfidentialVerdict {
  const reasons: string[] = [];

  if (evidence.provider !== expect.provider) {
    reasons.push(`This is ${evidence.provider} evidence and ${expect.provider} was asked for.`);
  }

  if (!confidentialProviderMayHoldTenants(expect.provider)) {
    reasons.push(
      `${expect.provider} may not hold a tenant yet.`,
      ...CONFIDENTIAL_REQUIREMENTS[expect.provider].map((r) => `Still required: ${r}`),
    );
  }

  const issuedAt = Date.parse(evidence.claims.issuedAt);
  if (!Number.isFinite(issuedAt)) {
    reasons.push('The token has no readable issue time, so its age cannot be bounded.');
  } else {
    const ageMs = now.getTime() - issuedAt;
    if (ageMs < 0) reasons.push('The token claims to have been issued after now.');
    else if (ageMs > expect.maxAgeMs) {
      reasons.push(`The token is ${Math.round(ageMs / 1000)}s old and ${Math.round(expect.maxAgeMs / 1000)}s is the limit.`);
    }
  }

  if (!evidence.claims.nonce || evidence.claims.nonce !== expect.nonce) {
    // The one thing that makes a token about now rather than about some
    // earlier moment somebody kept.
    reasons.push('The token does not echo the nonce this verification asked for, so it may be replayed.');
  }

  let measurement = '';
  let tee: TeeKind = expect.tee;

  if (evidence.provider === 'AZURE') {
    const claims = evidence.claims;
    if (expect.azureAuthority && claims.authority !== expect.azureAuthority) {
      // Pinned at configuration time. An authority read out of the token is
      // an authority the token's author chose.
      reasons.push(`The token names ${claims.authority} and ${expect.azureAuthority} is the pinned authority.`);
    }
    if (claims.isolationTee.attestationType !== AZURE_SEVSNP_ATTESTATION_TYPE) {
      reasons.push(
        `x-ms-isolation-tee.x-ms-attestation-type is ${claims.isolationTee.attestationType} rather than ${AZURE_SEVSNP_ATTESTATION_TYPE}, so this is not a confidential VM and Secure Key Release would release to a Trusted Launch VM just as happily.`,
      );
    }
    if (claims.isolationTee.complianceStatus !== AZURE_COMPLIANT_CVM) {
      reasons.push(`x-ms-isolation-tee.x-ms-compliance-status is ${claims.isolationTee.complianceStatus} rather than ${AZURE_COMPLIANT_CVM}.`);
    }
    /*
      The claim the documented example does not have. Those two claims together
      say the platform is a compliant confidential VM; they say nothing about
      the image running on it. Without a guest measurement, a host could boot a
      modified AI17Z on compliant hardware and the policy would be satisfied.
    */
    const pcrs = claims.attestedPcrValues ?? {};
    const quoted = Object.values(pcrs).filter(Boolean);
    if (quoted.length === 0) {
      reasons.push(
        'The token carries no measured-boot PCR values, so it binds to a compliant platform and not to a runtime. A policy asserting only the two documented claims would accept a modified AI17Z on compliant hardware.',
      );
    } else {
      const matched = quoted.find((v) => expect.allowedMeasurements.includes(v));
      if (!matched) {
        reasons.push('No measured-boot PCR value matches a runtime measurement AI17Z published.');
      } else {
        measurement = matched;
      }
    }
    tee = 'AMD_SEV_SNP';
  } else {
    const claims = evidence.claims;
    const mapped = CONFIDENTIAL_SPACE_HARDWARE[claims.hardwareModel];
    if (!mapped) {
      reasons.push(`assertion.hwmodel is ${claims.hardwareModel}, which is not a confidential technology this knows.`);
    } else if (mapped !== expect.tee) {
      reasons.push(`assertion.hwmodel says ${mapped} and ${expect.tee} was asked for.`);
    } else {
      tee = mapped;
    }
    if (claims.debugStatus !== CONFIDENTIAL_SPACE_DEBUG_OFF) {
      // A debuggable guest measures correctly and then changes, so the
      // measurement proves nothing.
      reasons.push(
        `assertion.dbgstat is ${claims.debugStatus} rather than ${CONFIDENTIAL_SPACE_DEBUG_OFF}, so this guest can be attached to and its measurement proves nothing.`,
      );
    }
    if (!claims.imageDigest) {
      reasons.push('assertion.submods.container.image_digest is absent, so nothing identifies the runtime.');
    } else if (!expect.allowedMeasurements.includes(claims.imageDigest)) {
      reasons.push('The workload image digest is not one AI17Z published and can reproduce.');
    } else {
      measurement = claims.imageDigest;
    }
    if (!claims.softwareVersion) {
      reasons.push('assertion.swversion is absent, so the Confidential Space image version is unknown.');
    }
  }

  if (reasons.length > 0) return { trusted: false, reasons };
  return {
    trusted: true,
    measurement,
    tee,
    detail: `${evidence.provider} evidence bound to measurement ${measurement.slice(0, 24)} on ${tee}, debug off, nonce matched.`,
  };
}

/**
 * Whether a key may be released to this runtime.
 *
 * One function, so a provider being enabled and a key being released cannot
 * disagree. **The host never receives the key**: release is to the attested
 * workload, which is the whole architecture in one sentence, and this returns
 * a decision rather than any key material so there is nothing here to log.
 */
export type ReleaseDecision =
  | { release: true; measurement: string; detail: string }
  | { release: false; why: readonly string[] };

export function mayReleaseToConfidentialRuntime(input: {
  evidence: ConfidentialEvidence;
  expect: ConfidentialExpectation;
  now?: Date;
}): ReleaseDecision {
  if (CONFIDENTIAL_PROVIDERS_ENABLED.length === 0) {
    return {
      release: false,
      why: [
        'No confidential provider is enabled, so nothing can be released to one.',
        'Enabling one needs an attestation verified against real hardware and a key released to an attested runtime and refused to a debug-enabled one, demonstrated rather than designed.',
      ],
    };
  }
  const verdict = judgeConfidentialEvidence(input.evidence, input.expect, input.now);
  if (!verdict.trusted) return { release: false, why: verdict.reasons };
  return {
    release: true,
    measurement: verdict.measurement,
    detail: `Released to the attested runtime. ${verdict.detail}`,
  };
}

/**
 * What a hosted runtime may be described as, given what has been proved.
 *
 * Here rather than in a document because the words are a product surface, and
 * the ones on the left are the ones somebody reaches for when a screen needs
 * filling.
 */
export const FORBIDDEN_UNTIL_PROVEN: readonly { phrase: string; needs: string }[] = [
  { phrase: 'host-blind', needs: 'a key released only against an attestation, verified against real hardware.' },
  {
    phrase: 'the operator cannot read your data',
    needs: 'a key released only against an attestation, and a demonstration that a modified or debug-enabled runtime is refused that key.',
  },
  {
    phrase: 'zero-knowledge',
    needs: 'an architecture where nothing decrypts outside the tenant, which a browser stream relayed by a control plane is not.',
  },
  {
    phrase: 'end-to-end encrypted',
    needs: 'both ends holding the keys and nothing in between able to read, which a frame rendered on a host and relayed through a control plane is not.',
  },
  { phrase: 'confidential', needs: 'hardware-backed confidential compute. A container is not, a normal VM is not, and a microVM is not against the host administrator.' },
];

/** Whether a sentence about hosting claims more than has been proved. */
export function describesMoreThanProven(sentence: string): { ok: true } | { ok: false; phrase: string; needs: string } {
  const text = sentence.toLowerCase();
  for (const entry of FORBIDDEN_UNTIL_PROVEN) {
    if (!text.includes(entry.phrase)) continue;
    // Enabled providers are the only thing that could make one of these true.
    if (CONFIDENTIAL_PROVIDERS_ENABLED.length === 0) return { ok: false, phrase: entry.phrase, needs: entry.needs };
  }
  return { ok: true };
}
