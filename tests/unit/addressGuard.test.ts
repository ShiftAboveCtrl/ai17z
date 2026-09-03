import { describe, expect, it } from 'vitest';
import { PolicyConfig } from '@xbam/shared/contracts';
import { validateOutput } from '@xbam/runtime';

const policy = (overrides: Record<string, unknown> = {}) => PolicyConfig.parse(overrides);

/** The address the agent actually published, and the reply it published it in. */
const INVENTED = '0x16CB7cBb26295b60DF7f4B3B39a99a9A3c585E81';
/**
 * A real Solana mint. Written out rather than invented because base58 excludes
 * 0, O, I and l, and a hand-made fixture with an l in it is not address-shaped
 * at all: the guard never sees it, the assertion passes, and the test proves
 * nothing. That is what the first version of this file did.
 */
const RECORDED = 'So11111111111111111111111111111111111111112';
const TRANSPOSED = 'So11111111111111111111111111111111111111123';
const REAL_REPLY = `Here's the contract address: ${INVENTED}. Check it against the official source before you do anything with it.`;

/**
 * On 2026-09-03 an agent with no address configured was asked "whats your ca?"
 * and answered with the string above: correctly shaped, Ethereum format, for a
 * token that is not on Ethereum, invented in full by the model and published to
 * a real person.
 *
 * Every other output rule here repairs or asks a human. This one refuses,
 * because a nearly-correct address is worse than no answer: the reply that says
 * "actually that was wrong" arrives after the money has moved.
 */
describe('an agent may not invent an address', () => {
  it('rejects the reply that actually went out', () => {
    const result = validateOutput(REAL_REPLY, policy());
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.rule === 'unverified_address');
    expect(violation?.severity).toBe('REJECT');
    expect(violation?.message).toContain(INVENTED);
  });

  it('protects an installation nobody has configured, which is the case that failed', () => {
    // No verifiedAddresses set: the default forbids every address rather than
    // permitting every address, so the guard works before anyone knows it exists.
    expect(policy().output.verifiedAddresses).toEqual([]);
    expect(validateOutput(`Send it to ${INVENTED}`, policy()).ok).toBe(false);
  });

  it('the fixtures are actually address-shaped, so the rest of this file cannot pass vacuously', () => {
    expect(validateOutput(`x ${RECORDED}`, policy()).ok).toBe(false);
    expect(validateOutput(`x ${TRANSPOSED}`, policy()).ok).toBe(false);
  });

  it('allows the address the operator actually recorded', () => {
    const result = validateOutput(
      `The contract is ${RECORDED}, and nothing else is.`,
      policy({ output: { verifiedAddresses: [RECORDED] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.violations.map((v) => v.rule)).not.toContain('unverified_address');
  });

  it('rejects one transposed character in an otherwise correct address', () => {
    // The failure that motivates rejecting rather than reviewing: a model
    // copying 44 characters from context gets them right almost every time.
    const result = validateOutput(
      `The contract is ${TRANSPOSED}.`,
      policy({ output: { verifiedAddresses: [RECORDED] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.violations.find((v) => v.rule === 'unverified_address')?.message).toContain(TRANSPOSED);
  });

  it('is case-sensitive, because capitals carry the checksum', () => {
    const real = '0x16CB7cBb26295b60DF7f4B3B39a99a9A3c585E81';
    const lowered = real.toLowerCase();
    expect(validateOutput(`Address: ${lowered}`, policy({ output: { verifiedAddresses: [real] } })).ok).toBe(false);
  });

  it('catches an address hidden in a link, where it is just as spendable', () => {
    const result = validateOutput(`Chart: https://dexscreener.com/solana/${'B'.repeat(40)}`, policy());
    expect(result.violations.map((v) => v.rule)).toContain('unverified_address');
  });

  it('reports each distinct address once, and both of two', () => {
    const a = '0x' + 'a'.repeat(40);
    const b = '0x' + 'b'.repeat(40);
    const found = validateOutput(`${a} and ${b} and ${a} again`, policy()).violations.filter(
      (v) => v.rule === 'unverified_address',
    );
    expect(found).toHaveLength(2);
  });

  it('leaves ordinary replies alone', () => {
    for (const text of [
      'I do not do price. Not being coy, I just do not do it.',
      'It is open source: https://github.com/ShiftAboveCtrl/ai17z',
      'Ran it twice so the first time was not luck. 856 tests, all passing.',
      'The answer is 0x0 for anyone counting, which is not an address.',
    ]) {
      expect(validateOutput(text, policy()).violations.map((v) => v.rule)).not.toContain('unverified_address');
    }
  });
});
