import { z } from 'zod';

/**
 * The three public posts an agent may make about its own paper league season,
 * and the facts each one is built from.
 *
 * `docs/architecture/STUDIO_LEAGUE_SEASON_ARC.md` is the account. This file is
 * the vocabulary the database CHECKs and the runtime share, so a status cannot
 * be added in one place and forgotten in the other.
 *
 * ## What a fact may be
 *
 * Only this agent's own figures: its rank and the size of the field (a count,
 * never a list), how many of its fills Studio counted, and what this
 * installation itself recorded. There is no slot for another entrant, for a
 * wallet, for a return or for a profit, so a post cannot carry one by being
 * built from these.
 */

/** Entry when the agent joins, one standing note mid season, a recap when it ends. */
export const LEAGUE_POST_KINDS = ['ENTRY', 'STANDING', 'RECAP'] as const;
export type LeaguePostKind = (typeof LEAGUE_POST_KINDS)[number];

/**
 * `skipped`: nothing was proposed this time, with the reason, and the next
 * sweep looks again. `proposed`: an idea is in the backlog, and this kind is
 * spent for the season. `closed`: its window passed or it was refused for good.
 */
export const LEAGUE_POST_STATUSES = ['skipped', 'proposed', 'closed'] as const;
export type LeaguePostStatus = (typeof LEAGUE_POST_STATUSES)[number];

export const LeaguePostFacts = z
  .object({
    kind: z.enum(LEAGUE_POST_KINDS),
    seasonSlug: z.string().max(40),
    /** A label Studio published, kept only if it is plain; otherwise the slug stands in. */
    seasonLabel: z.string().max(60),
    rank: z.number().int().positive().nullable(),
    field: z.number().int().positive().nullable(),
    fillsCounted: z.number().int().nonnegative().nullable(),
    /** Recap only: fills this installation reported that Studio did not count. */
    fillsNotCounted: z.number().int().nonnegative().nullable(),
    /** Recap only: radar receipts this agent published inside the season window. */
    receiptsPosted: z.number().int().nonnegative().nullable(),
    /** Recap only: the rank the midway standing note stated, so the recap can say what changed. */
    midwayRank: z.number().int().positive().nullable(),
    /** The generated_at of the Studio document the figures came from. */
    standingAt: z.string().nullable(),
  })
  .strict();
export type LeaguePostFacts = z.infer<typeof LeaguePostFacts>;
