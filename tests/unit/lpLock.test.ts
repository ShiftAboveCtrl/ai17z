import { describe, expect, it } from 'vitest';
import { renderEvidenceCard, type CardReading } from '@xbam/prompts';
import { base58 } from '../../packages/runtime/src/solanaInspect';
import {
  STREAMFLOW_END_OFFSET,
  STREAMFLOW_PROGRAM,
  classifyLpHolders,
  lpContractLines,
  lpMintFromPool,
  streamEndFrom,
} from '../../packages/runtime/src/lpLock';

const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SYSTEM = '11111111111111111111111111111111';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const MINT = 'So11111111111111111111111111111111111111112';
const WALLET = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const CUSTOM = 'Lock111111111111111111111111111111111111111';

function pubkey(fill: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = fill;
  bytes[31] = 1;
  return bytes;
}

function poolData(lp: Uint8Array): Uint8Array {
  const data = new Uint8Array(496);
  data.set(lp, 464);
  return data;
}

describe('the LP mint on a pool account', () => {
  it('reads Raydium AMM v4 at the published offset and ignores a program it does not decode', () => {
    const lp = pubkey(7);
    expect(lpMintFromPool(RAYDIUM, poolData(lp))).toBe(base58(lp));
    expect(lpMintFromPool(RAYDIUM, poolData(lp).subarray(0, 480))).toBeNull();
    expect(lpMintFromPool('Whirlpool111111111111111111111111111111111', poolData(lp))).toBeNull();
  });
});

describe('burned and locked shares', () => {
  const supply = 1_000n;
  const row = (amount: bigint, owner: string, extra: Partial<{ ownerProgram: string | null; executable: boolean | null; streamEnd: bigint | null }> = {}) => ({
    amount, owner, ownerProgram: extra.ownerProgram ?? SYSTEM, executable: extra.executable ?? false, streamEnd: extra.streamEnd ?? null,
  });

  it('counts only a burn address and a Streamflow account whose end time is still ahead', () => {
    const end = BigInt(Math.floor(Date.now() / 1000) + 86_400);
    const status = classifyLpHolders(supply, [
      row(400n, INCINERATOR),
      row(250n, SYSTEM),
      // The system program owns ordinary wallets. It is not a burn destination.
      row(200n, 'StreamAcct111111111111111111111111111111111', { ownerProgram: STREAMFLOW_PROGRAM, streamEnd: end }),
      row(150n, WALLET),
    ]);
    expect(status?.burnedPct).toBe(40);
    expect(status?.lockedPct).toBe(20);
    expect(status?.unlockAt).toBe(new Date(Number(end) * 1000).toISOString());
    expect(status?.heldByContract).toEqual([]);
  });

  it('does not count a past Streamflow end, or a contract whose unlock was not read, as locked', () => {
    const past = BigInt(Math.floor(Date.now() / 1000) - 86_400);
    const status = classifyLpHolders(supply, [
      row(300n, 'StreamAcct111111111111111111111111111111111', { ownerProgram: STREAMFLOW_PROGRAM, streamEnd: past }),
      row(100n, CUSTOM, { ownerProgram: 'Prog111111111111111111111111111111111111111', executable: false }),
    ]);
    expect(status?.lockedPct).toBe(0);
    expect(status?.burnedPct).toBe(0);
    expect(status?.heldByContract).toEqual([CUSTOM]);
    expect(lpContractLines({ burnedPct: 0, lockedPct: 0, unlockAt: null, source: 'solana_lp', heldByContract: [CUSTOM], unavailable: false }))
      .toEqual([`held by contract ${CUSTOM}`]);
  });

  it('is unavailable, never zero, when a holder or the supply was not read', () => {
    expect(classifyLpHolders(null, [row(1n, SYSTEM)])).toBeNull();
    expect(classifyLpHolders(supply, [{ amount: 1n, owner: null, ownerProgram: null, executable: null, streamEnd: null }])).toBeNull();
  });

  it('reads a Streamflow end only at the published offset', () => {
    const end = 1_900_000_000n;
    const data = new Uint8Array(STREAMFLOW_END_OFFSET + 8);
    let value = end;
    for (let i = 0; i < 8; i += 1) {
      data[STREAMFLOW_END_OFFSET + i] = Number(value & 0xffn);
      value >>= 8n;
    }
    expect(streamEndFrom(data)).toBe(end);
    expect(streamEndFrom(data.subarray(0, STREAMFLOW_END_OFFSET + 4))).toBeNull();
  });
});

describe('the LP lines on the card', () => {
  const reading = (label: string, value: number | null): CardReading => ({
    label, value, unit: '%', source: 'solana_lp', fetchedAt: new Date().toISOString(), observedAt: new Date().toISOString(), maxAgeMs: 300_000,
  });

  it('prints burned and locked percentages, and says unavailable rather than 0% when the read failed', () => {
    const burned = renderEvidenceCard([reading('LP burned', 80), reading('LP locked', 0)], '');
    expect(burned).toContain('LP burned: 80 %');
    expect(burned).toContain('LP locked: 0 %');
    const missing = renderEvidenceCard([reading('LP status', null)], '');
    expect(missing).toContain('LP status: unavailable');
    expect(missing).not.toContain('0 %');
    expect(missing).not.toMatch(/\b(?:safe|unruggable|rug|scam|safe LP)\b/i);
  });

  it('keeps a proved contract line and still says the card is not a verdict', () => {
    const text = renderEvidenceCard([reading('LP burned', 10), reading('LP locked', 0)], '', Date.now(), '', [`held by contract ${MINT}`]);
    expect(text).toContain(`held by contract ${MINT}`);
    expect(text).toContain('not a verdict, reads can be wrong');
  });
});
