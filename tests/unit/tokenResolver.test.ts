import { describe, expect, it } from 'vitest';
import {
  candidatesFrom,
  chooseCandidate,
  describeToken,
  endpointFor,
  mergeReferences,
  normaliseChain,
  parseTokenReference,
  type DexPairRaw,
} from '@xbam/runtime';

const pair = (over: Partial<DexPairRaw> & { chainId: string; address: string; symbol: string }): DexPairRaw => ({
  chainId: over.chainId,
  dexId: over.dexId ?? 'raydium',
  url: over.url ?? `https://dexscreener.com/${over.chainId}/pair1`,
  pairAddress: over.pairAddress ?? 'pair1',
  baseToken: { name: over.baseToken?.name ?? over.symbol, symbol: over.symbol, address: over.address },
  priceUsd: over.priceUsd ?? '1.00',
  liquidity: over.liquidity ?? { usd: 100_000 },
  volume: over.volume ?? { h24: 50_000 },
  fdv: over.fdv,
  marketCap: over.marketCap,
  priceChange: over.priceChange ?? { h24: 1.5 },
  pairCreatedAt: over.pairCreatedAt,
});

const SOL_DOG = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ETH_DOG = '0x' + 'a'.repeat(40);

describe('reading which token was meant', () => {
  it('takes a DexScreener link as the strongest signal', () => {
    // Somebody who pastes one has already done the disambiguation.
    const ref = parseTokenReference('is this the one? https://dexscreener.com/solana/Abc123Def456Ghi789Jkl');
    expect(ref.chain).toBe('solana');
    expect(ref.pairAddress).toBe('Abc123Def456Ghi789Jkl');
    expect(ref.fromUrl).toBe(true);
  });

  it('reads a contract address', () => {
    expect(parseTokenReference(`whats ${ETH_DOG}`).address).toBe(ETH_DOG);
    expect(parseTokenReference(`whats ${SOL_DOG}`).address).toBe(SOL_DOG);
  });

  it('reads a ticker, digits included', () => {
    expect(parseTokenReference('hows $AI17Z doing').symbol).toBe('AI17Z');
    expect(parseTokenReference('$DOG?').symbol).toBe('DOG');
  });

  it('reads the chain from the way people write it', () => {
    expect(parseTokenReference('$DOG on Solana').chain).toBe('solana');
    expect(parseTokenReference('the base one, $DOG').chain).toBe('base');
    expect(parseTokenReference('$DOG on bsc').chain).toBe('bsc');
    expect(normaliseChain('SOL')).toBe('solana');
    expect(normaliseChain('matic')).toBe('polygon');
  });

  it('finds nothing in a message about nothing', () => {
    const ref = parseTokenReference('gm, nice work today');
    expect(ref).toEqual({ address: null, chain: null, pairAddress: null, symbol: null, fromUrl: false });
  });

  it('merges what the message, the parent and the quote each said', () => {
    // The ticker is in the mention, the chain is in the post above it.
    const merged = mergeReferences(
      parseTokenReference('is $DOG worth anything'),
      parseTokenReference('everything on Solana pumped today'),
    );
    expect(merged.symbol).toBe('DOG');
    expect(merged.chain).toBe('solana');
  });
});

describe('which endpoint answers the question', () => {
  it('asks about the pair when one was linked', () => {
    expect(endpointFor({ address: null, chain: 'solana', pairAddress: 'p1', symbol: null, fromUrl: true })).toContain(
      '/pairs/solana/p1',
    );
  });

  it('asks the token endpoint for an address, never search', () => {
    // search matches either side of a pair, which returns a price belonging to
    // whatever the token trades against.
    const url = endpointFor({ address: ETH_DOG, chain: null, pairAddress: null, symbol: null, fromUrl: false });
    expect(url).toContain('/tokens/');
    expect(url).not.toContain('/search');
  });

  it('has nowhere to go when nothing identified a token', () => {
    expect(endpointFor({ address: null, chain: null, pairAddress: null, symbol: null, fromUrl: false })).toBeNull();
  });
});

describe('a ticker is not an identity', () => {
  const contested: DexPairRaw[] = [
    pair({ chainId: 'solana', address: SOL_DOG, symbol: 'DOG', liquidity: { usd: 400_000 }, priceUsd: '0.004' }),
    pair({ chainId: 'ethereum', address: ETH_DOG, symbol: 'DOG', liquidity: { usd: 300_000 }, priceUsd: '1.20' }),
  ];

  it('refuses to choose between two comparable tokens', () => {
    // The failure this exists for: the live agent asked about "BTC" and was
    // given a Tron pair calling itself Bitcoin.
    const resolution = chooseCandidate(candidatesFrom(contested, 'DOG'), parseTokenReference('$DOG'));
    expect(resolution.status).toBe('AMBIGUOUS');
    expect(resolution.facts).toBeNull();
    expect(resolution.candidates).toHaveLength(2);
  });

  it('says both candidates out loud rather than picking one', () => {
    const text = describeToken(chooseCandidate(candidatesFrom(contested, 'DOG'), parseTokenReference('$DOG')));
    expect(text).toContain('solana');
    expect(text).toContain('ethereum');
    expect(text).toMatch(/could not tell/i);
  });

  it('the chain in the conversation settles it', () => {
    const resolution = chooseCandidate(candidatesFrom(contested, 'DOG'), parseTokenReference('$DOG on solana'));
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.facts!.chain).toBe('solana');
    expect(resolution.how).toContain('solana');
  });

  it('an address settles it outright', () => {
    const resolution = chooseCandidate(candidatesFrom(contested, null), parseTokenReference(`price of ${ETH_DOG}`));
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.facts!.contract).toBe(ETH_DOG);
    expect(resolution.how).toContain('contract address they gave');
  });

  it('a contract the agent was given settles its own token', () => {
    const resolution = chooseCandidate(candidatesFrom(contested, 'DOG'), parseTokenReference('$DOG'), {
      knownAddresses: [ETH_DOG],
    });
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.facts!.contract).toBe(ETH_DOG);
    expect(resolution.how).toContain('this agent was given');
  });

  it('answers when one is overwhelmingly the traded one', () => {
    const lopsided: DexPairRaw[] = [
      pair({ chainId: 'solana', address: SOL_DOG, symbol: 'DOG', liquidity: { usd: 5_000_000 } }),
      pair({ chainId: 'ethereum', address: ETH_DOG, symbol: 'DOG', liquidity: { usd: 20_000 } }),
    ];
    const resolution = chooseCandidate(candidatesFrom(lopsided, 'DOG'), parseTokenReference('$DOG'));
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.facts!.chain).toBe('solana');
  });

  it('says so when the named chain has no such token', () => {
    const resolution = chooseCandidate(candidatesFrom(contested, 'DOG'), parseTokenReference('$DOG on tron'));
    expect(resolution.status).toBe('NOT_FOUND');
    expect(resolution.how).toContain('tron');
  });

  it('ignores pairs where the ticker is the quote asset', () => {
    // A search for DOG returns SOMETHING/DOG pairs, whose price is not DOG's.
    const mixed: DexPairRaw[] = [
      pair({ chainId: 'solana', address: SOL_DOG, symbol: 'DOG' }),
      pair({ chainId: 'solana', address: 'OtherTokenAddress1111111111111111111', symbol: 'CAT', priceUsd: '999' }),
    ];
    const candidates = candidatesFrom(mixed, 'DOG');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.facts.symbol).toBe('DOG');
  });
});

describe('the numbers reported', () => {
  it('takes the median price, not the deepest pair', () => {
    // The deepest UNI pair has been UNI/SASHIMI at five million dollars a token
    // against a real five. One broken pair tops a liquidity table and cannot
    // move a median.
    const pairs: DexPairRaw[] = [
      pair({ chainId: 'ethereum', address: ETH_DOG, symbol: 'UNI', priceUsd: '5178076', liquidity: { usd: 900_000 } }),
      pair({ chainId: 'ethereum', address: ETH_DOG, symbol: 'UNI', priceUsd: '5.18', liquidity: { usd: 500_000 }, pairAddress: 'p2' }),
      pair({ chainId: 'ethereum', address: ETH_DOG, symbol: 'UNI', priceUsd: '5.19', liquidity: { usd: 400_000 }, pairAddress: 'p3' }),
    ];
    const resolved = chooseCandidate(candidatesFrom(pairs, 'UNI'), parseTokenReference('$UNI'));
    expect(resolved.facts!.priceUsd).toBeCloseTo(5.19, 1);
  });

  it('leaves a field absent when the API did not return it', () => {
    // A market cap reported as zero is a claim the agent would make out loud.
    const resolved = chooseCandidate(
      candidatesFrom([pair({ chainId: 'solana', address: SOL_DOG, symbol: 'DOG' })], 'DOG'),
      parseTokenReference('$DOG'),
    );
    expect(resolved.facts!.marketCapUsd).toBeNull();
    expect(resolved.facts!.fdvUsd).toBeNull();
    expect(describeToken(resolved)).not.toMatch(/market cap|FDV/i);
  });

  it('always states the contract, since the ticker was never the identity', () => {
    const resolved = chooseCandidate(
      candidatesFrom([pair({ chainId: 'solana', address: SOL_DOG, symbol: 'DOG' })], 'DOG'),
      parseTokenReference('$DOG'),
    );
    expect(describeToken(resolved)).toContain(SOL_DOG);
  });

  it('reports nothing found rather than an empty answer', () => {
    const resolution = chooseCandidate([], parseTokenReference('$NOTHING'));
    expect(resolution.status).toBe('NOT_FOUND');
    expect(resolution.facts).toBeNull();
  });
});
