import { base58 } from '@xbam/runtime';

/**
 * A legacy Solana transaction built by hand, for tests that judge one.
 *
 * Only the layout matters here: signature slots, the three-byte header, the
 * account keys, a blockhash, and instructions naming programs by index. No
 * real chain will ever see these.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function fromBase58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  if (bytes.length !== 32) throw new Error(`${text} is ${bytes.length} bytes, not 32`);
  return Uint8Array.from(bytes);
}

/** A 32-byte key from a seed, as an address. */
export function keyFor(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(seed & 0xff);
  bytes[0] = 7;
  return base58(bytes);
}

function compact(n: number): number[] {
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
}

export interface BuiltInstruction {
  program: string;
  accounts: string[];
  data: number[];
}

/** Serialises a message, with `signers` empty signature slots (or the given signatures) in front. */
export function buildTransaction(input: {
  feePayer: string;
  signers?: number;
  instructions: BuiltInstruction[];
  blockhashSeed?: number;
  signatures?: Uint8Array[];
}): string {
  const signers = input.signers ?? 1;
  const keys: string[] = [input.feePayer];
  for (let s = 1; s < signers; s += 1) keys.push(keyFor(200 + s));
  for (const ix of input.instructions) {
    for (const a of ix.accounts) if (!keys.includes(a)) keys.push(a);
  }
  for (const ix of input.instructions) if (!keys.includes(ix.program)) keys.push(ix.program);
  const message: number[] = [signers, 0, 0, ...compact(keys.length)];
  for (const k of keys) message.push(...fromBase58(k));
  message.push(...new Uint8Array(32).fill(input.blockhashSeed ?? 9));
  message.push(...compact(input.instructions.length));
  for (const ix of input.instructions) {
    message.push(keys.indexOf(ix.program), ...compact(ix.accounts.length), ...ix.accounts.map((a) => keys.indexOf(a)));
    message.push(...compact(ix.data.length), ...ix.data);
  }
  const sigs = input.signatures ?? Array.from({ length: signers }, () => new Uint8Array(64));
  const bytes = [...compact(sigs.length), ...sigs.flatMap((s) => [...s]), ...message];
  return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

/** The same transaction with its first signature slot filled, as a signer would return it. */
export function withSignature(base64: string, signature: Uint8Array = new Uint8Array(64).fill(1)): string {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  bytes.set(signature, 1);
  return Buffer.from(bytes).toString('base64');
}
