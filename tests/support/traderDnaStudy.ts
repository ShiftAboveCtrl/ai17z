/**
 * A published Trader DNA study as Studio answers it, for tests. The shape is
 * `TraderDnaStudy` in `packages/shared/src/contracts/studioTraderDna.ts`.
 *
 * The wallet addresses are invented: the first is an EVM-shaped placeholder and
 * the second a Solana-shaped one, neither of which belongs to anybody.
 */
export const EVM_WALLET = '0x00000000000000000000000000000000000000aa';
export const SOL_WALLET = '11111111111111111111111111111112';

export function studyFixture(overrides: Record<string, unknown> = {}, now: Date = new Date()): Record<string, unknown> {
  const end = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const start = new Date(now.getTime() - 63 * 86_400_000).toISOString();
  return {
    protocol: 1,
    source: 'ai17z-studio',
    kind: 'TRADER_DNA_STUDY',
    visibility: 'PUBLISHED',
    study_id: 'early-entry-study',
    title: 'Early entries on new pools',
    generated_at: now.toISOString(),
    published_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    window: { start, end },
    evidence_level: 'SURVIVED_FILTERS',
    sample: { wallets: 41, trades: 1530 },
    costs: { fee_bps: 30, slippage_bps: 80, note: 'Fees and slippage as Studio assumes them for every reconstructed trade.' },
    luck_filters: { method: 'BONFERRONI', tests: 24, alpha: '0.05', survivors: 2 },
    contamination_flags: [{ code: 'WASH_TRADING', note: 'Three wallets traded with each other and were removed.' }],
    behaviours: [
      { id: 'b1', summary: 'Wallets that sold half within an hour of entry kept more of their gains', evidence_level: 'SURVIVED_FILTERS', sample_size: 412, adjusted_p: '0.012' },
      { id: 'b2', summary: 'Entries in the first ten minutes of a pool', evidence_level: 'RECONSTRUCTED', sample_size: 96, adjusted_p: null },
      { id: 'b3', summary: 'Buying after a social spike', evidence_level: 'CANDIDATE', sample_size: 12, adjusted_p: null },
    ],
    wallets: [
      { address: EVM_WALLET, label: 'Cohort A, as published' },
      { address: SOL_WALLET, label: null },
    ],
    ...overrides,
  };
}
