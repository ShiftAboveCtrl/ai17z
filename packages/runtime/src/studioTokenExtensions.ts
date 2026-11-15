import { z } from 'zod';
import type { MintExtensions } from '@xbam/prompts';

/**
 * The Token-2022 extension card Studio draws on its check page.
 *
 * This is the shape this installation produces for
 * `GET /api/v1/installation/token-extensions?chain=solana&address=` and the shape
 * Studio's page reads. It is its own payload and is deliberately not part of the
 * evidence card picture request, which is frozen at five labels
 * (`studioEvidenceCardImage.ts`): a sixth never goes into that one.
 *
 * `.strict()` at every level, so a field somebody adds later is a refusal until
 * this schema, `tests/fixtures/studioTokenExtensions.json` and the test that pins
 * them change together. It carries the token (public), what the mint's bytes
 * said with its source and time, and the fixed line that this is not a verdict.
 * No post, handle, asker or job.
 *
 * **Nothing sends this yet.** There is no route on this installation that serves it
 * and no sender that pushes it to Studio: this file is the schema, the pure builder
 * `tokenExtensionsAnswer` and a fixture, so the two sides can agree on the shape.
 * Which direction it travels (Studio fetching it from the installation, or the
 * installation pushing it) is the Studio lane's decision and is not made here. It
 * also carries the fee in effect only, not the scheduled change the card lines show;
 * widening it is a change to this schema, the fixture and Studio's reader together.
 *
 * `status` is the first thing to read. Under `read`, a null field means that
 * extension is not on the mint. Under `unread` every field is null and says
 * nothing about the token: it is never a zero fee. `isToken2022` is null when
 * the program could not be established.
 */
export const TOKEN_EXTENSIONS_PATH = '/api/v1/installation/token-extensions';
export const TOKEN_EXTENSIONS_DISCLAIMER = 'not a verdict, reads can be wrong';

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const Iso = z.string().max(40).refine((v) => Number.isFinite(Date.parse(v)), 'not a timestamp');

export const TokenExtensionsAnswer = z.strictObject({
  protocol: z.literal(1),
  chain: z.literal('solana'),
  address: z.string().regex(SOLANA_MINT),
  status: z.enum(['read', 'not_applicable', 'unread']),
  isToken2022: z.boolean().nullable(),
  /** Basis points in effect when read. Null with `status: read` means no transfer fee extension. */
  transferFeeBps: z.number().int().min(0).max(65535).nullable(),
  /** The cap on one transfer's fee, an exact integer in the token's smallest unit. */
  maxFee: z.string().regex(/^\d{1,20}$/).nullable(),
  permanentDelegate: z.string().regex(SOLANA_MINT).nullable(),
  transferHookProgram: z.string().regex(SOLANA_MINT).nullable(),
  defaultAccountState: z.enum(['initialized', 'frozen']).nullable(),
  /** Extension type ids present on the mint that this installation does not decode. */
  unparsedExtensionTypeIds: z.array(z.number().int().min(0).max(65535)).max(64),
  source: z.string().regex(/^[a-z0-9_.-]{1,80}$/),
  fetched_at: Iso.nullable(),
  disclaimer: z.literal(TOKEN_EXTENSIONS_DISCLAIMER),
});
export type TokenExtensionsAnswer = z.infer<typeof TokenExtensionsAnswer>;

/** Pure: the answer for one mint, or null when what was read is not shaped like one. */
export function tokenExtensionsAnswer(address: string, ext: MintExtensions): TokenExtensionsAnswer | null {
  const read = ext.status === 'read' ? ext : null;
  const parsed = TokenExtensionsAnswer.safeParse({
    protocol: 1,
    chain: 'solana',
    address,
    status: ext.status,
    isToken2022: ext.status === 'unread' ? null : ext.status === 'read',
    transferFeeBps: read?.transferFee?.bps ?? null,
    maxFee: read?.transferFee?.maxFee ?? null,
    permanentDelegate: read?.permanentDelegate ?? null,
    transferHookProgram: read?.transferHookProgram ?? null,
    defaultAccountState: read?.defaultAccountState ?? null,
    unparsedExtensionTypeIds: read?.otherTypeIds ?? [],
    source: ext.source,
    fetched_at: ext.fetchedAt,
    disclaimer: TOKEN_EXTENSIONS_DISCLAIMER,
  });
  return parsed.success ? parsed.data : null;
}
