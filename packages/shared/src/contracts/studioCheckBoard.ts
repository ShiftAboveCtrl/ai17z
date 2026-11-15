import { z } from 'zod';

/**
 * "Most checked": the frozen payloads between an installation and the Studio
 * checks board, protocol 1. Studio copies `tests/fixtures/studio-check-board.json`
 * byte for byte and must accept and serve exactly these shapes.
 *
 * Contribution (installation to Studio) is a mint, an hour bucket and an
 * anonymous count of distinct askers. It carries no handle, no post text, no
 * agent, no owner and no asker identifier of any kind. Every schema is strict,
 * so a field added here without a protocol change is a refusal, not a leak.
 *
 * Board (Studio to installation) is counts and the measured fields Studio holds
 * for the mint. Absent is never zero: a reading Studio could not take is null.
 */

export const CHECK_BOARD_CHAINS = ['solana', 'ethereum', 'bnb', 'base', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'robinhood'] as const;
/** Mirrors the chains an evidence card can read. */
export const CheckBoardChain = z.enum(CHECK_BOARD_CHAINS);

/** Shape only: the address is whatever the reader gave, EVM lower-cased, never interpreted here. */
export const CheckBoardMint = z.string().regex(/^(?:0x[a-f0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);

/** A mint appears on the board only with at least this many distinct askers, summed across installations. */
export const CHECK_BOARD_MIN_ASKERS = 3;
export const CHECK_BOARD_WINDOW_HOURS = 24;
export const CHECK_BOARD_MAX_CONTRIBUTIONS = 100;
export const CHECK_BOARD_MAX_ROWS = 25;
/** One hour wide, aligned to the UTC hour, so a count says nothing about when inside it. */
export const CHECK_BOARD_BUCKET_MS = 3_600_000;

export const CheckBoardBucket = z.string().datetime().refine(
  (iso) => Date.parse(iso) % CHECK_BOARD_BUCKET_MS === 0,
  'A bucket starts on the UTC hour.',
);

export const CheckContribution = z.object({
  chain: CheckBoardChain,
  mint: CheckBoardMint,
  bucket_start: CheckBoardBucket,
  /** Distinct askers in that hour who had not asked about the mint in the previous 24 hours. At least one. */
  askers: z.number().int().min(1).max(100_000),
}).strict();
export type CheckContribution = z.infer<typeof CheckContribution>;

/** POST /api/v1/installation/check-board/contributions. Replace semantics per installation, mint and bucket. */
export const CheckContributionBatch = z.object({
  protocol: z.literal(1),
  contributions: z.array(CheckContribution).max(CHECK_BOARD_MAX_CONTRIBUTIONS),
}).strict();
export type CheckContributionBatch = z.infer<typeof CheckContributionBatch>;

/** Studio's answer to a contribution. */
export const CheckContributionReceipt = z.object({ protocol: z.literal(1), accepted: z.literal(true) }).strict();

const BoardReading = z.object({
  label: z.string().min(1).max(40),
  /** Null when Studio could not take it. Never a stand-in zero. */
  value: z.union([z.number().min(0), z.boolean()]).nullable(),
  unit: z.enum(['USD', '%', 'hours', 'authority']),
  source: z.string().min(1).max(40),
  observed_at: z.string().datetime().nullable(),
}).strict();

export const CheckBoardRow = z.object({
  chain: CheckBoardChain,
  mint: CheckBoardMint,
  askers: z.number().int().min(1),
  readings: z.array(BoardReading).max(6),
}).strict();
export type CheckBoardRow = z.infer<typeof CheckBoardRow>;

/** GET /api/v1/installation/check-board. Rows are ordered by `askers`, descending, and by nothing else. */
export const CheckBoard = z.object({
  protocol: z.literal(1),
  generated_at: z.string().datetime(),
  window_hours: z.literal(CHECK_BOARD_WINDOW_HOURS),
  min_askers: z.number().int().min(CHECK_BOARD_MIN_ASKERS),
  rows: z.array(CheckBoardRow).max(CHECK_BOARD_MAX_ROWS),
}).strict().superRefine((board, ctx) => {
  board.rows.forEach((row, index) => {
    if (row.askers < board.min_askers) ctx.addIssue({ code: 'custom', message: 'A row is below the floor.' });
    if (index > 0 && row.askers > board.rows[index - 1]!.askers) ctx.addIssue({ code: 'custom', message: 'Rows are ordered by count only.' });
  });
  if (new Set(board.rows.map((row) => `${row.chain}:${row.mint}`)).size !== board.rows.length) {
    ctx.addIssue({ code: 'custom', message: 'A mint appears once.' });
  }
});
export type CheckBoard = z.infer<typeof CheckBoard>;
