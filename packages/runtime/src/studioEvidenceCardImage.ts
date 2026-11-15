import { z } from 'zod';
import { validateMedia } from '@xbam/shared';
import type { CardReading } from '@xbam/prompts';
import { studioInstallationFile } from './studioLink';

/**
 * The picture of an evidence card, drawn by the linked Studio.
 *
 * ## What leaves this machine
 *
 * Exactly the fields of `EvidenceCardImageRequest` and nothing else. The schema is
 * `.strict()` at every level, so a field somebody adds later is a refusal until the
 * schema, the fixture (`tests/fixtures/studioEvidenceCardImage.json`) and the test
 * that pins them are changed together. It carries the token (chain and address, which
 * are public and are what makes the card this card), the five readings with their
 * source and read times, and the fixed line that this is not a verdict. It never
 * carries a post body, a handle, a display name, an id of the asker, a job id or an
 * agent id: the renderer needs to draw the card, not to know who asked for it.
 *
 * ## Where it goes
 *
 * `POST /api/v1/installation/evidence-card-image` on the linked Studio, through the
 * same DPoP transport as every other installation call. There is no parameter that
 * names a host. The answer must be an image (PNG, JPEG or WebP, sniffed from its bytes
 * and never taken from the content type) within a size cap and a short deadline. Anything
 * else is "no picture", and the caller sends the text card exactly as it was.
 */
export const EVIDENCE_CARD_IMAGE_PATH = '/api/v1/installation/evidence-card-image';
/** A picture is a courtesy to the reply, so it never holds the reply for long. */
export const EVIDENCE_CARD_IMAGE_TIMEOUT_MS = 8_000;
export const EVIDENCE_CARD_IMAGE_MAX_BYTES = 1_500_000;
/** The same words the text card ends with. They are part of the pixels. */
export const EVIDENCE_CARD_DISCLAIMER = 'not a verdict, reads can be wrong';

const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const Iso = z.string().max(40).refine(v => Number.isFinite(Date.parse(v)), 'not a timestamp');

/** The five readings `token.inspect_risk` produces. A label outside them is not a card field. */
export const CARD_FIELD_LABELS = ['Liquidity', 'Top holders', 'Mint authority', 'Freeze authority', 'Pool age'] as const;

const ReadingWire = z.strictObject({
  label: z.enum(CARD_FIELD_LABELS),
  value: z.union([z.number().nonnegative(), z.boolean()]).nullable(),
  unit: z.enum(['USD', '%', 'hours', 'authority']),
  source: z.string().regex(/^[a-z0-9_.-]{1,80}$/),
  fetched_at: Iso.nullable(),
  observed_at: Iso.nullable(),
  max_age_ms: z.number().int().positive().max(86_400_000),
});

export const EvidenceCardImageRequest = z.strictObject({
  protocol: z.literal(1),
  chain: z.enum(['solana', 'ethereum', 'robinhood']),
  address: z.string().max(64),
  readings: z.array(ReadingWire).min(1).max(CARD_FIELD_LABELS.length),
  disclaimer: z.literal(EVIDENCE_CARD_DISCLAIMER),
  /** When this request was made: the time the picture states it was drawn. */
  requested_at: Iso,
}).superRefine((card, ctx) => {
  const ok = card.chain === 'solana' ? SOLANA_MINT.test(card.address) : EVM_ADDRESS.test(card.address);
  if (!ok) ctx.addIssue({ code: 'custom', path: ['address'], message: 'not an address for this chain' });
});
export type EvidenceCardImageRequest = z.infer<typeof EvidenceCardImageRequest>;

/** Pure: the frozen payload for one card, or null when the card is not one Studio can draw. */
export function evidenceCardImagePayload(input: { chain: string; address: string; readings: CardReading[]; now?: Date }): EvidenceCardImageRequest | null {
  const address = input.address.startsWith('0x') ? input.address.toLowerCase() : input.address;
  // Protocol 1 draws the original five labels. LP lines stay on the text card
  // and are left out here, so a later label never fails the picture.
  const cardFields = new Set<string>(CARD_FIELD_LABELS);
  const readings = input.readings.filter(r => cardFields.has(r.label)).slice(0, CARD_FIELD_LABELS.length);
  const parsed = EvidenceCardImageRequest.safeParse({
    protocol: 1,
    chain: input.chain,
    address,
    readings: readings.map(r => ({
      label: r.label, value: r.value, unit: r.unit, source: r.source,
      fetched_at: r.fetchedAt, observed_at: r.observedAt, max_age_ms: r.maxAgeMs,
    })),
    disclaimer: EVIDENCE_CARD_DISCLAIMER,
    requested_at: (input.now ?? new Date()).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

export type CardImageOutcome =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

/**
 * Asks the linked Studio to draw the card. Never throws: every failure is a reason
 * the owner can read, and the reply goes out as text.
 */
export async function requestEvidenceCardImage(payload: EvidenceCardImageRequest): Promise<CardImageOutcome> {
  // The wire shape is proved again at the boundary, so a caller cannot hand over a wider object.
  const checked = EvidenceCardImageRequest.safeParse(payload);
  if (!checked.success) return { ok: false, reason: 'card is not in the frozen payload shape' };
  const answer = await studioInstallationFile(EVIDENCE_CARD_IMAGE_PATH, checked.data, {
    timeoutMs: EVIDENCE_CARD_IMAGE_TIMEOUT_MS, maxBytes: EVIDENCE_CARD_IMAGE_MAX_BYTES,
  });
  if (!answer.ok) return { ok: false, reason: 'Studio unavailable' };
  if (answer.status !== 200 || !answer.bytes || answer.bytes.byteLength === 0) return { ok: false, reason: `Studio answered ${answer.status} with no picture` };
  if (answer.bytes.byteLength > EVIDENCE_CARD_IMAGE_MAX_BYTES) return { ok: false, reason: 'picture too large' };
  try {
    // From the bytes. A content type is a claim, and a document is not a picture.
    const info = validateMedia(answer.bytes);
    if (info.kind !== 'IMAGE') return { ok: false, reason: 'Studio answer was not a still image' };
  } catch {
    return { ok: false, reason: 'Studio answer was not an image' };
  }
  return { ok: true, bytes: answer.bytes };
}
