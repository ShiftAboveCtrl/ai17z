import { z } from 'zod';
import { defineCapability } from '@xbam/tools';

/**
 * What an EVM call would do, said before anybody signs it.
 *
 * The calls that move a signer's tokens, or let somebody else move them,
 * have fixed layouts: every argument is one 32-byte word. They are decoded
 * here exactly, with integer arithmetic and no ABI library, because the
 * question that matters is narrow and must not be answered approximately:
 * who could move what, and how much.
 *
 * ### What it judges
 *
 * - An approval names a spender and an amount. An amount at or near the
 *   largest integer is unlimited, and is said so.
 * - `setApprovalForAll(…, true)` hands over every token in a collection.
 * - A transfer names a recipient and an amount.
 * - Native value is reported, and judged against a ceiling when one is given.
 * - **A function it cannot read needs a person.** No blind signing: a call
 *   this cannot decode is APPROVAL_REQUIRED whatever else is true.
 *
 * When the caller says what they expect (which spenders, which recipients,
 * how much value), anything outside it is DENY with the reason. Without
 * expectations the verdict can only be ALLOW or APPROVAL_REQUIRED, because a
 * judgement against nothing cannot refuse anything.
 *
 * It signs nothing, sends nothing and holds no key. It reads call data a
 * caller already has.
 */

export const MAX_UINT256 = (1n << 256n) - 1n;
/** At or above this, an allowance is unlimited in practice: half of the largest integer. */
export const UNLIMITED_FROM = 1n << 255n;

const SELECTORS: Record<string, { kind: CallKind; words: number }> = {
  '0x095ea7b3': { kind: 'APPROVE', words: 2 }, // approve(address,uint256)
  '0x39509351': { kind: 'INCREASE_ALLOWANCE', words: 2 }, // increaseAllowance(address,uint256)
  '0xa9059cbb': { kind: 'TRANSFER', words: 2 }, // transfer(address,uint256)
  '0x23b872dd': { kind: 'TRANSFER_FROM', words: 3 }, // transferFrom(address,address,uint256)
  '0xa22cb465': { kind: 'SET_APPROVAL_FOR_ALL', words: 2 }, // setApprovalForAll(address,bool)
  '0x87517c45': { kind: 'PERMIT2_APPROVE', words: 4 }, // approve(address,address,uint160,uint48), Permit2
};

export type CallKind =
  | 'NATIVE_TRANSFER'
  | 'APPROVE'
  | 'INCREASE_ALLOWANCE'
  | 'TRANSFER'
  | 'TRANSFER_FROM'
  | 'SET_APPROVAL_FOR_ALL'
  | 'PERMIT2_APPROVE'
  | 'UNKNOWN';

export type InspectionSeverity = 'DENY' | 'NEEDS_APPROVAL' | 'NOTE';

export interface InspectionFinding {
  severity: InspectionSeverity;
  code: string;
  /** One sentence a person signing can read. */
  sentence: string;
}

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/, 'Hex, starting 0x.');
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'An EVM address: 0x and forty hex digits.');
const Amount = z.string().regex(/^[0-9]{1,78}$/, 'A whole number of base units, as a string.');

export const InspectInput = z
  .object({
    /** The contract (or person) the call goes to. */
    to: Address,
    data: Hex.default('0x'),
    /** Native value in wei, as a string. */
    value: Amount.default('0'),
    expect: z
      .object({
        /** Addresses an approval may name. */
        spenders: z.array(Address).max(20).optional(),
        /** Addresses a transfer may send to. */
        recipients: z.array(Address).max(20).optional(),
        /** The most native value the call may carry, in wei. */
        maxValue: Amount.optional(),
        /** The token contracts the call may touch. */
        tokens: z.array(Address).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InspectInput = z.infer<typeof InspectInput>;

export interface Inspection {
  verdict: 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY';
  kind: CallKind;
  selector: string | null;
  to: string;
  value: string;
  /** Decoded arguments, when the call is one this reads. Amounts as strings. */
  args: Record<string, string | boolean>;
  findings: InspectionFinding[];
}

const word = (data: string, i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
const asAddress = (w: string) => `0x${w.slice(24)}`.toLowerCase();
const asUint = (w: string) => BigInt(`0x${w}`);

export function inspectCall(raw: InspectInput): Inspection {
  const input = InspectInput.parse(raw);
  const to = input.to.toLowerCase();
  const data = input.data.toLowerCase();
  const value = BigInt(input.value);
  const expect = input.expect;
  const findings: InspectionFinding[] = [];
  const args: Record<string, string | boolean> = {};
  const lower = (list: string[] | undefined) => list?.map((a) => a.toLowerCase());
  const spenders = lower(expect?.spenders);
  const recipients = lower(expect?.recipients);
  const tokens = lower(expect?.tokens);

  if (value > 0n) {
    findings.push({ severity: 'NOTE', code: 'NATIVE_VALUE', sentence: `This sends ${value} wei of the native coin with the call.` });
    if (expect?.maxValue !== undefined && value > BigInt(expect.maxValue)) {
      findings.push({ severity: 'DENY', code: 'VALUE_ABOVE_LIMIT', sentence: `It sends ${value} wei, more than the ${expect.maxValue} wei allowed.` });
    }
  }

  let kind: CallKind;
  let selector: string | null = null;
  if (data === '0x') {
    kind = 'NATIVE_TRANSFER';
    if (recipients && !recipients.includes(to)) {
      findings.push({ severity: 'DENY', code: 'UNEXPECTED_RECIPIENT', sentence: `It sends value to ${to}, which is not an expected recipient.` });
    }
  } else if (data.length < 10 || (data.length - 10) % 64 !== 0) {
    kind = 'UNKNOWN';
    selector = data.length >= 10 ? data.slice(0, 10) : null;
    // A call whose arguments are not whole words is malformed or packed in a
    // way a signer cannot check, and either way is not something to sign.
    findings.push({ severity: 'DENY', code: 'MALFORMED_CALL_DATA', sentence: 'The call data is not a selector followed by whole 32-byte words.' });
  } else {
    selector = data.slice(0, 10);
    const known = SELECTORS[selector];
    if (!known || (data.length - 10) / 64 !== known.words) {
      kind = 'UNKNOWN';
      findings.push({
        severity: 'NEEDS_APPROVAL',
        code: 'UNREAD_FUNCTION',
        sentence: `This calls a function (${selector}) this cannot read, so a person has to decide. Nothing is signed blind.`,
      });
    } else {
      kind = known.kind;
      if (tokens && kind !== 'PERMIT2_APPROVE' && !tokens.includes(to)) {
        findings.push({ severity: 'DENY', code: 'UNEXPECTED_TOKEN', sentence: `It calls ${to}, which is not one of the expected token contracts.` });
      }
      switch (kind) {
        case 'APPROVE':
        case 'INCREASE_ALLOWANCE': {
          const spender = asAddress(word(data, 0));
          const amount = asUint(word(data, 1));
          args.spender = spender;
          args.amount = amount.toString();
          if (amount >= UNLIMITED_FROM) {
            findings.push({ severity: 'NEEDS_APPROVAL', code: 'UNLIMITED_APPROVAL', sentence: `It lets ${spender} move an unlimited amount of this token, for as long as the approval stands.` });
          } else if (amount > 0n) {
            findings.push({ severity: 'NOTE', code: 'APPROVAL', sentence: `It lets ${spender} move up to ${amount} base units of this token.` });
          }
          if (spenders && !spenders.includes(spender)) {
            findings.push({ severity: 'DENY', code: 'UNEXPECTED_SPENDER', sentence: `It approves ${spender}, which is not an expected spender.` });
          }
          break;
        }
        case 'SET_APPROVAL_FOR_ALL': {
          const operator = asAddress(word(data, 0));
          const approved = asUint(word(data, 1)) !== 0n;
          args.operator = operator;
          args.approved = approved;
          if (approved) {
            findings.push({ severity: 'NEEDS_APPROVAL', code: 'APPROVE_ALL', sentence: `It lets ${operator} move every token this collection holds for the signer.` });
            if (spenders && !spenders.includes(operator)) {
              findings.push({ severity: 'DENY', code: 'UNEXPECTED_SPENDER', sentence: `It approves ${operator}, which is not an expected operator.` });
            }
          }
          break;
        }
        case 'PERMIT2_APPROVE': {
          const token = asAddress(word(data, 0));
          const spender = asAddress(word(data, 1));
          const amount = asUint(word(data, 2));
          const expiration = asUint(word(data, 3));
          Object.assign(args, { token, spender, amount: amount.toString(), expiration: expiration.toString() });
          if (amount >= (1n << 159n)) {
            findings.push({ severity: 'NEEDS_APPROVAL', code: 'UNLIMITED_APPROVAL', sentence: `Through Permit2 it lets ${spender} move an unlimited amount of ${token}.` });
          }
          if (spenders && !spenders.includes(spender)) {
            findings.push({ severity: 'DENY', code: 'UNEXPECTED_SPENDER', sentence: `It approves ${spender}, which is not an expected spender.` });
          }
          if (tokens && !tokens.includes(token)) {
            findings.push({ severity: 'DENY', code: 'UNEXPECTED_TOKEN', sentence: `It approves ${token}, which is not one of the expected tokens.` });
          }
          break;
        }
        case 'TRANSFER':
        case 'TRANSFER_FROM': {
          const offset = kind === 'TRANSFER_FROM' ? 1 : 0;
          if (kind === 'TRANSFER_FROM') args.from = asAddress(word(data, 0));
          const recipient = asAddress(word(data, offset));
          const amount = asUint(word(data, offset + 1));
          args.recipient = recipient;
          args.amount = amount.toString();
          findings.push({ severity: 'NOTE', code: 'TOKEN_TRANSFER', sentence: `It moves ${amount} base units of this token to ${recipient}.` });
          if (recipients && !recipients.includes(recipient)) {
            findings.push({ severity: 'DENY', code: 'UNEXPECTED_RECIPIENT', sentence: `It sends tokens to ${recipient}, which is not an expected recipient.` });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const verdict = findings.some((f) => f.severity === 'DENY')
    ? 'DENY'
    : findings.some((f) => f.severity === 'NEEDS_APPROVAL')
      ? 'APPROVAL_REQUIRED'
      : 'ALLOW';
  return { verdict, kind, selector, to, value: value.toString(), args, findings };
}

/** The inspector as a capability, so an agent, the shared runtime and Studio all ask one implementation. */
export const transactionInspectCapability = defineCapability({
  id: 'transaction.inspect',
  name: 'Say what an EVM call would do before it is signed',
  description:
    'Reads call data an agent or a person is about to sign and says who could move what: approvals (and whether they are unlimited), ' +
    'approve-all, transfers, Permit2 approvals and native value. Give the addresses and value you expect and anything outside them is refused. ' +
    'A function it cannot read always needs a person. Signs and sends nothing.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: InspectInput,
  output: z.object({
    verdict: z.enum(['ALLOW', 'APPROVAL_REQUIRED', 'DENY']),
    kind: z.string(),
    selector: z.string().nullable(),
    to: z.string(),
    value: z.string(),
    args: z.record(z.union([z.string(), z.boolean()])),
    findings: z.array(z.object({ severity: z.enum(['DENY', 'NEEDS_APPROVAL', 'NOTE']), code: z.string(), sentence: z.string() })),
  }),
  modelCallable: true,
  timeoutMs: 5_000,
  async run(input) {
    return inspectCall(input);
  },
});
