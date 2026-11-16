import { z } from 'zod';
import { CheckBoard } from './studioCheckBoard';

/**
 * "Talked about against checked": the frozen payloads between an installation and
 * Studio for the daily narrative pulse, protocol 1. Studio copies
 * `tests/fixtures/studio-narrative-pulse.json` byte for byte.
 *
 * Studio to installation: the day's checked counts per mint, in exactly the shape
 * of the most checked board. Counts only; absent is never zero.
 *
 * Installation to Studio (optional, its own owner switch): a term, its share of the
 * posts read, how many distinct accounts used it and when the window ended. No
 * author, no handle, no post text and no agent or owner id. Every schema is strict,
 * so a field added without a protocol change is a refusal, not a leak.
 */

/** The same floor `narratives.ts` applies. A test pins the two together. */
export const NARRATIVE_PULSE_MIN_AUTHORS = 3;
export const NARRATIVE_PULSE_MAX_TERMS = 8;
export const NARRATIVE_PULSE_WINDOW_MS = 3_600_000;

/** A subject as `termsIn` writes it: lower-case, optionally a cashtag or hashtag, never a handle or a link. */
export const NarrativeTerm = z.string().regex(/^[$#]?[\p{L}\p{N}][\p{L}\p{N}'’-]{2,39}$/u);

export const NarrativeTermContribution = z.object({
  term: NarrativeTerm,
  /** Share of the posts read in the window that mention it, above 0 and at most 1. */
  share: z.number().gt(0).max(1),
  distinctAuthors: z.number().int().min(NARRATIVE_PULSE_MIN_AUTHORS).max(100_000),
  /** Aligned to the UTC hour, so it says nothing finer about when. */
  windowEnd: z.string().datetime().refine((iso) => Date.parse(iso) % NARRATIVE_PULSE_WINDOW_MS === 0, 'A window ends on the UTC hour.'),
}).strict();
export type NarrativeTermContribution = z.infer<typeof NarrativeTermContribution>;

/** POST /api/v1/installation/narrative-pulse. Replace semantics per installation and window end. */
export const NarrativeTermBatch = z.object({
  protocol: z.literal(1),
  terms: z.array(NarrativeTermContribution).max(NARRATIVE_PULSE_MAX_TERMS),
}).strict();
export type NarrativeTermBatch = z.infer<typeof NarrativeTermBatch>;

export const NarrativeTermReceipt = z.object({ protocol: z.literal(1), accepted: z.literal(true) }).strict();

/** GET /api/v1/installation/narrative-pulse: the day's checked counts, as the most checked board. */
export const NarrativePulseChecks = CheckBoard;
export type NarrativePulseChecks = z.infer<typeof NarrativePulseChecks>;
