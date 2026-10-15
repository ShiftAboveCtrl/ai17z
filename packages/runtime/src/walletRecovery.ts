import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import type { WalletFamily } from '@xbam/shared/contracts';

/**
 * An agent wallet's key from a recovery phrase its owner holds.
 *
 * The phrase is the standard BIP-39 twelve or twenty-four words, and each key
 * is derived on the path a mainstream wallet uses, the same paths AI17Z
 * Studio's ceremony shows the owner's addresses from:
 *
 *   EVM      m/44'/60'/0'/0/0   (BIP-44, as MetaMask)
 *   Solana   m/44'/501'/0'/0'   (SLIP-0010 ed25519, as Phantom)
 *
 * So the money an agent signs for is recoverable without AI17Z at all: the
 * owner types the words into any of those wallets. The libraries are the
 * audited `@scure` and `@noble` ones; the only arithmetic written here is
 * SLIP-0010's hardened step, which is one HMAC per level.
 *
 * Nothing in this module keeps a phrase. Every function takes it, derives what
 * it needs, zeroes the seed and returns; the caller seals the derived key
 * (`walletCore.restoreWalletFromPhrase`) and drops the phrase.
 */

export const WALLET_PATHS: Record<WalletFamily, string> = {
  EVM: "m/44'/60'/0'/0/0",
  SOLANA: "m/44'/501'/0'/0'",
};

/** The phrase as the standard reads it: lower case, single spaces. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(normalisePhrase(phrase), wordlist);
}

/** Twelve words from the platform's own random source. Used only by tests and tools: an owner's phrase is made in their browser. */
export function newRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

/** SLIP-0010 for ed25519: every level hardened, which is all Solana's path uses. */
function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const segment of path.split('/').slice(1)) {
    if (!segment.endsWith("'")) throw new Error('ed25519 derivation is hardened only.');
    const index = (parseInt(segment, 10) | 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index);
    I.fill(0);
    I = hmac(sha512, chain, data);
    data.fill(0);
    key.fill(0);
    chain.fill(0);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  I.fill(0);
  chain.fill(0);
  return key;
}

/**
 * The secret a wallet adapter signs with, for one family, from a phrase: the
 * 32-byte ed25519 seed for Solana and the 32-byte secp256k1 key for EVM, which
 * is what every adapter's `addressOf` and `sign` take. Throws, saying nothing
 * about the words, if the phrase is not a valid one.
 */
export function secretFromPhrase(family: WalletFamily, phrase: string): Uint8Array {
  const words = normalisePhrase(phrase);
  if (!validateMnemonic(words, wordlist)) throw new Error('That is not a valid recovery phrase. Check each word and the order.');
  const seed = mnemonicToSeedSync(words);
  try {
    if (family === 'SOLANA') return slip10Ed25519(seed, WALLET_PATHS.SOLANA);
    const key = HDKey.fromMasterSeed(seed).derive(WALLET_PATHS.EVM);
    const out = Uint8Array.from(key.privateKey!);
    key.wipePrivateData();
    return out;
  } finally {
    seed.fill(0);
  }
}
