import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderVestingLines, unitsText } from '@xbam/prompts';
import { TokenUnlocksPayload } from '@xbam/shared/contracts';
import {
  decodeStreamflowStream,
  nextRelease,
  readTokenVesting,
  releasesContinuously,
  resetVestingCacheForTest,
  scheduleReadable,
  studioTokenUnlocksPayload,
  summarizeVesting,
  vestedAt,
  vestingStatement,
} from '@xbam/runtime';
import {
  DAY,
  NOW,
  NOW_MS,
  TOKEN,
  addr,
  fakeCluster,
  scenarios,
  streamAccountBytes,
  type ClusterSnapshot,
  type StreamSpec,
} from '../support/vestingFixtures';

/**
 * Vesting streams, and the ways a reader of them could lie.
 *
 * By reading silence as a zero: no stream seen among the largest accounts is not
 * "nothing is locked". By counting what it could not read: an account no stream
 * names back is reported as unrecognized and never as locked. By dressing a
 * date as a forecast: the statement says when an account's own schedule ends,
 * and nothing about what a release does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, '..', 'fixtures', 'tokenUnlocks');
const MINT = addr('mint');

beforeEach(() => resetVestingCacheForTest());

const spec = (over: Partial<StreamSpec>): StreamSpec => ({
  mint: MINT, escrow: addr('escrow'), start: NOW + DAY, end: NOW + 11n * DAY, cliff: 0n, cliffAmount: 0n,
  period: DAY, amountPerPeriod: 10n, net: 100n, ...over,
});

const decoded = (over: Partial<StreamSpec>) => decodeStreamflowStream(streamAccountBytes(spec(over)))!;

async function readSnapshot(snapshot: ClusterSnapshot, options: Parameters<typeof fakeCluster>[1] = {}) {
  const cluster = fakeCluster(snapshot, options);
  const read = await readTokenVesting(snapshot.mint, { rpc: cluster.rpc, now: () => snapshot.nowMs });
  return { cluster, read, summary: summarizeVesting(read, snapshot.nowMs) };
}

describe('decoding a stream account', () => {
  it('reads the schedule, the mint and the escrow it names back', () => {
    const stream = decoded({ cliff: NOW + 2n * DAY, cliffAmount: 7n });
    expect(stream.mint).toBe(MINT);
    expect(stream.escrowTokens).toBe(addr('escrow'));
    expect(stream.netAmountDeposited).toBe(100n);
    expect(stream.cliffAmount).toBe(7n);
    expect(stream.endTime).toBe(NOW + 11n * DAY);
  });

  it('refuses bytes that are not a stream', () => {
    expect(decodeStreamflowStream(new Uint8Array(200))).toBeNull();
    expect(decodeStreamflowStream(new Uint8Array(1104))).toBeNull();
    const bytes = streamAccountBytes(spec({}));
    new DataView(bytes.buffer).setBigUint64(33, 5n, true);
    expect(decodeStreamflowStream(bytes)).toBeNull();
  });

  it('never carries a sender or a recipient', () => {
    const stream = decoded({});
    expect(JSON.stringify(stream, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(addr('sender'));
    expect(JSON.stringify(stream, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(addr('recipient'));
  });
});

describe('what a schedule has released by a time', () => {
  const linear = () => decoded({ start: 1_800_000_000n, cliff: 1_800_000_000n, cliffAmount: 20n, period: 100n, amountPerPeriod: 10n, net: 100n, end: 1_800_000_800n });

  it('is nothing before the cliff, the cliff amount at it, then one amount per whole period', () => {
    const s = linear();
    expect(vestedAt(s, 1_799_999_999n)).toBe(0n);
    expect(vestedAt(s, 1_800_000_000n)).toBe(20n);
    expect(vestedAt(s, 1_800_000_099n)).toBe(20n);
    expect(vestedAt(s, 1_800_000_100n)).toBe(30n);
    expect(vestedAt(s, 1_800_000_450n)).toBe(60n);
  });

  it('is the whole deposit at the end and never more', () => {
    const s = linear();
    expect(vestedAt(s, 1_800_000_800n)).toBe(100n);
    expect(vestedAt(s, 1_900_000_000n)).toBe(100n);
  });

  it('names the next release and how much it adds', () => {
    const s = linear();
    expect(nextRelease(s, 1_799_999_000n)).toEqual({ at: 1_800_000_000n, amount: 20n });
    expect(nextRelease(s, 1_800_000_050n)).toEqual({ at: 1_800_000_100n, amount: 10n });
    expect(nextRelease(s, 1_800_000_800n)).toBeNull();
  });

  it('has no cliff release when the cliff amount is zero, and starts a period later', () => {
    const s = decoded({ start: 1_800_000_000n, cliff: 0n, cliffAmount: 0n, period: 100n, amountPerPeriod: 25n, net: 100n, end: 1_800_000_400n });
    expect(nextRelease(s, 1_799_999_000n)).toEqual({ at: 1_800_000_100n, amount: 25n });
  });

  it('treats a stream that releases more often than hourly as continuous, once past its cliff', () => {
    const s = decoded({ start: 1_800_000_000n, cliff: 1_800_000_000n, cliffAmount: 0n, period: 1n, amountPerPeriod: 1n, net: 1_000_000n, end: 1_801_000_000n });
    expect(releasesContinuously(s, 1_799_999_000n)).toBe(false);
    expect(releasesContinuously(s, 1_800_500_000n)).toBe(true);
  });

  it('is unreadable, not zero, when the period or the amounts do not describe a schedule', () => {
    const s = decoded({ period: 0n });
    expect(scheduleReadable(s)).toBe(false);
    expect(vestedAt(s, NOW)).toBeNull();
    expect(nextRelease(s, NOW)).toBeNull();
    expect(vestedAt(decoded({ cliffAmount: 500n, net: 100n }), NOW)).toBeNull();
  });
});

describe('reading a mint with streams among its largest accounts', () => {
  const mixed = () => scenarios().streamflowMixed;

  it('finds the streams, with hand-checked figures', async () => {
    const { summary } = await readSnapshot(mixed());
    // 200,000,000 in the linear stream and 50,000,000 in the lock, of 1,000,000,000.
    expect(summary.status).toBe('FOUND');
    expect(summary.unfinishedStreams).toBe(2);
    expect(summary.totalLockedAmount).toBe((250_000_000n * TOKEN).toString());
    expect(summary.supplyPctLocked).toBe(25);
    expect(summary.endedStreams).toBe(1);
    expect(summary.unrecognized).toBe(0);
    expect(summary.accountsRead).toBe(5);
  });

  it('gives the soonest release as a UTC ISO date with its amount', async () => {
    const { summary } = await readSnapshot(mixed());
    // The lock opens in three days with everything but one base unit.
    expect(summary.nextUnlockAt).toBe(new Date(Number(NOW + 3n * DAY) * 1000).toISOString());
    expect(summary.nextUnlockAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(summary.nextUnlockAmount).toBe((50_000_000n * TOKEN - 1n).toString());
  });

  it('counts what releases within seven days, and the last end among unfinished streams', async () => {
    const { summary } = await readSnapshot(mixed());
    // The lock's whole balance falls inside the week, the linear stream's cliff is ten days out.
    expect(summary.unlockingNext7DaysAmount).toBe((50_000_000n * TOKEN).toString());
    expect(summary.lastUnlockAt).toBe(new Date(Number(NOW + 310n * DAY) * 1000).toISOString());
    expect(summary.noScheduledRelease).toBe(false);
    expect(summary.releasingNow).toBe(false);
  });

  it('marks a stream past its end as ended and does not count it as held', async () => {
    const { summary } = await readSnapshot(mixed());
    const ended = summary.streams.filter((s) => s.state === 'ENDED');
    expect(ended).toHaveLength(1);
    expect(summary.streams.filter((s) => s.state === 'LOCKED')).toHaveLength(2);
    expect(BigInt(summary.totalLockedAmount!)).toBe(250_000_000n * TOKEN);
  });

  it('asks only for reads the cluster allows, and never scans a program', async () => {
    const { cluster } = await readSnapshot(mixed());
    const methods = new Set(cluster.calls.map((c) => c.method));
    expect(methods.has('getProgramAccounts')).toBe(false);
    expect([...methods].sort()).toEqual(['getMultipleAccounts', 'getSignaturesForAddress', 'getTokenLargestAccounts', 'getTokenSupply', 'getTransaction']);
    // Two holder reads, one token account read, then three calls per stream and one for the metadata batch.
    expect(cluster.calls.length).toBeLessThanOrEqual(2 + 1 + 3 * 3);
  });

  it('carries no stream, sender or recipient address into the Studio payload', async () => {
    const { summary } = await readSnapshot(mixed());
    const payload = studioTokenUnlocksPayload(summary);
    const text = JSON.stringify(payload);
    for (const label of ['linear-metadata', 'lock-metadata', 'ended-metadata', 'linear-escrow', 'lock-escrow', 'sender', 'recipient']) {
      expect(text).not.toContain(addr(label));
    }
    expect(TokenUnlocksPayload.safeParse(payload).success).toBe(true);
  });
});

describe('what is not a stream is not counted', () => {
  it('reports none seen, and no zero, when no largest account is a stream', async () => {
    const { summary } = await readSnapshot(scenarios().noneSeen);
    expect(summary.status).toBe('NONE_SEEN');
    expect(summary.totalLockedAmount).toBeNull();
    expect(summary.supplyPctLocked).toBeNull();
    expect(summary.unlockingNext7DaysAmount).toBeNull();
    expect(summary.nextUnlockAt).toBeNull();
    expect(vestingStatement(summary)).toContain('no scheduled release date on record');
  });

  it('reports an account no stream names as an unrecognized lock contract and counts it nowhere', async () => {
    const { summary } = await readSnapshot(scenarios().unrecognizedLock);
    expect(summary.unrecognized).toBe(1);
    expect(summary.totalLockedAmount).toBeNull();
    expect(summary.supplyPctLocked).toBeNull();
    const text = vestingStatement(summary);
    expect(text).toContain('Unrecognized lock contract: 1 account not decoded, not counted');
    expect(text).toContain('no scheduled release date on record');
  });

  it('requires the stream to name this escrow back', async () => {
    const snapshot = scenarios().streamflowMixed;
    // Point the lock stream's metadata at a different escrow.
    const metadata = addr('lock-metadata');
    snapshot.accounts[metadata] = {
      owner: snapshot.accounts[metadata]!.owner,
      dataBase64: Buffer.from(streamAccountBytes({
        mint: MINT, escrow: addr('somebody-elses-escrow'), start: NOW + 3n * DAY, cliff: NOW + 3n * DAY, cliffAmount: 1n,
        period: 1n, amountPerPeriod: 1n, net: 1n, end: NOW + 3n * DAY + 1n,
      })).toString('base64'),
    };
    const { summary } = await readSnapshot(snapshot);
    expect(summary.unrecognized).toBe(1);
    expect(summary.unfinishedStreams).toBe(1);
  });

  it('requires the stream account to be owned by the stream program', async () => {
    const snapshot = scenarios().streamflowMixed;
    snapshot.accounts[addr('lock-metadata')]!.owner = addr('some-other-program');
    const { summary } = await readSnapshot(snapshot);
    expect(summary.unrecognized).toBe(1);
    expect(summary.unfinishedStreams).toBe(1);
  });

  it('requires the stream to name this mint', async () => {
    const snapshot = scenarios().streamflowMixed;
    const metadata = addr('lock-metadata');
    snapshot.accounts[metadata]!.dataBase64 = Buffer.from(streamAccountBytes({
      mint: addr('another-mint'), escrow: addr('lock-escrow'), start: NOW + 3n * DAY, cliff: NOW + 3n * DAY, cliffAmount: 1n,
      period: 1n, amountPerPeriod: 1n, net: 1n, end: NOW + 3n * DAY + 1n,
    })).toString('base64');
    const { summary } = await readSnapshot(snapshot);
    expect(summary.unrecognized).toBe(1);
  });
});

describe('ceilings, failures and the cache', () => {
  it('looks at no more than twenty accounts', async () => {
    const snapshot = scenarios().noneSeen;
    for (let i = 0; i < 30; i += 1) {
      const address = addr(`extra-${i}`);
      snapshot.largest.push({ address, amount: '1000' });
    }
    const { read } = await readSnapshot(snapshot);
    expect(read.accountsRead).toBe(20);
  });

  it('throws when the holder list cannot be read, so a failed read is never a payload of zeros', async () => {
    const snapshot = scenarios().streamflowMixed;
    const cluster = fakeCluster(snapshot, { failOn: (method) => method === 'getTokenLargestAccounts' });
    await expect(readTokenVesting(snapshot.mint, { rpc: cluster.rpc, now: () => NOW_MS })).rejects.toThrow(/refused/);
  });

  it('stops after two failed streams in a row and reports the rest as not read', async () => {
    const snapshot = scenarios().streamflowMixed;
    const { summary, cluster } = await readSnapshot(snapshot, { failOn: (method) => method === 'getSignaturesForAddress' });
    expect(summary.unfinishedStreams).toBe(0);
    expect(summary.notRead).toBe(3);
    expect(cluster.calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(2);
    expect(vestingStatement(summary)).toContain('Not read: 3 accounts');
  });

  it('stops starting new streams once its deadline has passed', async () => {
    const snapshot = scenarios().streamflowMixed;
    let clock = NOW_MS;
    const cluster = fakeCluster(snapshot);
    const slow = async (...args: Parameters<typeof cluster.rpc>) => { clock += 15_000; return cluster.rpc(...args); };
    const read = await readTokenVesting(snapshot.mint, { rpc: slow, now: () => clock, deadlineMs: 60_000 });
    expect(read.notRead).toBeGreaterThan(0);
    expect(read.streams.length + read.unrecognized + read.notRead).toBe(3);
  });

  it('answers from the cache for an hour, then reads again', async () => {
    const snapshot = scenarios().streamflowMixed;
    const cluster = fakeCluster(snapshot);
    let clock = NOW_MS;
    const opts = { rpc: cluster.rpc, now: () => clock };
    await readTokenVesting(snapshot.mint, opts);
    const first = cluster.calls.length;
    clock += 59 * 60_000;
    await readTokenVesting(snapshot.mint, opts);
    expect(cluster.calls.length).toBe(first);
    clock += 2 * 60_000;
    await readTokenVesting(snapshot.mint, opts);
    expect(cluster.calls.length).toBeGreaterThan(first);
  });

  it('does not repeat a failed read at once', async () => {
    const snapshot = scenarios().noneSeen;
    const cluster = fakeCluster(snapshot, { failOn: (method) => method === 'getTokenSupply' });
    const opts = { rpc: cluster.rpc, now: () => NOW_MS };
    await expect(readTokenVesting(snapshot.mint, opts)).rejects.toThrow();
    const calls = cluster.calls.length;
    await expect(readTokenVesting(snapshot.mint, opts)).rejects.toThrow();
    expect(cluster.calls.length).toBe(calls);
  });
});

describe('words', () => {
  const FORBIDDEN = /\b(?:dump|dumps|sell pressure|bearish|bullish|insider|rug|scam|safe|unsafe|buy|sell|avoid|smart money|crash|pump)\b/i;

  it('formats base units exactly, cut and never rounded', () => {
    expect(unitsText('250000000000000', 6)).toBe('250000000');
    expect(unitsText('1234567', 6)).toBe('1.2345');
    expect(unitsText('5', 6)).toBe('<0.0001');
    expect(unitsText('0', 6)).toBe('0');
    expect(unitsText(null, 6)).toBe('unavailable');
    expect(unitsText('42', null)).toBe('42 base units');
  });

  it('never uses a price word or a verdict word, in any scenario', async () => {
    for (const snapshot of Object.values(scenarios())) {
      resetVestingCacheForTest();
      const { summary } = await readSnapshot(snapshot);
      const text = vestingStatement(summary);
      expect(text).not.toMatch(FORBIDDEN);
      expect(text).not.toMatch(/[–—]|--| - /);
    }
  });

  it('says what the scope is, and that only one locker is read', async () => {
    const { summary } = await readSnapshot(scenarios().streamflowMixed);
    const text = vestingStatement(summary);
    expect(text).toContain('scope: 5 largest token accounts');
    expect(text).toContain('only Streamflow is read; other lockers are not');
  });

  it('prints an unreadable schedule as unavailable and a missing figure as unavailable, never 0', () => {
    const lines = renderVestingLines({
      status: 'FOUND', decimals: 6, totalLockedAmount: '5000000', supplyPctLocked: null, unfinishedStreams: 1,
      nextUnlockAt: null, nextUnlockAmount: null, unlockingNext7DaysAmount: null, releasingNow: false, lastUnlockAt: null,
      endedStreams: 0, unrecognized: 0, notRead: 0, accountsRead: 4, slot: null, source: 'solana.read_vesting_streams',
    });
    expect(lines[0]).toContain('share of supply: unavailable');
    expect(lines[1]).toContain('unavailable');
    expect(lines.join('\n')).not.toMatch(/\b0%/);
  });

  it('keeps the words of the source itself free of the banned phrases', () => {
    for (const file of ['packages/prompts/src/vestingLines.ts', 'packages/runtime/src/vestingReader.ts']) {
      const source = readFileSync(join(here, '..', '..', file), 'utf8');
      expect(source, file).not.toMatch(/unlock dump|sell pressure|bearish|insider unlock/i);
      expect(source, file).not.toMatch(/[–—]| -- /);
    }
  });
});

describe('the Studio contract and its fixtures', () => {
  const names = ['streamflowMixed', 'noneSeen', 'unrecognizedLock'] as const;

  for (const name of names) {
    it(`${name}: the stored snapshot reproduces the stored payload, and the payload parses strictly`, async () => {
      const file = join(FIXTURE_DIR, `${name}.json`);
      if (process.env.WRITE_VESTING_FIXTURES === '1') {
        const snapshot = scenarios()[name]!;
        const { summary } = await readSnapshot(snapshot);
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ snapshot, expected: studioTokenUnlocksPayload(summary) }, null, 2)}\n`);
        resetVestingCacheForTest();
      }
      const stored = JSON.parse(readFileSync(file, 'utf8')) as { snapshot: ClusterSnapshot; expected: unknown };
      const { summary } = await readSnapshot(stored.snapshot);
      const payload = studioTokenUnlocksPayload(summary);
      expect(payload).toEqual(stored.expected);
      expect(TokenUnlocksPayload.safeParse(payload).success).toBe(true);
      // The stored snapshot is what the builder makes today, so a fixture cannot drift from the code.
      expect(stored.snapshot).toEqual(scenarios()[name]);
    });
  }

  it('refuses an unknown field and a failed read dressed as a payload', () => {
    const base = JSON.parse(readFileSync(join(FIXTURE_DIR, 'noneSeen.json'), 'utf8')).expected as Record<string, unknown>;
    expect(TokenUnlocksPayload.safeParse({ ...base, recipient: addr('recipient') }).success).toBe(false);
    expect(TokenUnlocksPayload.safeParse({ ...base, otherLockersRead: true }).success).toBe(false);
    expect(TokenUnlocksPayload.safeParse({ protocol: 1, chain: 'solana', address: MINT, status: 'UNAVAILABLE', reason: 'The cluster did not answer.' }).success).toBe(true);
    expect(TokenUnlocksPayload.safeParse({ protocol: 1, chain: 'solana', address: MINT, status: 'UNAVAILABLE', reason: 'x', totalLockedAmount: '0' }).success).toBe(false);
  });
});
