import { z } from 'zod';

/**
 * The published facts about $AI17Z that Studio's token page shows, as this
 * installation reads them. Allowlisted by construction: the schema is strict,
 * so a field Studio adds is a refusal until somebody decides it may be said.
 *
 * Deliberately absent: a balance, a holder list, a wallet, a rank, a change
 * figure, a target. The one price here is an observed median over a window
 * that already closed, and nothing in this shape can express a forecast.
 */

export const TOKEN_FACTS_PROTOCOL = 1 as const;

/** Prices travel as decimal strings so no float rounds a figure on the way. */
const Decimal = z.string().regex(/^\d{1,12}(\.\d{1,18})?$/, 'A plain decimal number.');

export const TokenFactsDocument = z
  .object({
    protocol: z.literal(TOKEN_FACTS_PROTOCOL),
    generated_at: z.string().datetime(),
    token: z
      .object({
        symbol: z.string().min(1).max(12),
        chain_id: z.number().int().positive(),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      })
      .strict(),
    holder_requirement: z
      .object({
        /** How many tokens the published rule asks a holder to hold. */
        tokens: Decimal,
      })
      .strict(),
    observed_median_7d: z
      .object({
        price_usd: Decimal,
        window_days: z.literal(7),
        /** When the window closed. */
        observed_at: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TokenFactsDocument = z.infer<typeof TokenFactsDocument>;
