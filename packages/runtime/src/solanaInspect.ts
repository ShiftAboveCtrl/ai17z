import { z } from 'zod';
import { defineCapability } from '@xbam/tools';

/**
 * What a Solana transaction would do, said before anybody signs it.
 *
 * Parses the serialized transaction itself, legacy or version 0, and reads
 * the instructions of the programs whose effect on a signer is unambiguous:
 * the System program's transfer and the SPL Token program's transfer,
 * transfer-checked, approve and approve-checked. Everything about them is
 * fixed-width little-endian, so they are decoded exactly.
 *
 * **Anything it cannot read needs a person.** A program not on its short
 * list, an instruction it does not know, or an account that comes from an
 * address lookup table (which cannot be resolved without asking the chain)
 * is never treated as harmless. Misidentifying a program can therefore only
 * make the answer more cautious, never less.
 *
 * Signs nothing, sends nothing, holds no key, and asks nothing of a chain.
 */

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** A fee-only instruction: it changes what the transaction pays, not what it moves. */
const QUIET_PROGRAMS = new Set([COMPUTE_BUDGET]);
const U64_MAX = (1n << 64n) - 1n;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get offset() {
    return this.at;
  }
  u8(): number {
    if (this.at >= this.bytes.length) throw new Error('The transaction ends early.');
    return this.bytes[this.at++]!;
  }
  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new Error('The transaction ends early.');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** Solana's compact-u16 length prefix. */
  compact(): number {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = this.u8();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
    }
    throw new Error('A length in the transaction is malformed.');
  }
  done(): boolean {
    return this.at === this.bytes.length;
  }
}

const u64le = (b: Uint8Array, offset: number) => {
  let n = 0n;
  for (let i = 7; i >= 0; i -= 1) n = (n << 8n) + BigInt(b[offset + i]!);
  return n;
};
const u32le = (b: Uint8Array, offset: number) => b[offset]! | (b[offset + 1]! << 8) | (b[offset + 2]! << 16) | (b[offset + 3]! << 24);

export const SolanaInspectInput = z
  .object({
    /** The serialized transaction, base64, as a wallet would be handed it. */
    transaction: z.string().min(4).max(8_000).regex(/^[A-Za-z0-9+/=]+$/, 'Base64.'),
    expect: z
      .object({
        feePayer: z.string().min(32).max(44).optional(),
        recipients: z.array(z.string().min(32).max(44)).max(20).optional(),
        delegates: z.array(z.string().min(32).max(44)).max(20).optional(),
        /** The most lamports the System program may move in total. */
        maxLamports: z.string().regex(/^[0-9]{1,20}$/).optional(),
        programs: z.array(z.string().min(32).max(44)).max(20).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SolanaInspectInput = z.infer<typeof SolanaInspectInput>;

export interface SolanaFinding {
  severity: 'DENY' | 'NEEDS_APPROVAL' | 'NOTE';
  code: string;
  sentence: string;
}

export interface SolanaInspection {
  verdict: 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY';
  version: 'legacy' | 'v0';
  feePayer: string | null;
  signaturesRequired: number;
  instructions: { program: string; kind: string; args: Record<string, string> }[];
  findings: SolanaFinding[];
}

export function inspectSolanaTransaction(raw: SolanaInspectInput): SolanaInspection {
  const input = SolanaInspectInput.parse(raw);
  const findings: SolanaFinding[] = [];
  const instructions: SolanaInspection['instructions'] = [];
  const expect = input.expect;
  const deny = (code: string, sentence: string) => findings.push({ severity: 'DENY', code, sentence });
  const ask = (code: string, sentence: string) => findings.push({ severity: 'NEEDS_APPROVAL', code, sentence });
  const note = (code: string, sentence: string) => findings.push({ severity: 'NOTE', code, sentence });

  let version: 'legacy' | 'v0' = 'legacy';
  let feePayer: string | null = null;
  let signaturesRequired = 0;
  try {
    const r = new Reader(Uint8Array.from(Buffer.from(input.transaction, 'base64')));
    const signatures = r.compact();
    r.take(signatures * 64);
    const first = r.u8();
    let header0 = first;
    if (first & 0x80) {
      if ((first & 0x7f) !== 0) throw new Error(`Message version ${first & 0x7f} is not one this reads.`);
      version = 'v0';
      header0 = r.u8();
    }
    signaturesRequired = header0;
    r.u8(); // read-only signed accounts
    r.u8(); // read-only unsigned accounts
    const keyCount = r.compact();
    const keys: string[] = [];
    for (let i = 0; i < keyCount; i += 1) keys.push(base58(r.take(32)));
    r.take(32); // recent blockhash
    feePayer = keys[0] ?? null;
    const instructionCount = r.compact();
    const raws: { program: number; accounts: number[]; data: Uint8Array }[] = [];
    for (let i = 0; i < instructionCount; i += 1) {
      const program = r.u8();
      const accountCount = r.compact();
      const accounts = Array.from(r.take(accountCount));
      const data = r.take(r.compact());
      raws.push({ program, accounts, data });
    }
    if (version === 'v0') {
      // Each table: its address, then the writable and read-only indexes it
      // lends. The accounts they resolve to are not knowable offline, which
      // is why any instruction that uses one needs a person below.
      const tables = r.compact();
      for (let t = 0; t < tables; t += 1) {
        r.take(32);
        r.take(r.compact());
        r.take(r.compact());
      }
    }
    // Trailing bytes are a transaction this does not understand.
    if (!r.done()) throw new Error('There are bytes after the message.');

    const key = (i: number) => keys[i] ?? null;
    if (expect?.feePayer && feePayer !== expect.feePayer) {
      deny('UNEXPECTED_FEE_PAYER', `The fee payer is ${feePayer}, not ${expect.feePayer}.`);
    }
    let lamports = 0n;
    for (const ix of raws) {
      const program = key(ix.program);
      if (program === null) {
        ask('PROGRAM_FROM_LOOKUP_TABLE', 'An instruction calls a program named only through an address lookup table, which cannot be checked here.');
        continue;
      }
      if (expect?.programs && !expect.programs.includes(program) && !QUIET_PROGRAMS.has(program)) {
        deny('UNEXPECTED_PROGRAM', `It calls ${program}, which is not one of the expected programs.`);
      }
      const unresolved = ix.accounts.some((a) => a >= keys.length);
      if (program === SYSTEM_PROGRAM && ix.data.length === 12 && u32le(ix.data, 0) === 2) {
        const amount = u64le(ix.data, 4);
        const from = key(ix.accounts[0] ?? 255);
        const to = key(ix.accounts[1] ?? 255);
        lamports += amount;
        instructions.push({ program, kind: 'SYSTEM_TRANSFER', args: { from: from ?? '?', to: to ?? '?', lamports: amount.toString() } });
        if (to === null) ask('RECIPIENT_FROM_LOOKUP_TABLE', 'A transfer goes to an account from a lookup table, which cannot be checked here.');
        else if (expect?.recipients && !expect.recipients.includes(to)) deny('UNEXPECTED_RECIPIENT', `It sends lamports to ${to}, which is not an expected recipient.`);
        note('NATIVE_TRANSFER', `It moves ${amount} lamports to ${to ?? 'an account it cannot name'}.`);
      } else if (program === TOKEN_PROGRAM && ix.data.length >= 9 && [3, 4, 12, 13].includes(ix.data[0]!)) {
        const tag = ix.data[0]!;
        const amount = u64le(ix.data, 1);
        const kind = { 3: 'TOKEN_TRANSFER', 4: 'TOKEN_APPROVE', 12: 'TOKEN_TRANSFER_CHECKED', 13: 'TOKEN_APPROVE_CHECKED' }[tag]!;
        // Transfer: source, destination, owner. Checked: source, mint, destination, owner.
        // Approve: source, delegate, owner. Checked: source, mint, delegate, owner.
        const checked = tag === 12 || tag === 13;
        const target = key(ix.accounts[checked ? 2 : 1] ?? 255);
        const args: Record<string, string> = { amount: amount.toString(), [tag === 3 || tag === 12 ? 'destination' : 'delegate']: target ?? '?' };
        if (checked) args.mint = key(ix.accounts[1] ?? 255) ?? '?';
        instructions.push({ program, kind, args });
        if (target === null) {
          ask('ACCOUNT_FROM_LOOKUP_TABLE', 'A token instruction names an account from a lookup table, which cannot be checked here.');
        } else if (tag === 4 || tag === 13) {
          if (amount === U64_MAX) ask('UNLIMITED_APPROVAL', `It lets ${target} move an unlimited amount of this token.`);
          else note('TOKEN_APPROVAL', `It lets ${target} move up to ${amount} base units of this token.`);
          if (expect?.delegates && !expect.delegates.includes(target)) deny('UNEXPECTED_DELEGATE', `It approves ${target}, which is not an expected delegate.`);
        } else {
          note('TOKEN_TRANSFER', `It moves ${amount} base units of a token to the account ${target}.`);
          if (expect?.recipients && !expect.recipients.includes(target)) deny('UNEXPECTED_RECIPIENT', `It sends tokens to ${target}, which is not an expected recipient.`);
        }
      } else if (QUIET_PROGRAMS.has(program)) {
        instructions.push({ program, kind: 'COMPUTE_BUDGET', args: {} });
      } else {
        instructions.push({ program, kind: 'UNKNOWN', args: {} });
        ask('UNREAD_INSTRUCTION', `It calls ${program} in a way this cannot read, so a person has to decide. Nothing is signed blind.`);
      }
      if (unresolved && program !== null) {
        ask('ACCOUNT_FROM_LOOKUP_TABLE', `An instruction to ${program} uses accounts from a lookup table, which cannot be checked here.`);
      }
    }
    if (expect?.maxLamports !== undefined && lamports > BigInt(expect.maxLamports)) {
      deny('VALUE_ABOVE_LIMIT', `It moves ${lamports} lamports in all, more than the ${expect.maxLamports} allowed.`);
    }
  } catch (error) {
    deny('UNREADABLE_TRANSACTION', `The transaction could not be read: ${error instanceof Error ? error.message : 'malformed'}`);
  }

  const verdict = findings.some((f) => f.severity === 'DENY')
    ? 'DENY'
    : findings.some((f) => f.severity === 'NEEDS_APPROVAL')
      ? 'APPROVAL_REQUIRED'
      : 'ALLOW';
  return { verdict, version, feePayer, signaturesRequired, instructions, findings };
}

export const solanaInspectCapability = defineCapability({
  id: 'transaction.inspect_solana',
  name: 'Say what a Solana transaction would do before it is signed',
  description:
    'Reads a serialized Solana transaction (base64, legacy or v0) and says who pays, who receives lamports, and which token transfers and approvals it makes, ' +
    'including unlimited approvals. Give the fee payer, recipients, delegates, programs and lamport ceiling you expect and anything outside them is refused. ' +
    'An unknown program or an account from a lookup table always needs a person. Signs and sends nothing.',
  category: 'READ',
  effect: 'READ',
  risk: 'LOW',
  input: SolanaInspectInput,
  output: z.object({
    verdict: z.enum(['ALLOW', 'APPROVAL_REQUIRED', 'DENY']),
    version: z.enum(['legacy', 'v0']),
    feePayer: z.string().nullable(),
    signaturesRequired: z.number().int(),
    instructions: z.array(z.object({ program: z.string(), kind: z.string(), args: z.record(z.string()) })),
    findings: z.array(z.object({ severity: z.enum(['DENY', 'NEEDS_APPROVAL', 'NOTE']), code: z.string(), sentence: z.string() })),
  }),
  modelCallable: true,
  timeoutMs: 5_000,
  async run(input) {
    return inspectSolanaTransaction(input);
  },
});
