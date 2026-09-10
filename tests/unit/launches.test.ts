import { describe, expect, it } from 'vitest';
import { addressesIn, readLaunchSignals, tickersIn, type LaunchMention } from '@xbam/runtime';

/**
 * Noticing a launch without asserting anything about it.
 *
 * This is the part of the product where a confident sentence does real damage:
 * an agent that states a contract address it half-remembers sends somebody's
 * money to a stranger. So the assertions here are mostly about what the module
 * refuses to produce -- no address that was not literally in a post, no
 * grouping that implies agreement where there is none, and a warning whenever
 * the evidence contradicts itself.
 */

const EVM_A = '0x1111111111111111111111111111111111111111';
const EVM_B = '0x2222222222222222222222222222222222222222';

const mention = (over: Partial<LaunchMention> & { statusId: string }): LaunchMention => ({
  handle: 'someone',
  text: '',
  postedAt: '2026-09-09T10:00:00.000Z',
  ...over,
});

describe('what was literally written', () => {
  it('finds an EVM address and keeps its capitals', () => {
    // The capitals are a checksum. Lower-casing throws away the one self-check
    // the string has.
    const mixed = '0xAbC1111111111111111111111111111111111111';
    expect(addressesIn(`buy here ${mixed}`)).toEqual([{ value: mixed, chain: 'EVM' }]);
  });

  it('does not read an EVM address as a Solana one as well', () => {
    expect(addressesIn(`ca: ${EVM_A}`)).toHaveLength(1);
  });

  it('keeps a cashtag with its sign', () => {
    expect(tickersIn('$PONS is live, $pons')).toEqual(['$pons']);
  });
});

describe('reading launch signals', () => {
  it('will not treat one account as a launch', () => {
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: `$foo is live ${EVM_A}` }),
      mention({ statusId: '2', handle: 'alice', text: `$foo again ${EVM_A}` }),
    ]);
    expect(launches).toHaveLength(0);
  });

  it('records every address with the posts it was seen in', () => {
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: `$foo ${EVM_A}` }),
      mention({ statusId: '2', handle: 'bob', text: `$foo ${EVM_A}` }),
    ]);
    const [address] = launches[0]!.addresses;
    expect(address!.value).toBe(EVM_A);
    expect(address!.seenIn).toEqual(['1', '2']);
    expect(address!.claimedBy).toEqual(['alice', 'bob']);
  });

  it('warns when the evidence contradicts itself', () => {
    // Arithmetic rather than an accusation: a ticker has one contract, and two
    // different ones are being posted for it.
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: `$foo ${EVM_A}` }),
      mention({ statusId: '2', handle: 'bob', text: `$foo ${EVM_B}` }),
    ]);
    expect(launches[0]!.warnings[0]).toMatch(/2 different addresses/);
    expect(launches[0]!.warnings[0]).toMatch(/cannot tell you which/);
  });

  it('says when an address rests on one account', () => {
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: `$foo ${EVM_A}` }),
      mention({ statusId: '2', handle: 'bob', text: '$foo looks interesting today' }),
    ]);
    expect(launches[0]!.gaps.join(' ')).toMatch(/posted by one account only/);
  });

  it('always says it has checked nothing', () => {
    // The absence of a warning is not a reassurance, so the caveat is
    // unconditional.
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: `$foo ${EVM_A}` }),
      mention({ statusId: '2', handle: 'bob', text: `$foo ${EVM_A}` }),
    ]);
    expect(launches[0]!.gaps.join(' ')).toMatch(/Verify an address at its source/);
  });

  it('invents no price, liquidity or volume', () => {
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: `$foo ${EVM_A} up 400% mcap 2m` }),
      mention({ statusId: '2', handle: 'bob', text: `$foo ${EVM_A}` }),
    ]);
    const serialised = JSON.stringify(launches[0]);
    expect(serialised).not.toMatch(/price|liquidity|volume|marketCap/i);
  });

  it('says so when an address had no ticker to group it under', () => {
    const { gaps } = readLaunchSignals([mention({ statusId: '1', handle: 'alice', text: `look ${EVM_A}` })]);
    expect(gaps.join(' ')).toMatch(/no ticker/);
  });

  it('records the earliest sighting, not the most recent', () => {
    const { launches } = readLaunchSignals([
      mention({ statusId: '1', handle: 'alice', text: '$foo is coming', postedAt: '2026-09-09T11:00:00.000Z' }),
      mention({ statusId: '2', handle: 'bob', text: '$foo is coming', postedAt: '2026-09-09T09:00:00.000Z' }),
    ]);
    expect(launches[0]!.firstSeenAt).toBe('2026-09-09T09:00:00.000Z');
  });
});
