import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, EasySetup, PolicyConfig } from '@xbam/shared/contracts';
import {
  INDEX_ENTRY_MAX_AGE_MS,
  detectMintRequest,
  evidenceFromRiskInspect,
  evidenceFromSolanaProfile,
  mintCardRefusal,
  pointerSentence,
  readEasyView,
  refusalSentence,
  renderMintCard,
  replyValue,
  toPolicy,
  tokenAddressesIn,
  type MintEvidence,
  type RefusalReason,
} from '@xbam/runtime';

/**
 * "@agent check <mint>", without a database.
 *
 * What these pin is the part that would hurt if it drifted: which messages are
 * a request at all, that a request naming several things is refused rather than
 * guessed at, and that no layout of the card can read as a clearance, a call or
 * a price.
 */

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EVM = '0x1111111111111111111111111111111111111111';
const NOW = Date.parse('2026-11-06T14:05:00Z');
const READ_AT = '2026-11-06T14:03:00Z';

describe('which messages are a request', () => {
  it('reads one Solana mint after a word that asks for a check', () => {
    expect(detectMintRequest(`@agent check ${BONK}`)).toEqual({ kind: 'ONE', chain: 'solana', address: BONK });
    expect(detectMintRequest(`is this a rug? ${BONK}`)).toEqual({ kind: 'ONE', chain: 'solana', address: BONK });
  });

  it('does nothing with an address that nobody asked about', () => {
    expect(detectMintRequest(`gm, just aped nothing, here is the ca ${BONK}`)).toBeNull();
    expect(detectMintRequest('check this out')).toBeNull();
    expect(detectMintRequest('')).toBeNull();
    expect(detectMintRequest(null)).toBeNull();
  });

  it('does not take a handle that contains the word for the request', () => {
    expect(detectMintRequest(`@checkbot hello ${BONK}`)).toBeNull();
  });

  it('refuses two addresses instead of picking one', () => {
    expect(detectMintRequest(`check ${BONK} and ${USDC}`)).toEqual({ kind: 'REFUSE', why: 'MANY' });
    expect(detectMintRequest(`check ${BONK} then ${EVM} on base`)).toEqual({ kind: 'REFUSE', why: 'MANY' });
  });

  it('counts the same address written twice as one', () => {
    expect(detectMintRequest(`check ${BONK} again ${BONK}`)).toEqual({ kind: 'ONE', chain: 'solana', address: BONK });
    expect(detectMintRequest(`check ${EVM} on base, ${EVM.toUpperCase().replace('0X', '0x')}`)).toMatchObject({ kind: 'ONE', chain: 'base' });
  });

  it('refuses a ticker, which is not an identity', () => {
    expect(detectMintRequest('check $BONK for me')).toEqual({ kind: 'REFUSE', why: 'TICKER' });
  });

  it('prefers an address over a ticker written beside it', () => {
    expect(detectMintRequest(`check $BONK ${BONK}`)).toEqual({ kind: 'ONE', chain: 'solana', address: BONK });
  });

  it('asks for the chain of a 0x address rather than assuming one', () => {
    expect(detectMintRequest(`check ${EVM}`)).toEqual({ kind: 'REFUSE', why: 'NEEDS_CHAIN' });
    expect(detectMintRequest(`check ${EVM} on solana`)).toEqual({ kind: 'REFUSE', why: 'NEEDS_CHAIN' });
  });

  it('maps the names people type to the chains the reads know', () => {
    expect(detectMintRequest(`check ${EVM} on base`)).toEqual({ kind: 'ONE', chain: 'base', address: EVM });
    expect(detectMintRequest(`check ${EVM} on bsc`)).toEqual({ kind: 'ONE', chain: 'bnb', address: EVM });
    expect(detectMintRequest(`check ${EVM} on ethereum`)).toEqual({ kind: 'ONE', chain: 'ethereum', address: EVM });
  });

  it('refuses a link to a pair, which names a pool and not a token', () => {
    expect(detectMintRequest(`check https://dexscreener.com/solana/${BONK}`)).toEqual({ kind: 'REFUSE', why: 'PAIR_LINK' });
  });

  it('does not take a word that only looks like an address', () => {
    // 44 base58 letters that do not decode to 32 bytes.
    expect(tokenAddressesIn('z'.repeat(44))).toEqual([]);
    expect(detectMintRequest(`check ${'z'.repeat(44)}`)).toBeNull();
  });

  it('does not take an address inside a link', () => {
    expect(tokenAddressesIn(`https://solscan.io/token/${BONK}`)).toEqual([]);
    expect(tokenAddressesIn(`see https://example.invalid/x/${EVM} and ${BONK}`)).toEqual([BONK]);
  });

  it('answers a refusal in one sentence', () => {
    for (const why of ['MANY', 'TICKER', 'NEEDS_CHAIN', 'PAIR_LINK'] as RefusalReason[]) {
      const sentence = refusalSentence(why);
      expect(sentence.match(/[.!?]/g)).toHaveLength(1);
      expect(mintCardRefusal(sentence)).toBeNull();
    }
  });
});

function solanaOutput(over: Record<string, unknown> = {}, found = true, readAt = READ_AT) {
  return {
    found,
    token: found
      ? {
          liquidityUsd: 52_100,
          topHoldersPct: 41.04,
          mintAuthorityDisabled: true,
          freezeAuthorityDisabled: false,
          firstPoolAt: '2026-11-03T10:00:00Z',
          updatedAt: '2026-11-06T14:02:00Z',
          ...over,
        }
      : null,
    caveats: [],
    provenance: { source: 'solana_tokens.jupiter', host: 'x', readAt, fellBackFrom: [] },
  };
}

describe('the card', () => {
  it('names a source and a time on every reading, and never fixes a number it was not given', () => {
    const card = renderMintCard(evidenceFromSolanaProfile(solanaOutput(), NOW), 280);
    expect(card.split('\n')).toEqual([
      'Evidence:',
      'Liquidity: $52.1K (Jupiter 14:03Z)',
      'Top holders: 41% of supply (Jupiter 14:03Z)',
      'Mint authority: disabled (Jupiter 14:03Z)',
      'Freeze authority: still set (Jupiter 14:03Z)',
      'First pool: 3d ago (Jupiter 14:03Z)',
      'Not a verdict. Reads can be wrong or late.',
    ]);
    expect(card.length).toBeLessThanOrEqual(280);
  });

  it('writes a reading that was not reported as unavailable, never as zero or as fine', () => {
    const card = renderMintCard(
      evidenceFromSolanaProfile(solanaOutput({ liquidityUsd: null, topHoldersPct: null, mintAuthorityDisabled: null, freezeAuthorityDisabled: null, firstPoolAt: null }), NOW),
      280,
    );
    expect(card).toContain('Liquidity: unavailable (Jupiter 14:03Z)');
    expect(card).toContain('Top holders: unavailable');
    expect(card).toContain('Mint authority: unavailable');
    expect(card).toContain('Freeze authority: unavailable');
    expect(card).toContain('First pool: unavailable');
    expect(card).not.toMatch(/\$0\b|: 0%|disabled/);
  });

  it('keeps a real nought as a nought', () => {
    const card = renderMintCard(evidenceFromSolanaProfile(solanaOutput({ liquidityUsd: 0 }), NOW), 280);
    expect(card).toContain('Liquidity: $0 (Jupiter 14:03Z)');
  });

  it('shows figures from an entry the index has not refreshed lately as unavailable', () => {
    const old = new Date(NOW - INDEX_ENTRY_MAX_AGE_MS - 60_000).toISOString();
    const card = renderMintCard(evidenceFromSolanaProfile(solanaOutput({ updatedAt: old }), NOW), 280);
    expect(card).toContain('Liquidity: unavailable');
    expect(card).toContain('Top holders: unavailable');
    expect(card).toContain('Mint authority: disabled');
  });

  it('says a stale reading is unavailable rather than showing it as current', () => {
    const card = renderMintCard(evidenceFromSolanaProfile(solanaOutput({}, true, '2026-11-06T13:00:00Z'), NOW), 280);
    expect(card).toMatch(/^Evidence unavailable right now: the reading is too old/);
    expect(card).not.toContain('Liquidity');
  });

  it('says a token the index does not hold is not found, and that this means nothing either way', () => {
    const card = renderMintCard(evidenceFromSolanaProfile(solanaOutput({}, false), NOW), 280);
    expect(card).toMatch(/^Not found in the token index \(Jupiter 14:03Z\)\. That says nothing about the token either way\./);
  });

  it('treats an answer in the wrong shape as unavailable', () => {
    expect(renderMintCard(evidenceFromSolanaProfile({ nonsense: true }, NOW), 280)).toMatch(/^Evidence unavailable right now/);
    expect(renderMintCard(evidenceFromRiskInspect('nonsense', READ_AT, NOW), 280)).toMatch(/^Evidence unavailable right now/);
  });

  it('leaves out the least important readings when it does not fit, and says how many', () => {
    const card = renderMintCard(evidenceFromSolanaProfile(solanaOutput(), NOW), 200);
    expect(card.length).toBeLessThanOrEqual(200);
    expect(card).toMatch(/\d+ more left out for length\./);
    expect(card).not.toContain('First pool');
    expect(card).toContain('Mint authority');
    expect(card).toContain('Not a verdict');
  });

  it('reads an EVM contract from the observations and the list of what was not checked', () => {
    const output = {
      observations: [
        { what: 'Holders', detail: '1,204', source: 'contract analysis', kind: 'FACT' },
        { what: 'Held by the creator', detail: '31%', source: 'contract analysis', kind: 'FLAG' },
        { what: 'Sell tax', detail: '15%', source: 'contract analysis', kind: 'FLAG' },
        { what: 'Could be sold again', detail: 'A simulated buy could be sold.', source: 'trade simulation', kind: 'FACT' },
      ],
      notChecked: ['Hidden owner (contract analysis)'],
      sourcesAnswering: 2,
    };
    const card = renderMintCard(evidenceFromRiskInspect(output, READ_AT, NOW), 280);
    expect(card).toContain('Holders: 1,204 (analysis 14:03Z)');
    expect(card).toContain('Creator holds: 31% (analysis 14:03Z)');
    expect(card).toContain('Supply: cannot be increased (analysis 14:03Z)');
    expect(card).toContain('Exit tax: 15% (analysis 14:03Z)');
    expect(card).toContain('Exit test: passed in simulation (simulation 14:03Z)');
    expect(mintCardRefusal(card)).toBeNull();
  });

  it('says a mintable flag nobody checked is unavailable, not "cannot be increased"', () => {
    const card = renderMintCard(
      evidenceFromRiskInspect({ observations: [], notChecked: ['More can be minted (contract analysis)'], sourcesAnswering: 1 }, READ_AT, NOW),
      280,
    );
    expect(card).toContain('Supply: unavailable');
    expect(card).not.toContain('cannot be increased');
  });

  it('reports no source answering as unavailable', () => {
    const card = renderMintCard(evidenceFromRiskInspect({ observations: [], notChecked: [], sourcesAnswering: 0 }, READ_AT, NOW), 280);
    expect(card).toMatch(/^Evidence unavailable right now: no security source answered/);
  });
});

/**
 * The wording that must never appear, tried against every layout the card has.
 *
 * Enumerated rather than sampled: every combination of known, unknown, set and
 * disabled across the readings, both families, and the three non-reading
 * states. A clean card reading as "safe" is the failure that matters, so the
 * property is checked across all of them rather than on the ones somebody
 * thought of.
 */
describe('no card can read as a verdict, a call or a price', () => {
  const FORBIDDEN = /\b(?:safe|unsafe|rug|rug[ -]?proof|scam|buy|sell|sold|bullish|bearish|moon|pump|price|profit|invest|guaranteed|legit)\b|\b[1-9]\d{0,3}x\b|\$[A-Za-z]/i;

  function everyEvidence(): MintEvidence[] {
    const all: MintEvidence[] = [];
    const liquidity = [null, 0, 52_100, 9_900_000_000];
    const holders = [null, 0, 41.04, 100];
    const flag = [null, true, false];
    const firstPool = [null, '2026-11-06T10:00:00Z', '2020-01-01T00:00:00Z'];
    for (const l of liquidity)
      for (const h of holders)
        for (const m of flag)
          for (const f of flag)
            for (const p of firstPool) {
              all.push(
                evidenceFromSolanaProfile(solanaOutput({ liquidityUsd: l, topHoldersPct: h, mintAuthorityDisabled: m, freezeAuthorityDisabled: f, firstPoolAt: p }), NOW),
              );
            }
    const observationSets = [
      [],
      [{ what: 'Holders', detail: '5', source: 'contract analysis', kind: 'FACT' }],
      [
        { what: 'More can be minted', detail: 'Supply can be increased.', source: 'contract analysis', kind: 'FLAG' },
        { what: 'Cannot be sold', detail: 'Reported as a honeypot.', source: 'contract analysis', kind: 'FLAG' },
        { what: 'Could be sold again', detail: 'A simulated buy could not be sold.', source: 'trade simulation', kind: 'FLAG' },
        { what: 'Sell tax', detail: '99%', source: 'contract analysis', kind: 'FLAG' },
        { what: 'Buy tax', detail: '99%', source: 'contract analysis', kind: 'FLAG' },
        { what: 'Never analysed', detail: 'This service has no record of this contract, which is itself worth knowing about a new token.', source: 'contract analysis', kind: 'FLAG' },
      ],
    ];
    for (const observations of observationSets)
      for (const notChecked of [[], ['More can be minted (contract analysis)', 'Whether it can be sold (trade simulation)']])
        for (const sourcesAnswering of [0, 1, 2]) {
          all.push(evidenceFromRiskInspect({ observations, notChecked, sourcesAnswering }, READ_AT, NOW));
        }
    all.push(evidenceFromSolanaProfile(solanaOutput({}, false), NOW), evidenceFromSolanaProfile({}, NOW));
    return all;
  }

  it('across every combination, the card passes the guard, says it is not a verdict and carries no forbidden word', () => {
    const evidence = everyEvidence();
    expect(evidence.length).toBeGreaterThan(400);
    for (const item of evidence) {
      const card = renderMintCard(item, 280);
      expect(card, card).not.toMatch(FORBIDDEN);
      expect(mintCardRefusal(card), card).toBeNull();
      expect(card, card).toContain('Not a verdict');
      expect(card.length).toBeLessThanOrEqual(280);
    }
  });

  it('still fits and still says so at the smallest limits an owner could set', () => {
    for (const item of everyEvidence().slice(0, 40)) {
      const card = renderMintCard(item, 140);
      expect(card, card).toContain('Not a verdict');
      expect(mintCardRefusal(card)).toBeNull();
    }
  });

  it.each([
    'This one looks safe.',
    'Not a rug.',
    'rug proof',
    'Looks like a scam',
    'You could buy here',
    'time to sell',
    'bullish setup',
    'Price will go up',
    'easy 100x',
    'to the moon',
    'guaranteed',
    'Looks legit',
    '$BONK is fine',
    'Safe to ape',
  ])('refuses "%s"', (text) => {
    expect(mintCardRefusal(text)).not.toBeNull();
  });

  it('does not take a link for wording', () => {
    expect(mintCardRefusal('Already read that address 2 min ago, the evidence card is here: https://x.com/buy_sell/status/1.')).toBeNull();
  });
});

describe('a pointer', () => {
  it('names how long ago and links the card when it can', () => {
    const text = pointerSentence({ askedAt: '2026-11-06T14:03:00Z', url: 'https://x.com/i/status/1', now: NOW, allowLink: true });
    expect(text).toBe('Already read that address 2 min ago, the evidence card is here: https://x.com/i/status/1.');
    expect(mintCardRefusal(text)).toBeNull();
  });

  it('leaves the link out when the output policy forbids links, or there is none', () => {
    expect(pointerSentence({ askedAt: '2026-11-06T14:03:00Z', url: 'https://x.com/i/status/1', now: NOW, allowLink: false })).not.toContain('http');
    expect(pointerSentence({ askedAt: '2026-11-06T14:03:00Z', url: null, now: NOW, allowLink: true })).not.toContain('http');
  });
});

describe('the Easy Mode control', () => {
  const setup = (mintCheck: boolean) => EasySetup.parse({ character: { name: 'Ada' }, replies: { mintCheck } });

  it('is off by default in the policy and in Easy Mode', () => {
    expect(DEFAULT_POLICY.tools.mintCheck.enabled).toBe(false);
    expect(EasySetup.parse({ character: { name: 'Ada' } }).replies.mintCheck).toBe(false);
  });

  it('writes the policy field the pipeline reads, and reads it back unchanged', () => {
    const on = toPolicy(setup(true), DEFAULT_POLICY);
    expect(on.tools.mintCheck.enabled).toBe(true);
    const view = readEasyView({
      persona: { displayName: 'Ada', biography: '', personality: '', tone: '', styleGuidelines: '', styleExamples: [], topics: [], responseLength: 'SHORT', languagePolicy: '', customInstructions: '', prohibitedBehaviors: [] },
      policy: on,
      postIntervalSeconds: null,
      radarSourceKinds: ['notifications', 'mention_search'],
    });
    expect(view.setup.replies.mintCheck).toBe(true);
    expect(toPolicy(view.setup, on).tools.mintCheck).toEqual(on.tools.mintCheck);
  });

  it('never overwrites the limits an owner tuned in Advanced', () => {
    const tuned = PolicyConfig.parse({
      ...DEFAULT_POLICY,
      tools: { ...DEFAULT_POLICY.tools, mintCheck: { enabled: false, maxPerAskerPerHour: 7, mintCooldownSeconds: 900 } },
    });
    expect(toPolicy(setup(true), tuned).tools.mintCheck).toEqual({ enabled: true, maxPerAskerPerHour: 7, mintCooldownSeconds: 900 });
    expect(toPolicy(setup(false), tuned).tools.mintCheck).toEqual({ enabled: false, maxPerAskerPerHour: 7, mintCooldownSeconds: 900 });
  });
});

describe('what the engagement score does with a request', () => {
  const input = {
    text: `check ${BONK}`,
    directlyAddressed: true,
    relationship: null,
    threadDepth: 0,
    recentRepliesToPerson: 0,
    alreadyRepliedInThread: false,
    policy: DEFAULT_POLICY.engagement,
  };

  it('counts a request as worth answering, and says why', () => {
    const plain = replyValue(input);
    const asked = replyValue({ ...input, evidenceRequest: true });
    expect(asked.value - plain.value).toBe(30);
    expect(asked.factors.map((f) => f.label)).toContain('asked for a sourced reading of a contract');
  });
});

/**
 * Nothing that handles other people's words can pin a watch.
 *
 * The behavioural proof is in the integration test. This is the structural one,
 * in the pattern of `noWalletCapabilities.test.ts`: the confirmation has exactly
 * one caller, the owner's paired Telegram chat, so a new route or step that
 * reaches it is a failing test until somebody writes the reason down.
 */
describe('only the owner can confirm a watch', () => {
  const root = resolve(__dirname, '../..');
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mts)$/.test(full)) out.push(full);
    }
    return out;
  }
  const sources = [...walk(join(root, 'packages')), ...walk(join(root, 'apps'))].map((file) => ({
    file: file.slice(root.length + 1).replaceAll('\\', '/'),
    text: readFileSync(file, 'utf8'),
  }));
  const callers = (needle: RegExp) => sources.filter((s) => needle.test(s.text)).map((s) => s.file).sort();

  it('calls confirmMintWatch from the Telegram commands and nowhere else', () => {
    expect(callers(/\bconfirmMintWatch\b/)).toEqual([
      'packages/runtime/src/mintCheck.ts',
      'packages/runtime/src/telegramCommands.ts',
    ]);
  });

  it('writes the watch columns from one function only', () => {
    expect(callers(/\bmarkWatching\b/)).toEqual([
      'packages/database/src/repositories/mintChecks.ts',
      'packages/runtime/src/mintCheck.ts',
    ]);
    const inMintCheck = sources.find((s) => s.file === 'packages/runtime/src/mintCheck.ts')!.text;
    expect(inMintCheck.match(/markWatching\(/g)).toHaveLength(1);
    expect(inMintCheck.slice(inMintCheck.indexOf('export async function confirmMintWatch'))).toContain('markWatching(');
  });

  it('creates no radar source anywhere in the request path', () => {
    const body = sources.find((s) => s.file === 'packages/runtime/src/mintCheck.ts')!.text;
    const before = body.slice(0, body.indexOf('export async function confirmMintWatch'));
    expect(before).not.toMatch(/upsertSource|radar\./);
  });

  it('keeps the exported surface free of a wallet, a trade or a follow', () => {
    const body = sources.find((s) => s.file === 'packages/runtime/src/mintCheck.ts')!.text;
    // Imports and calls, not the word: this file's own comments say what it never does.
    expect(body).not.toMatch(/from '\.\/(?:wallet\w*|trad\w+|paper\w*|liveTrading|solanaSwap)'|\b(?:signTransaction|sendTransaction|createIntent|putMandate)\b/);
  });
});
