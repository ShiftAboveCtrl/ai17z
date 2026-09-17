import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  PolicyConfig,
  RESPONSE_SPEEDS,
  RESPONSE_SPEED_LEVERS,
  RESPONSE_SPEED_PROFILES,
} from '@xbam/shared/contracts';

/**
 * A speed setting that changes nothing.
 *
 * That is the failure this file exists to prevent, and it is a likely one: the
 * cheapest way to ship a Fast/Balanced/Thorough control is three radio buttons
 * writing a string nothing reads, and it looks finished. An owner then moves it,
 * measures no difference, and concludes the product is slow anyway.
 *
 * So the profiles are held to two properties. Every setting differs from every
 * other in at least one real lever, and every lever named here is one the
 * runtime actually consumes. The second half is enforced by the runtime tests
 * that pass each profile through the pipeline; this half is the arithmetic.
 */
describe('response speed', () => {
  it('leaves an existing agent exactly where it was', () => {
    // The field arriving must not change how anything already installed
    // answers. BALANCED is what every agent did before it existed.
    expect(DEFAULT_POLICY.responseSpeed).toBe('BALANCED');
    expect(PolicyConfig.parse({}).responseSpeed).toBe('BALANCED');
  });

  it('describes every setting it offers', () => {
    for (const speed of RESPONSE_SPEEDS) {
      const profile = RESPONSE_SPEED_PROFILES[speed];
      expect(profile, `${speed} has no profile`).toBeDefined();
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.blurb.length).toBeGreaterThan(20);
    }
  });

  it('makes every setting differ from every other in something the runtime reads', () => {
    for (const a of RESPONSE_SPEEDS) {
      for (const b of RESPONSE_SPEEDS) {
        if (a === b) continue;
        const differs = RESPONSE_SPEED_LEVERS.some(
          (lever) => RESPONSE_SPEED_PROFILES[a][lever] !== RESPONSE_SPEED_PROFILES[b][lever],
        );
        expect(differs, `${a} and ${b} do the same thing, so one of them is a label`).toBe(true);
      }
    }
  });

  it('gives up model calls going faster and never gives up a check', () => {
    const fast = RESPONSE_SPEED_PROFILES.FAST;
    const balanced = RESPONSE_SPEED_PROFILES.BALANCED;
    const thorough = RESPONSE_SPEED_PROFILES.THOROUGH;

    // Fast is the only one that skips a model call.
    expect(fast.voiceRewrite).toBe(false);
    expect(fast.modelPlansResearch).toBe(false);
    expect(balanced.voiceRewrite).toBe(true);
    expect(thorough.voiceRewrite).toBe(true);

    // Thorough differs from balanced by waiting longer for the plan, which is
    // the measured difference between keeping a quarter of them and most.
    expect(thorough.planTimeoutMs).toBeGreaterThan(balanced.planTimeoutMs);

    // And nothing here reaches the ceiling on mid-answer lookups except to
    // lower it: four is what the loop already allowed.
    expect(fast.capabilitySteps).toBeLessThan(balanced.capabilitySteps);
    expect(balanced.capabilitySteps).toBe(thorough.capabilitySteps);
  });

  it('never names a lever that is not on a profile', () => {
    for (const lever of RESPONSE_SPEED_LEVERS) {
      for (const speed of RESPONSE_SPEEDS) {
        expect(RESPONSE_SPEED_PROFILES[speed][lever], `${speed}.${lever}`).toBeDefined();
      }
    }
  });
});
