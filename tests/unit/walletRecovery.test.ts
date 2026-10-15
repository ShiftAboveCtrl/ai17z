import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { base58, isRecoveryPhrase, newRecoveryPhrase, secretFromPhrase, WALLET_PATHS } from '@xbam/runtime';

/**
 * Keys from a recovery phrase, held to addresses an independent
 * implementation derived: `bip39`, `ed25519-hd-key`, `@solana/web3.js` and
 * `ethers`, none of which core uses, run on 2026-10-15. Both phrases are the
 * standard public test phrases (Hardhat's, and BIP-39's own "abandon ...
 * about"), which control nothing anybody should fund. No other phrase appears
 * in this repository.
 */

const HARDHAT = 'test test test test test test test test test test test junk';
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const solanaAddress = (secret: Uint8Array) => base58(ed25519.getPublicKey(secret));
function evmAddress(secret: Uint8Array): string {
  const hash = keccak_256(secp256k1.getPublicKey(secret, false).slice(1));
  return `0x${bytesToHex(hash.slice(-20))}`;
}

describe('a recovery phrase', () => {
  it('derives the addresses an independent implementation derives, on the paths mainstream wallets use', () => {
    expect(WALLET_PATHS).toEqual({ SOLANA: "m/44'/501'/0'/0'", EVM: "m/44'/60'/0'/0/0" });
    expect(solanaAddress(secretFromPhrase('SOLANA', ABANDON))).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    expect(solanaAddress(secretFromPhrase('SOLANA', HARDHAT))).toBe('oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96');
    expect(evmAddress(secretFromPhrase('EVM', HARDHAT))).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'.toLowerCase());
    expect(evmAddress(secretFromPhrase('EVM', ABANDON))).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'.toLowerCase());
  });

  it('reads a phrase as the standard does, whatever its spacing or case', () => {
    const loose = `  ${ABANDON.toUpperCase().split(' ').join('   ')}\n`;
    expect(solanaAddress(secretFromPhrase('SOLANA', loose))).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });

  it('refuses a wrong phrase without repeating it, and a different valid phrase opens a different wallet', () => {
    const wrong = ABANDON.replace(/about$/, 'abandon');
    expect(isRecoveryPhrase(wrong)).toBe(false);
    expect(() => secretFromPhrase('SOLANA', wrong)).toThrow(/^That is not a valid recovery phrase/);
    try {
      secretFromPhrase('SOLANA', wrong);
    } catch (error) {
      expect(String(error)).not.toContain('abandon');
    }
    const other = newRecoveryPhrase();
    expect(isRecoveryPhrase(other)).toBe(true);
    expect(other.split(' ')).toHaveLength(12);
    expect(solanaAddress(secretFromPhrase('SOLANA', other))).not.toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });
});
