import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bpsAsPercent, renderEvidenceCard, renderMintExtensionLines, type CardReading, type MintExtensions } from '@xbam/prompts';
import { base58Bytes } from '@xbam/upstream';

/**
 * What a Token-2022 mint's bytes say, and the ways reading them could lie.
 *
 * **By turning a failed read into a zero.** A mint that could not be fetched or
 * decoded has no fee reported at all. Only an extension that was present,
 * decoded and said zero reads as zero.
 *
 * **By reading a stale fee as current.** The card shows nothing from a reading
 * older than its own age ceiling.
 *
 * **By guessing at what it cannot decode.** An extension type this does not know
 * is listed by id and said to be present, never skipped and never interpreted.
 */

const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; params: unknown[] }[],
  account: null as unknown,
  slot: 469_812_667 as number | null,
  fail: false,
  hang: false,
}));
vi.mock('@xbam/upstream', async importOriginal => {
  const actual = await importOriginal<typeof import('@xbam/upstream')>();
  return {
    ...actual,
    ask: async (_family: string, query: { method: string; params: unknown[] }) => {
      rpc.calls.push({ method: query.method, params: query.params });
      if (rpc.hang) return new Promise(() => {});
      if (rpc.fail) throw new Error('rpc down');
      return { value: { result: { context: { slot: rpc.slot }, value: rpc.account }, commitment: 'finalized', slot: rpc.slot },
        provenance: { upstreamId: 'solana_mainnet.official', fetchedAt: new Date().toISOString() } };
    },
  };
});

const { parseToken2022Mint, readMintExtensions, feeInEffect, feeScheduled, base58Encode, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, EXTENSION_TYPE, EXTENSIONS_DEADLINE_MS } =
  await import('../../packages/runtime/src/tokenExtensions');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/token2022Mint.json', import.meta.url), 'utf8')) as
  { mint: string; owner: string; slot: number; data: string };
const MINT = 'So11111111111111111111111111111111111111112';
const KEY_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KEY_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const keyBytes = (key: string) => base58Bytes(key)!;

/** A Token-2022 mint with the given extension entries, laid out the way the program writes it. */
function mintBytes(entries: { type: number; body: Uint8Array }[], over: { initialized?: number; accountType?: number } = {}): Uint8Array {
  const tlv = entries.flatMap(e => [e.type & 0xff, e.type >> 8, e.body.length & 0xff, e.body.length >> 8, ...e.body]);
  const out = new Uint8Array(166 + tlv.length);
  out[45] = over.initialized ?? 1;
  out[165] = over.accountType ?? 1;
  out.set(tlv, 166);
  return out;
}
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const feeEntry = (epoch: bigint, max: bigint, bps: number) => [...u64(epoch), ...u64(max), ...u16(bps)];
const transferFee = (older: number[], newer: number[]) => ({
  type: EXTENSION_TYPE.TransferFeeConfig,
  body: Uint8Array.from([...new Array(72).fill(7), ...older, ...newer]),
});
const delegate = (key: string | null) => ({ type: EXTENSION_TYPE.PermanentDelegate, body: key ? keyBytes(key) : new Uint8Array(32) });
const hook = (program: string | null) => ({ type: EXTENSION_TYPE.TransferHook, body: Uint8Array.from([...new Array(32).fill(9), ...(program ? keyBytes(program) : new Array(32).fill(0))]) });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const account = (owner: string, bytes: Uint8Array) => ({ owner, data: [b64(bytes), 'base64'], lamports: 1, executable: false });

beforeEach(() => {
  rpc.calls = []; rpc.fail = false; rpc.hang = false; rpc.slot = 469_812_667; rpc.account = null;
});

describe('decoding the extension area', () => {
  it('reads a transfer fee in basis points, and the cap as an exact integer past a double', () => {
    const max = 18_446_744_073_709_551_615n;
    const parsed = parseToken2022Mint(mintBytes([transferFee(feeEntry(1n, max, 500), feeEntry(1n, max, 500))]))!;
    expect(parsed.transferFee?.newer.bps).toBe(500);
    expect(feeInEffect(parsed.transferFee!, 432_000 * 5)).toEqual({ bps: 500, maxFee: '18446744073709551615' });
  });

  it('uses the older fee until the newer one epoch begins', () => {
    const parsed = parseToken2022Mint(mintBytes([transferFee(feeEntry(10n, 100n, 100), feeEntry(700n, 5000n, 9900))]))!;
    expect(feeInEffect(parsed.transferFee!, 432_000 * 699 + 5)).toEqual({ bps: 100, maxFee: '100' });
    expect(feeInEffect(parsed.transferFee!, 432_000 * 700)).toEqual({ bps: 9900, maxFee: '5000' });
  });

  it('reads the permanent delegate, the hook program and the default account state', () => {
    const parsed = parseToken2022Mint(mintBytes([delegate(KEY_A), hook(KEY_B), { type: EXTENSION_TYPE.DefaultAccountState, body: Uint8Array.of(2) }]))!;
    expect(parsed).toMatchObject({ permanentDelegate: KEY_A, transferHookProgram: KEY_B, defaultAccountState: 'frozen', otherTypeIds: [] });
  });

  it('treats an all-zero authority as unset, never as an address', () => {
    const parsed = parseToken2022Mint(mintBytes([delegate(null), hook(null)]))!;
    expect(parsed.permanentDelegate).toBeNull();
    expect(parsed.transferHookProgram).toBeNull();
  });

  it('lists an extension it does not decode by id instead of skipping it quietly', () => {
    const parsed = parseToken2022Mint(mintBytes([{ type: 18, body: new Uint8Array(64) }, delegate(KEY_A), { type: 3, body: new Uint8Array(32) }]))!;
    expect(parsed.otherTypeIds).toEqual([3, 18]);
    expect(parsed.permanentDelegate).toBe(KEY_A);
  });

  it('is an empty reading for a bare 82 byte mint and null for anything it cannot place', () => {
    const bare = new Uint8Array(82); bare[45] = 1;
    expect(parseToken2022Mint(bare)).toMatchObject({ transferFee: null, otherTypeIds: [] });
    expect(parseToken2022Mint(new Uint8Array(40))).toBeNull();
    expect(parseToken2022Mint(mintBytes([], { initialized: 0 }))).toBeNull();
    // A token account is not a mint, whatever program owns it.
    expect(parseToken2022Mint(mintBytes([], { accountType: 2 }))).toBeNull();
    // Neither a bare mint nor a padded one.
    const odd = new Uint8Array(120); odd[45] = 1;
    expect(parseToken2022Mint(odd)).toBeNull();
  });

  it('refuses hostile bytes rather than reading past them or guessing', () => {
    const good = mintBytes([delegate(KEY_A)]);
    // An entry that claims more bytes than exist.
    expect(parseToken2022Mint(good.subarray(0, good.length - 5))).toBeNull();
    // A known extension of the wrong size.
    expect(parseToken2022Mint(mintBytes([{ type: EXTENSION_TYPE.TransferFeeConfig, body: new Uint8Array(40) }]))).toBeNull();
    expect(parseToken2022Mint(mintBytes([{ type: EXTENSION_TYPE.DefaultAccountState, body: Uint8Array.of(9) }]))).toBeNull();
    // The same extension twice.
    expect(parseToken2022Mint(mintBytes([delegate(KEY_A), delegate(KEY_B)]))).toBeNull();
  });

  it('never counts one to three stray trailing bytes as a valid read, because they mean an entry was cut', () => {
    const good = mintBytes([delegate(KEY_A)]);
    expect(parseToken2022Mint(good)).not.toBeNull();
    for (const extra of [[1], [1, 0], [1, 0, 0], [0], [0, 0, 0], [0xff, 0xff, 0xff]]) {
      expect(parseToken2022Mint(Uint8Array.from([...good, ...extra])), `+${extra.length} bytes`).toBeNull();
    }
    // The case that matters: a fee entry cut inside its header must not read as "no fee".
    const cut = Uint8Array.from([...good, EXTENSION_TYPE.TransferFeeConfig, 0]);
    expect(parseToken2022Mint(cut)).toBeNull();
    // Whole zeroed padding after the last entry is still the program's own padding.
    expect(parseToken2022Mint(Uint8Array.from([...good, 0, 0, 0, 0, 0, 0, 0, 0]))).toMatchObject({ permanentDelegate: KEY_A });
    // Padding is only padding if all of it is zero.
    expect(parseToken2022Mint(Uint8Array.from([...good, 0, 0, 0, 0, 0, 7, 0, 0]))).toBeNull();
  });

  it('treats an uninitialised entry type that carries a length as unreadable, not as an unparsed id', () => {
    expect(parseToken2022Mint(mintBytes([{ type: 0, body: new Uint8Array(8) }]))).toBeNull();
    expect(parseToken2022Mint(mintBytes([delegate(KEY_A), { type: 0, body: new Uint8Array(8) }]))).toBeNull();
  });

  it('decodes a real mainnet mint: delegate set, hook unset, a zero fee, five undecoded types', () => {
    const parsed = parseToken2022Mint(new Uint8Array(Buffer.from(fixture.data, 'base64')))!;
    expect(parsed.permanentDelegate).toBe('2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk');
    expect(parsed.transferHookProgram).toBeNull();
    expect(parsed.defaultAccountState).toBeNull();
    expect(feeInEffect(parsed.transferFee!, fixture.slot)).toEqual({ bps: 0, maxFee: '0' });
    expect(parsed.otherTypeIds).toEqual([3, 4, 16, 18, 19]);
  });

  it('encodes addresses back to the text a person would paste, leading zero bytes included', () => {
    expect(base58Encode(keyBytes(KEY_A))).toBe(KEY_A);
    expect(base58Encode(keyBytes(MINT))).toBe(MINT);
    expect(base58Encode(keyBytes('11111111111111111111111111111111'))).toBe('11111111111111111111111111111111');
  });
});

describe('reading a mint from the chain', () => {
  it('reads the mint account as base64 and says so on the answer', async () => {
    rpc.account = account(TOKEN_2022_PROGRAM, mintBytes([transferFee(feeEntry(1n, 1000n, 500), feeEntry(1n, 1000n, 500))]));
    const ext = await readMintExtensions(MINT);
    expect(rpc.calls).toEqual([{ method: 'getAccountInfo', params: [MINT, { encoding: 'base64', commitment: 'finalized' }] }]);
    expect(ext).toMatchObject({ status: 'read', source: 'solana_mainnet.official', transferFee: { bps: 500, maxFee: '1000' },
      permanentDelegate: null, transferHookProgram: null });
  });

  it('says the original Token program has no extensions to read', async () => {
    const base = new Uint8Array(82); base[45] = 1;
    rpc.account = account(TOKEN_PROGRAM, base);
    expect((await readMintExtensions(MINT)).status).toBe('not_applicable');
  });

  it('is unread, not "transfer fee: none", when the buffer is cut inside an entry header', async () => {
    const good = mintBytes([delegate(KEY_A)]);
    rpc.account = account(TOKEN_2022_PROGRAM, Uint8Array.from([...good, EXTENSION_TYPE.TransferFeeConfig, 0]));
    const ext = await readMintExtensions(MINT);
    expect(ext.status).toBe('unread');
    expect(renderMintExtensionLines(ext)).toEqual(['Token-2022: extensions unread']);
  });

  it('shows a fee set for a later epoch as scheduled and keeps the fee in effect as the current one', async () => {
    rpc.slot = 432_000 * 699 + 5;
    rpc.account = account(TOKEN_2022_PROGRAM, mintBytes([transferFee(feeEntry(10n, 100n, 100), feeEntry(700n, 5000n, 9900))]));
    const ext = await readMintExtensions(MINT);
    expect(ext).toMatchObject({ status: 'read', transferFee: { bps: 100, maxFee: '100' }, scheduledTransferFee: { bps: 9900, maxFee: '5000', epoch: '700' } });
    const lines = renderMintExtensionLines(ext);
    expect(lines).toContain('transfer fee: 100 bps (1%)');
    expect(lines).toContain('transfer fee scheduled: 9900 bps (99%), cap 5000 base units, from epoch 700');
    expect(lines.filter(l => l.startsWith('transfer fee: '))).toHaveLength(1);
    // Once the epoch has begun it is the current fee and nothing is pending.
    rpc.slot = 432_000 * 700;
    const after = await readMintExtensions(MINT);
    expect(after).toMatchObject({ transferFee: { bps: 9900 }, scheduledTransferFee: null });
    expect(renderMintExtensionLines(after).some(l => l.includes('scheduled'))).toBe(false);
  });

  it('says nothing is scheduled when the pending entry changes nothing, or none exists', () => {
    const same = parseToken2022Mint(mintBytes([transferFee(feeEntry(10n, 100n, 100), feeEntry(700n, 100n, 100))]))!;
    expect(feeScheduled(same.transferFee!, 432_000 * 5)).toBeNull();
    const past = parseToken2022Mint(mintBytes([transferFee(feeEntry(10n, 100n, 100), feeEntry(20n, 5000n, 9900))]))!;
    expect(feeScheduled(past.transferFee!, 432_000 * 30)).toBeNull();
    // A changed cap alone is a change.
    const cap = parseToken2022Mint(mintBytes([transferFee(feeEntry(10n, 100n, 100), feeEntry(700n, 1n, 100))]))!;
    expect(feeScheduled(cap.transferFee!, 432_000 * 5)).toEqual({ bps: 100, maxFee: '1', epoch: '700' });
  });

  it('gives up on a node that never answers after its own deadline, and says unread', async () => {
    vi.useFakeTimers();
    try {
      rpc.hang = true;
      const pending = readMintExtensions(MINT);
      await vi.advanceTimersByTimeAsync(EXTENSIONS_DEADLINE_MS - 1);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toMatchObject({ status: 'unread' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is unread, never a zero fee, for every way the read can fail', async () => {
    const good = mintBytes([transferFee(feeEntry(1n, 1n, 500), feeEntry(1n, 1n, 500))]);
    const cases: [string, () => void][] = [
      ['rpc down', () => { rpc.fail = true; }],
      ['no such account', () => { rpc.account = null; }],
      ['owned by another program', () => { rpc.account = account(KEY_A, good); }],
      ['bytes that are not a mint', () => { rpc.account = account(TOKEN_2022_PROGRAM, new Uint8Array(200)); }],
      ['not base64', () => { rpc.account = { owner: TOKEN_2022_PROGRAM, data: ['@@@@', 'base64'] }; }],
      ['jsonParsed instead of base64', () => { rpc.account = { owner: TOKEN_2022_PROGRAM, data: { parsed: {} } }; }],
      ['a fee with no slot to say which scheduled fee applies', () => { rpc.account = account(TOKEN_2022_PROGRAM, good); rpc.slot = null; }],
      ['a Token program mint of the wrong size', () => { rpc.account = account(TOKEN_PROGRAM, new Uint8Array(100)); }],
    ];
    for (const [name, arrange] of cases) {
      rpc.calls = []; rpc.fail = false; rpc.slot = 469_812_667; rpc.account = null;
      arrange();
      const ext = await readMintExtensions(MINT);
      expect(ext.status, name).toBe('unread');
      expect(JSON.stringify(ext), name).not.toMatch(/bps|transferFee/);
    }
    expect(await readMintExtensions('not an address')).toMatchObject({ status: 'unread' });
  });
});

describe('what the card says', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z');
  const base = { source: 'solana_mainnet.official', fetchedAt: '2026-11-14T11:59:30.000Z', maxAgeMs: 300_000 };
  const read = (over: Partial<Extract<MintExtensions, { status: 'read' }>> = {}): MintExtensions => ({
    status: 'read', ...base, transferFee: null, permanentDelegate: null, transferHookProgram: null, defaultAccountState: null, otherTypeIds: [], ...over });

  it('reports the fee in basis points and percent', () => {
    const lines = renderMintExtensionLines(read({ transferFee: { bps: 500, maxFee: '1000' } }), now);
    expect(lines).toContain('transfer fee: 500 bps (5%)');
    expect(lines).toContain('transfer fee cap: 1000 base units');
    expect(renderMintExtensionLines(read({ transferFee: { bps: 25, maxFee: '1' } }), now)).toContain('transfer fee: 25 bps (0.25%)');
    expect(renderMintExtensionLines(read({ transferFee: { bps: 9900, maxFee: '1' } }), now)).toContain('transfer fee: 9900 bps (99%)');
    expect(bpsAsPercent(1)).toBe('0.01');
    expect(bpsAsPercent(10000)).toBe('100');
  });

  it('prints a scheduled change as its own line with its epoch, never as the current fee', () => {
    const lines = renderMintExtensionLines(read({ transferFee: { bps: 100, maxFee: '10' }, scheduledTransferFee: { bps: 9900, maxFee: '5000', epoch: '700' } }), now);
    expect(lines).toContain('transfer fee: 100 bps (1%)');
    expect(lines).toContain('transfer fee scheduled: 9900 bps (99%), cap 5000 base units, from epoch 700');
    expect(renderMintExtensionLines(read({ transferFee: { bps: 100, maxFee: '10' }, scheduledTransferFee: null }), now).some(l => l.includes('scheduled'))).toBe(false);
    expect(lines.join('\n')).not.toMatch(/honeypot|scam|\bsafe\b|\brug\b|avoid|\bbuy\b|\bsell\b/i);
  });

  it('distinguishes a present zero fee from no fee extension', () => {
    expect(renderMintExtensionLines(read({ transferFee: { bps: 0, maxFee: '0' } }), now)).toContain('transfer fee: 0 bps (0%)');
    expect(renderMintExtensionLines(read(), now)).toContain('transfer fee: none');
  });

  it('names the delegate and the hook, or says none, and flags what it could not decode', () => {
    const lines = renderMintExtensionLines(read({ permanentDelegate: KEY_A, transferHookProgram: KEY_B, defaultAccountState: 'frozen', otherTypeIds: [3, 18] }), now);
    expect(lines).toContain(`permanent delegate: ${KEY_A}`);
    expect(lines).toContain(`transfer hook: ${KEY_B}`);
    expect(lines).toContain('default account state: frozen');
    expect(lines).toContain('additional unparsed extensions present (type ids 3, 18)');
    const none = renderMintExtensionLines(read(), now);
    expect(none).toContain('permanent delegate: none');
    expect(none).toContain('transfer hook: none');
    expect(none.some(l => l.startsWith('additional'))).toBe(false);
  });

  it('says not applicable for the original program and unread when it could not be read', () => {
    expect(renderMintExtensionLines({ status: 'not_applicable', ...base }, now)[0]).toMatch(/^Token-2022: not applicable \(SPL Token\) \[/);
    expect(renderMintExtensionLines({ status: 'unread', ...base }, now)).toEqual(['Token-2022: extensions unread']);
  });

  it('prints nothing from a reading older than its ceiling, or from the future', () => {
    const stale = read({ transferFee: { bps: 500, maxFee: '1' }, fetchedAt: '2026-11-14T11:00:00.000Z' });
    expect(renderMintExtensionLines(stale, now)).toEqual(['Token-2022: extensions unread']);
    expect(renderMintExtensionLines({ ...stale, fetchedAt: '2026-11-14T13:00:00.000Z' }, now)).toEqual(['Token-2022: extensions unread']);
    expect(renderMintExtensionLines({ ...stale, fetchedAt: null }, now)).toEqual(['Token-2022: extensions unread']);
  });

  it('never uses a verdict word in any rendering', () => {
    const everything = [
      ...renderMintExtensionLines(read({ transferFee: { bps: 9900, maxFee: '1' }, permanentDelegate: KEY_A, transferHookProgram: KEY_B, defaultAccountState: 'frozen', otherTypeIds: [1] }), now),
      ...renderMintExtensionLines({ status: 'unread', ...base }, now),
      ...renderMintExtensionLines({ status: 'not_applicable', ...base }, now),
    ].join('\n');
    expect(everything).not.toMatch(/honeypot|tax scam|scam|\bsafe\b|\brug\b|unruggable|avoid|\bbuy\b|\bsell\b/i);
  });

  it('sits between the readings and the disclaimer of the card, and the card without it is unchanged', () => {
    const readings: CardReading[] = [{ label: 'Liquidity', value: 10, unit: 'USD', source: 's', fetchedAt: '2026-11-14T11:59:30.000Z', observedAt: '2026-11-14T11:59:20.000Z', maxAgeMs: 300_000 }];
    const without = renderEvidenceCard(readings, '', now, '', null, null);
    expect(without).toBe(renderEvidenceCard(readings, '', now));
    const lines = renderEvidenceCard(readings, '', now, '', null, read({ transferFee: { bps: 500, maxFee: '1' } })).split('\n');
    const at = lines.indexOf('transfer fee: 500 bps (5%)');
    expect(at).toBeGreaterThan(lines.findIndex(l => l.startsWith('Liquidity')));
    expect(at).toBeLessThan(lines.indexOf('not a verdict, reads can be wrong'));
  });
});
