import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, PolicyConfig, TRADER_DNA_STUDY_ID, TraderDnaStudy } from '@xbam/shared/contracts';
import { listCapabilities, resetCapabilitiesForTest } from '@xbam/tools';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../packages/runtime/src/studioLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/runtime/src/studioLink')>()),
  studioInstallationRequest: request,
  studioInstallationReady: async () => ({ linked: true as const }),
}));

import * as studioTraderDna from '../../packages/runtime/src/studioTraderDna';
import * as studioTraderDnaCapabilities from '../../packages/runtime/src/studioTraderDnaCapabilities';
import {
  NOTHING_TRADED,
  TRADER_DNA_IDEA_SOURCE,
  checkTraderDnaAtSend,
  checkTraderDnaText,
  describeTraderDna,
  readTraderDnaStudy,
  traderDnaIdeaFrom,
} from '../../packages/runtime/src/studioTraderDna';
import { STUDIO_TRADER_DNA_CAPABILITIES, registerStudioTraderDnaCapabilities } from '../../packages/runtime/src/studioTraderDnaCapabilities';
import { shortlistCapabilities } from '../../packages/runtime/src/capabilityRelevance';
import { EVM_WALLET, SOL_WALLET, studyFixture } from '../support/traderDnaStudy';

const answer = (body: unknown, status = 200) => ({ ok: true as const, status, body, sentence: `Studio answered ${status}.` });
const study = (overrides: Record<string, unknown> = {}): TraderDnaStudy => TraderDnaStudy.parse(studyFixture(overrides));

beforeEach(() => {
  request.mockReset();
});

describe('the contract is an allowlist of a published study', () => {
  it('accepts a published study and refuses fields Studio was never meant to publish', () => {
    expect(TraderDnaStudy.safeParse(studyFixture()).success).toBe(true);
    for (const extra of [{ operator_notes: 'x' }, { owner_email: 'a@b.invalid' }, { follow_list: [] }, { live_balance: '1' }, { price_target: '2' }]) {
      expect(TraderDnaStudy.safeParse(studyFixture(extra)).success, JSON.stringify(extra)).toBe(false);
    }
    const base = studyFixture();
    expect(TraderDnaStudy.safeParse({ ...base, costs: { ...(base.costs as object), private_note: 'x' } }).success).toBe(false);
    expect(TraderDnaStudy.safeParse({ ...base, wallets: [{ address: EVM_WALLET, label: null, score: 9 }] }).success).toBe(false);
  });

  it('refuses a draft or an operator run, however it arrived', () => {
    for (const visibility of ['DRAFT', 'OPERATOR', 'UNPUBLISHED', 'PRIVATE']) {
      expect(TraderDnaStudy.safeParse(studyFixture({ visibility })).success, visibility).toBe(false);
    }
    expect(TraderDnaStudy.safeParse(studyFixture({ kind: 'OPERATOR_RUN' })).success).toBe(false);
  });

  it('refuses an inconsistent study and anything that is not a wallet address', () => {
    expect(TraderDnaStudy.safeParse(studyFixture({ luck_filters: { method: 'BONFERRONI', tests: 2, alpha: '0.05', survivors: 5 } })).success).toBe(false);
    const base = studyFixture();
    const unproven = [{ id: 'b1', summary: 'x', evidence_level: 'SURVIVED_FILTERS', sample_size: 10, adjusted_p: null }];
    expect(TraderDnaStudy.safeParse({ ...base, behaviours: unproven }).success).toBe(false);
    expect(TraderDnaStudy.safeParse(studyFixture({ evidence_level: 'SURVIVED_FILTERS', behaviours: [] })).success).toBe(false);
    expect(TraderDnaStudy.safeParse(studyFixture({ wallets: [{ address: 'not-an-address', label: null }] })).success).toBe(false);
    expect(TraderDnaStudy.safeParse(studyFixture({ window: { start: '2026-02-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' } })).success).toBe(false);
  });

  it('refuses fewer survivors than behaviours that say they survived', () => {
    const base = studyFixture();
    const survivedTwice = [
      { id: 'b1', summary: 'Selling in tranches', evidence_level: 'SURVIVED_FILTERS', sample_size: 30, adjusted_p: '0.02' },
      { id: 'b2', summary: 'Exiting before an unlock', evidence_level: 'SURVIVED_FILTERS', sample_size: 30, adjusted_p: '0.03' },
    ];
    const filters = (survivors: number) => ({ method: 'BONFERRONI', tests: 24, alpha: '0.05', survivors });
    expect(TraderDnaStudy.safeParse({ ...base, behaviours: survivedTwice, luck_filters: filters(0) }).success).toBe(false);
    expect(TraderDnaStudy.safeParse({ ...base, behaviours: survivedTwice, luck_filters: filters(1) }).success).toBe(false);
    expect(TraderDnaStudy.safeParse({ ...base, behaviours: survivedTwice, luck_filters: filters(2) }).success).toBe(true);
    // The fixture's one surviving behaviour with a count of zero is the case the review found.
    expect(TraderDnaStudy.safeParse(studyFixture({ luck_filters: filters(0) })).success).toBe(false);
    // A study with no surviving behaviour may still report survivors it chose not to publish.
    expect(TraderDnaStudy.safeParse(studyFixture({ evidence_level: 'RECONSTRUCTED', behaviours: [], luck_filters: filters(3) })).success).toBe(true);
  });
});

describe('reading a study reaches the published route and nothing else', () => {
  it('asks only for the published address of a well formed id', async () => {
    request.mockResolvedValue(answer(studyFixture()));
    const read = await readTraderDnaStudy('early-entry-study');
    expect(read.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/api/v1/installation/trader-dna/studies/early-entry-study', { method: 'GET' });
  });

  it('never makes a request for an id that is not a plain study id', async () => {
    for (const id of ['', 'ab', '../token', 'a/b', 'Upper-Case', 'x?draft=1', 'x#y', 'a'.repeat(80), 'operator/run-1', '-lead']) {
      expect(TRADER_DNA_STUDY_ID.test(id), id).toBe(false);
      const read = await readTraderDnaStudy(id);
      expect(read.ok, id).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('treats an unpublished id as unreachable: Studio says 404 and nothing is used', async () => {
    request.mockResolvedValue(answer({ error: 'not_found' }, 404));
    const read = await readTraderDnaStudy('draft-study-77');
    expect(read).toEqual({ ok: false, why: 'Studio has no published study with that id.' });
    expect(request).toHaveBeenCalledTimes(1);
    // Same published route as any other id: there is no second address for a draft or an operator run.
    expect(request.mock.calls[0]![0]).toBe('/api/v1/installation/trader-dna/studies/draft-study-77');
  });

  it('refuses an operator run or a draft a server sent anyway, and a study for another id', async () => {
    request.mockResolvedValue(answer(studyFixture({ visibility: 'OPERATOR' })));
    expect((await readTraderDnaStudy('early-entry-study')).ok).toBe(false);
    request.mockResolvedValue(answer(studyFixture({ study_id: 'another-study' })));
    expect(await readTraderDnaStudy('early-entry-study')).toMatchObject({ ok: false, why: expect.stringMatching(/different study/) });
  });

  it('refuses a stale or future answer, an unreachable Studio and malformed bodies', async () => {
    const old = new Date(Date.now() - 3_600_000);
    request.mockResolvedValue(answer(studyFixture({ generated_at: old.toISOString() })));
    expect(await readTraderDnaStudy('early-entry-study')).toMatchObject({ ok: false, why: expect.stringMatching(/not current/) });
    request.mockResolvedValue({ ok: false, why: 'Studio could not be reached: down' });
    expect((await readTraderDnaStudy('early-entry-study')).ok).toBe(false);
    request.mockResolvedValue(answer({ hello: 'world' }));
    expect((await readTraderDnaStudy('early-entry-study')).ok).toBe(false);
    request.mockResolvedValue(answer({}, 500));
    expect((await readTraderDnaStudy('early-entry-study')).ok).toBe(false);
  });
});

describe('what the agent says when asked', () => {
  it('carries the evidence level, sample, cost assumption, window and that nothing was traded', () => {
    const said = describeTraderDna(study());
    expect(said.state).toBe('AVAILABLE');
    expect(said.statement).toMatch(/Early entries on new pools/);
    expect(said.statement).toMatch(/survived the luck filters/);
    expect(said.statement).toMatch(/41 wallets and 1530 trades/);
    expect(said.statement).toMatch(/30 bps in fees and 80 bps of slippage/);
    expect(said.statement).toMatch(/\d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/);
    expect(said.statement).toMatch(/Bonferroni over 24 tests/);
    expect(said.statement).toMatch(/wash trading/);
    expect(said.statement.endsWith(NOTHING_TRADED)).toBe(true);
  });

  it('separates what survived from what is only reconstructed and from candidates', () => {
    const said = describeTraderDna(study()).statement;
    expect(said).toMatch(/Survived the filters: Wallets that sold half[^.]*\.[^.]*adjusted p 0\.012/);
    expect(said).toMatch(/Only reconstructed, not shown to survive: Entries in the first ten minutes/);
    expect(said).toMatch(/Candidates, never traded: Buying after a social spike/);
    const none = describeTraderDna(study({ evidence_level: 'RECONSTRUCTED', behaviours: [] })).statement;
    expect(none).toMatch(/No behaviour is shown to have survived the filters/);
  });

  it('gives no number for a zero sample, and says so', () => {
    for (const sample of [{ wallets: 0, trades: 0 }, { wallets: 5, trades: 0 }, { wallets: 0, trades: 40 }]) {
      const said = describeTraderDna(study({ sample }));
      expect(said.state, JSON.stringify(sample)).toBe('UNAVAILABLE');
      expect(said.statement).toMatch(/no sample/);
      expect(said.statement).not.toMatch(/\d+ wallets|\d+ trades|bps|adjusted p|Bonferroni/);
      expect(said.statement.endsWith(NOTHING_TRADED)).toBe(true);
    }
  });

  it('gives no number for a stale study, and says so', () => {
    const now = new Date();
    const end = new Date(now.getTime() - 400 * 86_400_000).toISOString();
    const start = new Date(now.getTime() - 460 * 86_400_000).toISOString();
    const said = describeTraderDna(study({ window: { start, end } }), now);
    expect(said.state).toBe('UNAVAILABLE');
    expect(said.statement).toMatch(/too long ago/);
    expect(said.statement).not.toMatch(/\d+ wallets|\d+ trades|bps|adjusted p/);
  });

  it('says each evidence level as a sentence with a verb', () => {
    const said = describeTraderDna(study()).statement;
    expect(said).toMatch(/the findings survived the luck filters\./);
    const candidate = describeTraderDna(study({ evidence_level: 'CANDIDATE', behaviours: [] })).statement;
    expect(candidate).toMatch(/the findings are only a candidate that was never traded\./);
    const rebuilt = describeTraderDna(study({ evidence_level: 'RECONSTRUCTED', behaviours: [] })).statement;
    expect(rebuilt).toMatch(/the findings were reconstructed from the chain only\./);
  });

  it('leaves out a behaviour with no observations instead of reporting "(0 observations)"', () => {
    const behaviours = [
      { id: 'b1', summary: 'Selling in tranches', evidence_level: 'SURVIVED_FILTERS', sample_size: 30, adjusted_p: '0.02' },
      { id: 'b2', summary: 'Selling into strength', evidence_level: 'SURVIVED_FILTERS', sample_size: 0, adjusted_p: '0.02' },
      { id: 'b3', summary: 'Entering on a Monday', evidence_level: 'RECONSTRUCTED', sample_size: 0, adjusted_p: null },
      { id: 'b4', summary: 'Buying dips', evidence_level: 'CANDIDATE', sample_size: 0, adjusted_p: null },
    ];
    const said = describeTraderDna(study({ behaviours, luck_filters: { method: 'BONFERRONI', tests: 24, alpha: '0.05', survivors: 2 } })).statement;
    expect(said).toMatch(/Selling in tranches\. \(30 observations/);
    expect(said).not.toMatch(/Selling into strength|Entering on a Monday|Buying dips|\(0 observations/);
    const onlyEmpty = describeTraderDna(study({ behaviours: [behaviours[1]], luck_filters: { method: 'BONFERRONI', tests: 24, alpha: '0.05', survivors: 1 } })).statement;
    expect(onlyEmpty).toMatch(/No behaviour is shown to have survived the filters/);
    expect(onlyEmpty).not.toMatch(/\(0 observations/);
  });

  it('gives no figures for a window that ends, or a publication dated, in the future', () => {
    const now = new Date();
    const later = new Date(now.getTime() + 10 * 86_400_000).toISOString();
    const earlier = new Date(now.getTime() - 50 * 86_400_000).toISOString();
    const futureWindow = describeTraderDna(study({ window: { start: earlier, end: later } }), now);
    expect(futureWindow.state).toBe('UNAVAILABLE');
    expect(futureWindow.statement).toMatch(/in the future/);
    expect(futureWindow.statement).not.toMatch(/\d+ wallets|\d+ trades|bps|adjusted p/);
    const futurePublished = describeTraderDna(study({ published_at: later }), now);
    expect(futurePublished.state).toBe('UNAVAILABLE');
    expect(futurePublished.statement).toMatch(/future/);
    expect(traderDnaIdeaFrom(study({ window: { start: earlier, end: later } }), now)).toBeNull();
    expect(traderDnaIdeaFrom(study({ published_at: later }), now)).toBeNull();
    // A few minutes of clock difference is not a future study.
    const slightly = new Date(now.getTime() + 60_000).toISOString();
    expect(describeTraderDna(study({ window: { start: earlier, end: slightly } }), now).state).toBe('AVAILABLE');
  });

  it('never ranks or praises a wallet', () => {
    const said = describeTraderDna(study()).statement;
    expect(said).not.toContain(EVM_WALLET);
    expect(said).toMatch(/says nothing about whether to follow it/);
    expect(said).not.toMatch(/smart|best|top wallet|worth copying/i);
  });
});

describe('the capability', () => {
  const cap = STUDIO_TRADER_DNA_CAPABILITIES[0]!;
  const run = (input: unknown) => (cap as unknown as { run: (i: unknown, c: unknown) => Promise<Record<string, unknown>> }).run(input, {});

  it('is one owner only read, off until the owner enables it', () => {
    expect(STUDIO_TRADER_DNA_CAPABILITIES).toHaveLength(1);
    expect(cap.id).toBe('studio.trader_dna');
    expect(cap.effect).toBe('READ');
    expect(cap.risk).toBe('LOW');
    expect(cap.unsetPermission).toBe('DISABLED');
    expect(cap.audience).toBe('OWNER');
    expect(cap.modelCallable).toBe(true);
  });

  it('returns UNAVAILABLE for an unpublished id, with no figures and no wallets', async () => {
    request.mockResolvedValue(answer({ error: 'not_found' }, 404));
    const out = await run({ study: 'draft-study-77' });
    expect(out.state).toBe('UNAVAILABLE');
    expect(out.nothingTraded).toBe(true);
    expect(out.sample).toBeNull();
    expect(out.evidenceLevel).toBeNull();
    expect(out.behaviours).toEqual([]);
    expect(out.wallets).toEqual([]);
    expect(String(out.statement)).toMatch(/Studio has no published study/);
    expect(String(out.statement).endsWith(NOTHING_TRADED)).toBe(true);
  });

  it('returns the study with wallets exactly as published, and no score of its own', async () => {
    request.mockResolvedValue(answer(studyFixture()));
    const out = await run({ study: 'early-entry-study' });
    expect(out.state).toBe('AVAILABLE');
    expect(out.evidenceLevel).toBe('SURVIVED_FILTERS');
    expect(out.sample).toEqual({ wallets: 41, trades: 1530 });
    expect(out.costAssumption).toMatchObject({ feeBps: 30, slippageBps: 80 });
    expect(out.wallets).toEqual([
      { address: EVM_WALLET, label: 'Cohort A, as published' },
      { address: SOL_WALLET, label: null },
    ]);
    expect(Object.keys((out.wallets as object[])[0]!).sort()).toEqual(['address', 'label']);
    expect(String(out.statement).endsWith(NOTHING_TRADED)).toBe(true);
  });

  it('returns UNAVAILABLE with no headline number for a zero sample study', async () => {
    request.mockResolvedValue(answer(studyFixture({ sample: { wallets: 0, trades: 0 } })));
    const out = await run({ study: 'early-entry-study' });
    expect(out.state).toBe('UNAVAILABLE');
    expect(out.sample).toBeNull();
    expect(out.behaviours).toEqual([]);
    expect(out.wallets).toEqual([]);
  });

  it('is shortlisted for a question about smart wallets and not for banter', () => {
    expect(shortlistCapabilities(STUDIO_TRADER_DNA_CAPABILITIES, 'who are the smart wallets in that study?').offered.map((c) => c.id)).toEqual(['studio.trader_dna']);
    expect(shortlistCapabilities(STUDIO_TRADER_DNA_CAPABILITIES, 'what did the trader dna study find?').offered.map((c) => c.id)).toEqual(['studio.trader_dna']);
    expect(shortlistCapabilities(STUDIO_TRADER_DNA_CAPABILITIES, 'nice one').offered).toHaveLength(0);
  });
});

describe('the study has no way to be followed', () => {
  const FOLLOW_VERB = /follow|watch|mandate|order|copy|mirror|buy|sell|swap|submit|trade_|importWallet|addWallet|subscribe|track/i;

  it('exports no write or follow verb from either module', () => {
    const names = [...Object.keys(studioTraderDna), ...Object.keys(studioTraderDnaCapabilities)];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => FOLLOW_VERB.test(n.replace(/NOTHING_TRADED|TRADER_DNA|TraderDna|traderDna/g, '')))).toEqual([]);
  });

  it('registers exactly one capability for it, with no write effect anywhere near', () => {
    resetCapabilitiesForTest();
    registerStudioTraderDnaCapabilities();
    const registered = listCapabilities();
    expect(registered.map((c) => c.id)).toEqual(['studio.trader_dna']);
    expect(registered.every((c) => c.effect === 'READ')).toBe(true);
    resetCapabilitiesForTest();
  });

  it('imports no wallet, trading, mandate, radar or watch module', () => {
    for (const file of ['studioTraderDna.ts', 'studioTraderDnaCapabilities.ts']) {
      const text = readFileSync(join(__dirname, '..', '..', 'packages', 'runtime', 'src', file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/wallet|trading|paperTrading|mandate|radar|watch|studioRisk|studioLiveTrades|leagueSeason|playbook/i);
      }
      expect(text, file).not.toMatch(/\b(trading|leagueBridge|radarSources)\./);
      expect(text, file).not.toMatch(/\.sign\(|\.broadcast\(|submitIntent|draftIntent/);
    }
  });
});

describe('posting a study is a separate opt-in', () => {
  const GOOD =
    'Studio published a study of 41 wallets over 60 days, and one behaviour survived its luck filters: selling half an hour in. Nothing was traded; this is research only.';

  it('is off by default', () => {
    expect(DEFAULT_POLICY.studio.postTraderDna).toBe(false);
    expect(DEFAULT_POLICY.studio.traderDnaStudyId).toBeNull();
    expect(PolicyConfig.safeParse({ studio: { traderDnaStudyId: '../x' } }).success).toBe(false);
  });

  it('makes an idea only from a study whose findings survived, with a sample, in date', () => {
    const idea = traderDnaIdeaFrom(study())!;
    expect(idea).not.toBeNull();
    expect(idea.summary).toMatch(/Early entries on new pools/);
    expect(idea.summary).toMatch(/41 wallets, 1530 trades/);
    expect(idea.summary).toMatch(/Behaviour: Wallets that sold half/);
    expect(idea.summary).not.toMatch(/Buying after a social spike|Entries in the first ten minutes/);
    expect(idea.summary).not.toContain(EVM_WALLET);
    expect(idea.detail).toMatch(/nothing was traded/i);
    expect(idea.detail).toMatch(/Do not name, quote or describe any wallet address/);
    expect(idea.key).toMatch(/^early-entry-study@/);

    expect(traderDnaIdeaFrom(study({ evidence_level: 'RECONSTRUCTED', behaviours: [] }))).toBeNull();
    expect(traderDnaIdeaFrom(study({ sample: { wallets: 0, trades: 0 } }))).toBeNull();
    const end = new Date(Date.now() - 400 * 86_400_000).toISOString();
    expect(traderDnaIdeaFrom(study({ window: { start: end, end } }))).toBeNull();
  });

  it('drops a behaviour that already praises or names a wallet, and makes no idea if none is left', () => {
    const praise = [
      { id: 'b1', summary: 'The smart wallets here sold early', evidence_level: 'SURVIVED_FILTERS', sample_size: 10, adjusted_p: '0.01' },
      { id: 'b2', summary: `Wallet ${EVM_WALLET} was worth copying`, evidence_level: 'SURVIVED_FILTERS', sample_size: 10, adjusted_p: '0.01' },
    ];
    const moreSurvivors = { method: 'BONFERRONI', tests: 24, alpha: '0.05', survivors: 3 };
    expect(traderDnaIdeaFrom(study({ behaviours: praise, luck_filters: moreSurvivors }))).toBeNull();
    const mixed = traderDnaIdeaFrom(study({ luck_filters: moreSurvivors, behaviours: [...praise, { id: 'b3', summary: 'Selling in tranches', evidence_level: 'SURVIVED_FILTERS', sample_size: 30, adjusted_p: '0.02' }] }))!;
    expect(mixed.summary).toMatch(/Selling in tranches/);
    expect(mixed.summary).not.toMatch(/smart|worth copying|0x/);
  });

  it('leaves a zero observation behaviour out of the idea', () => {
    const behaviours = [
      { id: 'b1', summary: 'Selling in tranches', evidence_level: 'SURVIVED_FILTERS', sample_size: 0, adjusted_p: '0.02' },
      { id: 'b2', summary: 'Exiting before an unlock', evidence_level: 'SURVIVED_FILTERS', sample_size: 25, adjusted_p: '0.02' },
    ];
    const idea = traderDnaIdeaFrom(study({ behaviours }))!;
    expect(idea.summary).toMatch(/Exiting before an unlock/);
    expect(idea.summary).not.toMatch(/Selling in tranches|\(0 observations/);
    expect(traderDnaIdeaFrom(study({ behaviours: [behaviours[0]], luck_filters: { method: 'BONFERRONI', tests: 24, alpha: '0.05', survivors: 1 } }))).toBeNull();
  });

  it('does not quote a study title that makes a claim about a wallet', () => {
    const praised = traderDnaIdeaFrom(study({ title: 'The top 5 wallets on new pools' }))!;
    expect(praised.summary).not.toMatch(/top 5 wallets/i);
    expect(praised.summary).toMatch(/^Studio's published Trader DNA study, /);
    const named = traderDnaIdeaFrom(study({ title: `Why ${EVM_WALLET} wins` }))!;
    expect(named.summary).not.toContain('0x');
    const plain = traderDnaIdeaFrom(study())!;
    expect(plain.summary).toMatch(/study "Early entries on new pools"/);
  });

  it('catches wallet claims in every shape a sentence can take them, and leaves ordinary register alone', () => {
    const claims = [
      'This wallet is smart.',
      'These traders are profitable',
      'the wallets in this cohort are geniuses',
      'The top 5 wallets',
      'the best performing wallets',
      'these wallets are worth keeping an eye on',
      'Wallets worth a follow',
      'That whale is sharp',
      'The cohort looks elite',
      'Their wallets were consistently good',
      "That trader's smart",
    ];
    const fine = [
      'a wallet is just an address',
      'the worker died',
      'Wallets that sold half within an hour of entry kept more of their gains',
      'The study of 41 wallets is worth reading',
      'Most traders in the sample held for under a day',
      'The tests were corrected for the number of hypotheses',
    ];
    const frame = (phrase: string) => `A Studio study. ${phrase}. Nothing was traded.`;
    for (const phrase of claims) {
      expect(checkTraderDnaText(frame(phrase)).join(' '), phrase).toMatch(/claim about a wallet/);
      const behaviours = [{ id: 'b1', summary: phrase, evidence_level: 'SURVIVED_FILTERS', sample_size: 10, adjusted_p: '0.01' }];
      expect(traderDnaIdeaFrom(study({ behaviours })), phrase).toBeNull();
    }
    for (const phrase of fine) {
      expect(checkTraderDnaText(frame(phrase)), phrase).toEqual([]);
      const behaviours = [{ id: 'b1', summary: phrase, evidence_level: 'SURVIVED_FILTERS', sample_size: 10, adjusted_p: '0.01' }];
      expect(traderDnaIdeaFrom(study({ behaviours })), phrase).not.toBeNull();
    }
  });

  it('accepts a post that explains the study and blocks every wallet level claim', () => {
    expect(checkTraderDnaText(GOOD)).toEqual([]);
    const bad: Array<[string, RegExp]> = [
      ['The study found these are smart wallets. Nothing was traded.', /claim about a wallet/],
      ['Smart money behaves like this, says a Studio study. Nothing was traded.', /claim about a wallet/],
      ['A Studio study of wallets worth copying. Nothing was traded.', /claim about a wallet/],
      ['A Studio study says to copy trade these wallets. Nothing was traded.', /claim about a wallet/],
      ['A Studio study says follow this trader. Nothing was traded.', /claim about a wallet/],
      [`A Studio study listed ${EVM_WALLET}. Nothing was traded.`, /wallet address/],
      [`A Studio study listed ${SOL_WALLET}. Nothing was traded.`, /wallet address/],
      ['A Studio study of 41 wallets. It will keep paying. Nothing was traded.', /promise, a signal or advice/],
      ['A study of 41 wallets, with signals. Nothing was traded, says Studio.', /promise, a signal or advice/],
      ['A Studio study of 41 wallets, one behaviour survived.', /nothing was traded/],
      ['Wallets sold early, nothing was traded.', /attribute the study/],
    ];
    for (const [text, expected] of bad) {
      expect(checkTraderDnaText(text).join(' '), text).toMatch(expected);
    }
  });

  it('checks the finished text at the moment of sending, and only for posts made from a study', () => {
    const on = PolicyConfig.parse({ studio: { postTraderDna: true, traderDnaStudyId: 'early-entry-study' } });
    const raw = { origin: 'self', ideaSource: TRADER_DNA_IDEA_SOURCE };
    expect(() => checkTraderDnaAtSend({ raw, text: GOOD, policy: on })).not.toThrow();
    expect(() => checkTraderDnaAtSend({ raw, text: 'These smart wallets are worth copying.', policy: on })).toThrow(/needs the owner/);
    // Switched off between the idea and the send: stopped for good, not sent to review.
    try {
      checkTraderDnaAtSend({ raw, text: GOOD, policy: PolicyConfig.parse({}) });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as { code?: string }).code ?? (error as Error).message).toMatch(/trader_dna_posting_off|switched off/);
    }
    for (const other of [{ origin: 'self', ideaSource: 'deliberation' }, null]) {
      expect(() => checkTraderDnaAtSend({ raw: other, text: 'These smart wallets are worth copying.', policy: on })).not.toThrow();
    }
  });
});
