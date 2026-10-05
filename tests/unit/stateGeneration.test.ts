import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ROLLBACK_CAVEATS,
  advanceStateGeneration,
  judgeStateGeneration,
  mayActOnState,
  registerGenerationWitness,
  resetGenerationWitnessForTest,
  stateDigestOf,
  witnessReadiness,
  type GenerationWitness,
  type StateMark,
} from '@xbam/runtime';

/**
 * The half confidential memory does not solve.
 *
 * An operator who keeps last week's encrypted snapshot can restore it, and the
 * runtime that boots decrypts it perfectly and attests perfectly. Nothing is
 * forged. The whole test is whether a number that only goes up notices, and
 * whether the thing holding that number is somewhere the host is not.
 */

/** A witness that refuses to go backwards, which is its only real job. */
function fakeWitness(seed: Record<string, number> = {}): GenerationWitness & { seen: Record<string, number> } {
  const seen: Record<string, number> = { ...seed };
  return {
    id: 'fake-witness',
    seen,
    async highest(runtimeId) {
      return runtimeId in seen ? seen[runtimeId]! : null;
    },
    async advance(runtimeId, generation) {
      const current = seen[runtimeId] ?? 0;
      if (generation <= current) return { accepted: false, highest: current };
      seen[runtimeId] = generation;
      return { accepted: true, highest: generation };
    },
  };
}

const mark = (over: Partial<StateMark> = {}): StateMark => ({
  runtimeId: 'rt-1',
  generation: 12,
  at: new Date().toISOString(),
  stateDigest: stateDigestOf(['memories:40', 'actions:11']),
  proof: 'signed-by-the-runtime',
  ...over,
});

beforeEach(() => resetGenerationWitnessForTest());
afterEach(() => resetGenerationWitnessForTest());

describe('with no witness', () => {
  it('says plainly that nobody could tell', () => {
    const out = witnessReadiness();
    expect(out.ready).toBe(false);
    expect(out.detail).toContain('went backwards with the state');
  });

  it('reports UNWITNESSED rather than treating it as fine', async () => {
    // Not rolled back and nobody could tell are different sentences.
    const out = await judgeStateGeneration({ mark: mark() });
    expect(out.verdict).toBe('UNWITNESSED');
  });

  it('still lets the runtime act, and says the gap is reported', async () => {
    // Refusing would be a security feature that stops the product working
    // wherever a witness has not been deployed.
    const out = mayActOnState(await judgeStateGeneration({ mark: mark() }));
    expect(out.act).toBe(true);
    expect(out.why).toContain('reported rather than hidden');
  });

  it('advances nothing', async () => {
    const out = await advanceStateGeneration(mark());
    expect(out.advanced).toBe(false);
  });
});

describe('with a witness the host does not control', () => {
  it('calls a new runtime a first boot', async () => {
    registerGenerationWitness(fakeWitness());
    const out = await judgeStateGeneration({ mark: mark() });
    expect(out.verdict).toBe('FIRST_BOOT');
    expect(mayActOnState(out).act).toBe(true);
  });

  it('calls state at or above the witnessed generation current', async () => {
    registerGenerationWitness(fakeWitness({ 'rt-1': 12 }));
    const same = await judgeStateGeneration({ mark: mark({ generation: 12 }) });
    expect(same.verdict).toBe('CURRENT');
    const newer = await judgeStateGeneration({ mark: mark({ generation: 13 }) });
    expect(newer.verdict).toBe('CURRENT');
    // A reboot is not a rollback.
    expect(mayActOnState(same).act).toBe(true);
  });

  it('catches an older snapshot that decrypts and attests perfectly', async () => {
    registerGenerationWitness(fakeWitness({ 'rt-1': 40 }));
    const out = await judgeStateGeneration({ mark: mark({ generation: 12 }) });
    expect(out.verdict).toBe('ROLLED_BACK');
    if (out.verdict !== 'ROLLED_BACK') return;
    expect(out.witnessed).toBe(40);
    expect(out.found).toBe(12);
    expect(out.detail).toContain('Nothing was forged');
  });

  it('stops a rolled-back runtime acting', async () => {
    /*
      An agent acting on a world it half remembers republishes things it has
      already said and re-answers people who have moved on.
    */
    registerGenerationWitness(fakeWitness({ 'rt-1': 40 }));
    const out = mayActOnState(await judgeStateGeneration({ mark: mark({ generation: 12 }) }));
    expect(out.act).toBe(false);
    expect(out.why).toContain('until somebody decides which this is');
  });
});

describe('an owner asking for an older state', () => {
  it('allows it when the owner named that exact generation', async () => {
    registerGenerationWitness(fakeWitness({ 'rt-1': 40 }));
    const out = await judgeStateGeneration({ mark: mark({ generation: 12 }), ownerApprovedRestoreTo: 12 });
    expect(out.verdict).toBe('OWNER_RESTORE');
    expect(mayActOnState(out).act).toBe(true);
  });

  it('refuses an approval for a different generation than the state has', async () => {
    // Approval without a generation is permission for any older state,
    // including one the owner never saw.
    registerGenerationWitness(fakeWitness({ 'rt-1': 40 }));
    const out = await judgeStateGeneration({ mark: mark({ generation: 12 }), ownerApprovedRestoreTo: 30 });
    expect(out.verdict).toBe('ROLLED_BACK');
  });

  it('records what it went back to and what the newest was', async () => {
    registerGenerationWitness(fakeWitness({ 'rt-1': 40 }));
    const out = await judgeStateGeneration({ mark: mark({ generation: 12 }), ownerApprovedRestoreTo: 12 });
    if (out.verdict !== 'OWNER_RESTORE') throw new Error('expected an owner restore');
    expect(out.detail).toContain('generation 12');
    expect(out.detail).toContain('generation 40 was the newest');
  });
});

describe('advancing', () => {
  it('moves the witness forward on a durable commit', async () => {
    const w = fakeWitness({ 'rt-1': 12 });
    registerGenerationWitness(w);
    const out = await advanceStateGeneration(mark({ generation: 13 }));
    expect(out.advanced).toBe(true);
    expect(w.seen['rt-1']).toBe(13);
  });

  it('reports a refusal rather than assuming agreement', async () => {
    /*
      The interesting case: a witness that refused means another runtime may
      believe it is the live copy, which is the two-copies problem arriving
      through the back door.
    */
    registerGenerationWitness(fakeWitness({ 'rt-1': 40 }));
    const out = await advanceStateGeneration(mark({ generation: 13 }));
    expect(out.advanced).toBe(false);
    if (out.advanced) return;
    expect(out.why).toContain('may believe it is the live copy');
    expect(out.highest).toBe(40);
  });
});

describe('the state digest', () => {
  it('does not depend on the order a caller listed things in', () => {
    expect(stateDigestOf(['a', 'b'])).toBe(stateDigestOf(['b', 'a']));
  });

  it('changes when the state does', () => {
    expect(stateDigestOf(['memories:40'])).not.toBe(stateDigestOf(['memories:41']));
  });

  it('does not run two parts together', () => {
    // `ab` and `a`,`b` must not digest the same.
    expect(stateDigestOf(['ab'])).not.toBe(stateDigestOf(['a', 'b']));
  });
});

describe('what this says about itself', () => {
  it('says confidential memory does not solve it', () => {
    expect(ROLLBACK_CAVEATS.join(' ')).toContain('Confidential memory does not solve durable-state rollback');
  });

  it('says the witness must be outside the host', () => {
    expect(ROLLBACK_CAVEATS.join(' ')).toContain('somewhere the host does not control');
  });

  it('says nothing is currently detectable', () => {
    expect(ROLLBACK_CAVEATS.join(' ')).toContain('nothing is currently detectable');
  });
});
