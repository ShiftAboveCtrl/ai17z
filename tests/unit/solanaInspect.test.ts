import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { base58, inspectSolanaTransaction } from '@xbam/runtime';

/**
 * Saying what a Solana transaction would do. Each transaction here is
 * serialized byte by byte in the wire format, so the parser is checked
 * against the format rather than against itself.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function unbase58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  while (out.length < 32) out.unshift(0);
  return Uint8Array.from(out);
}

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const UNKNOWN_PROGRAM = base58(Uint8Array.from(randomBytes(32)));

const compact = (n: number) => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));

interface Ix {
  program: number;
  accounts: number[];
  data: number[];
}

function serialize(keys: string[], ixs: Ix[], options: { v0?: boolean; lookups?: { writable: number[]; readonly: number[] }[] } = {}): string {
  const bytes: number[] = [...compact(1), ...new Array(64).fill(0)];
  if (options.v0) bytes.push(0x80);
  bytes.push(1, 0, ixs.length > 0 ? 1 : 0);
  bytes.push(...compact(keys.length));
  for (const k of keys) bytes.push(...unbase58(k));
  bytes.push(...new Array(32).fill(7));
  bytes.push(...compact(ixs.length));
  for (const ix of ixs) bytes.push(ix.program, ...compact(ix.accounts.length), ...ix.accounts, ...compact(ix.data.length), ...ix.data);
  if (options.v0) {
    const tables = options.lookups ?? [];
    bytes.push(...compact(tables.length));
    for (const t of tables) {
      bytes.push(...new Array(32).fill(9));
      bytes.push(...compact(t.writable.length), ...t.writable, ...compact(t.readonly.length), ...t.readonly);
    }
  }
  return Buffer.from(bytes).toString('base64');
}

const payer = base58(Uint8Array.from(randomBytes(32)));
const recipient = base58(Uint8Array.from(randomBytes(32)));
const delegate = base58(Uint8Array.from(randomBytes(32)));
const tokenAccount = base58(Uint8Array.from(randomBytes(32)));

describe('reading the wire format', () => {
  it('encodes the System program as thirty-two ones, as everybody writes it', () => {
    expect(base58(new Uint8Array(32))).toBe(SYSTEM);
    expect(base58(unbase58(TOKEN))).toBe(TOKEN);
  });

  it('reads a System transfer: who pays, who receives, how much', () => {
    const tx = serialize([payer, recipient, SYSTEM], [{ program: 2, accounts: [0, 1], data: [2, 0, 0, 0, ...u64(5_000n)] }]);
    const r = inspectSolanaTransaction({ transaction: tx });
    expect(r.feePayer).toBe(payer);
    expect(r.instructions[0]).toEqual({ program: SYSTEM, kind: 'SYSTEM_TRANSFER', args: { from: payer, to: recipient, lamports: '5000' } });
    expect(r.verdict).toBe('ALLOW');
  });

  it('reads a version 0 transaction the same way', () => {
    const tx = serialize([payer, recipient, SYSTEM], [{ program: 2, accounts: [0, 1], data: [2, 0, 0, 0, ...u64(1n)] }], { v0: true });
    const r = inspectSolanaTransaction({ transaction: tx });
    expect(r.version).toBe('v0');
    expect(r.verdict).toBe('ALLOW');
  });
});

describe('what a signer must be told', () => {
  it('says an unlimited token approval is unlimited, and needs a person', () => {
    const tx = serialize([payer, tokenAccount, delegate, TOKEN], [{ program: 3, accounts: [1, 2, 0], data: [4, ...u64((1n << 64n) - 1n)] }]);
    const r = inspectSolanaTransaction({ transaction: tx });
    expect(r.instructions[0]!.kind).toBe('TOKEN_APPROVE');
    expect(r.instructions[0]!.args.delegate).toBe(delegate);
    expect(r.verdict).toBe('APPROVAL_REQUIRED');
    expect(r.findings.map((f) => f.code)).toContain('UNLIMITED_APPROVAL');
  });

  it('refuses a recipient, a fee payer and a total outside what was expected', () => {
    const tx = serialize([payer, recipient, SYSTEM], [{ program: 2, accounts: [0, 1], data: [2, 0, 0, 0, ...u64(10_000n)] }]);
    const r = inspectSolanaTransaction({
      transaction: tx,
      expect: { feePayer: recipient, recipients: [delegate], maxLamports: '100' },
    });
    expect(r.verdict).toBe('DENY');
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['UNEXPECTED_FEE_PAYER', 'UNEXPECTED_RECIPIENT', 'VALUE_ABOVE_LIMIT']));
  });
});

describe('nothing is signed blind', () => {
  it('sends an unknown program to a person', () => {
    const tx = serialize([payer, UNKNOWN_PROGRAM], [{ program: 1, accounts: [0], data: [1, 2, 3] }]);
    expect(inspectSolanaTransaction({ transaction: tx }).verdict).toBe('APPROVAL_REQUIRED');
  });

  it('sends an account from a lookup table to a person, because it cannot be checked offline', () => {
    const tx = serialize([payer, SYSTEM], [{ program: 1, accounts: [0, 2], data: [2, 0, 0, 0, ...u64(1n)] }], {
      v0: true,
      lookups: [{ writable: [5], readonly: [] }],
    });
    const r = inspectSolanaTransaction({ transaction: tx });
    expect(r.verdict).toBe('APPROVAL_REQUIRED');
    expect(r.findings.map((f) => f.code)).toContain('RECIPIENT_FROM_LOOKUP_TABLE');
  });

  it('refuses a transaction it cannot read, and one with bytes after the message', () => {
    expect(inspectSolanaTransaction({ transaction: Buffer.from([1, 2, 3]).toString('base64') }).verdict).toBe('DENY');
    const tx = serialize([payer, recipient, SYSTEM], [{ program: 2, accounts: [0, 1], data: [2, 0, 0, 0, ...u64(1n)] }]);
    const padded = Buffer.concat([Buffer.from(tx, 'base64'), Buffer.from([0])]).toString('base64');
    expect(inspectSolanaTransaction({ transaction: padded }).verdict).toBe('DENY');
  });

  it('refuses a program outside the expected ones', () => {
    const tx = serialize([payer, recipient, SYSTEM], [{ program: 2, accounts: [0, 1], data: [2, 0, 0, 0, ...u64(1n)] }]);
    expect(inspectSolanaTransaction({ transaction: tx, expect: { programs: [TOKEN] } }).verdict).toBe('DENY');
  });
});
