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
 * The rule is "an agent may not write an address nobody gave it", not "an agent
 * may not write addresses".
 *
 * The first version of this file assumed the reply above was invented, because
 * the trace showed the agent producing that string sixteen hours before it
 * appeared in anyone's post. It was not: the operator had written it into the
 * agent's biography, which is the obvious place for it. Reading only the policy
 * list therefore stopped an agent stating its own address and turned a rule
 * about tokens into a rule that failed ordinary conversations.
 *
 * What still has to hold is the reason the rule exists: a model asked for an
 * address it does not have will produce one anyway, correctly shaped, with no
 * signal that it is guessing. A nearly-correct address is worse than no answer,
 * because the correction arrives after the money has moved. So this rejects
 * rather than repairing or asking a person.
 */
describe('an address the agent was never given', () => {
  it('is refused when it appears nowhere in the configuration', () => {
    const result = validateOutput(REAL_REPLY, policy());
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.rule === 'unverified_address');
    expect(violation?.severity).toBe('REJECT');
    expect(violation?.message).toContain(INVENTED);
  });

  it('is allowed once the operator writes it into the persona', () => {
    // The regression this file was rewritten for. An operator who puts the
    // contract address in the biography has given the agent that address.
    const biography = `Ava is an AI17Z agent. The contract address is ${INVENTED}.`;
    const result = validateOutput(REAL_REPLY, policy(), null, biography);
    expect(result.ok).toBe(true);
    expect(result.violations.map((v) => v.rule)).not.toContain('unverified_address');
  });

  it('still refuses a different address when the persona names one', () => {
    const biography = `The contract address is ${INVENTED}.`;
    const other = '0x' + 'f'.repeat(40);
    const result = validateOutput(`Try ${other} instead`, policy(), null, biography);
    expect(result.ok).toBe(false);
    expect(result.violations.find((v) => v.rule === 'unverified_address')?.message).toContain('not one this agent was given');
  });

  it('protects an installation nobody has configured', () => {
    // Empty means "none given", which forbids all of them rather than
    // permitting all of them, so the guard works before anyone sets it up.
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

  it('does not involve itself in a conversation that has no address in it', () => {
    // The failure mode this rule must never cause. A safety rule about tokens
    // that fails a reply about installation is a rule that has stopped being
    // about tokens.
    for (const text of [
      'AI17Z runs autonomous agents on your own machine, through a browser you control.',
      "It doesn't sign you in. That part is always a person, deliberately.",
      'Open source: https://github.com/ShiftAboveCtrl/ai17z',
      'Ran it twice so the first time was not luck. 945 tests, all passing.',
      'Depends what you mean by fast. Fast to the first reply, or fast end to end.',
      'I do not know. I would rather say that than guess at it.',
      'Node 22 or newer, Docker Desktop, and Google Chrome. That is the whole list.',
      'Yes, Ollama works. Point it at your local endpoint in the provider screen.',
    ]) {
      const result = validateOutput(text, policy());
      expect(result.violations.map((v) => v.rule), text).not.toContain('unverified_address');
      expect(result.ok, text).toBe(true);
    }
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
