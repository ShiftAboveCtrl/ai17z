import { z } from 'zod';
import { validateMedia } from '@xbam/shared';
import {
  HOLDER_MAP_EXCLUSION, HOLDER_MAP_NOT_PROOF, HOLDER_MAP_SHARED_SERVICE,
  type CardReading, type HolderMapView,
} from '@xbam/prompts';
import { studioInstallationFile } from './studioLink';
import { MAX_HOLDER_MAP_HOLDERS } from './holderMap';

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
  const parsed = EvidenceCardImageRequest.safeParse({
    protocol: 1,
    chain: input.chain,
    address,
    readings: input.readings.map(r => ({
      label: r.label, value: r.value, unit: r.unit, source: r.source,
      fetched_at: r.fetchedAt, observed_at: r.observedAt, max_age_ms: r.maxAgeMs,
    })),
    disclaimer: EVIDENCE_CARD_DISCLAIMER,
    requested_at: (input.now ?? new Date()).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * ## The second payload kind: `holder-map`
 *
 * The same path, the same transport and the same answer rules as the card, told apart by `kind`.
 * The card's own payload has no `kind` and is frozen exactly as it was; this one is new.
 *
 * It carries the mint, up to twelve holder accounts (address, per cent of supply, the way the first
 * funding read came out, a group id or null, when it was read), the accounts whose supply percent was
 * not read, the upstream and the time of the read, and the fixed lines the picture must print.
 * The group id is `g1`, `g2` and so on: the funding address itself never leaves, and neither does a
 * post body, a handle, a name, an id of the asker, a job or an agent. `palette: neutral` is part of
 * the contract: a group is a shared outline in one ink, never a warning colour. Studio draws it; the
 * renderer stays Studio's.
 */
export const HOLDER_MAP_FUNDING = ['grouped', 'single', 'unavailable', 'excluded'] as const;
const Address = z.string().regex(SOLANA_MINT);

const HolderWire = z.strictObject({
  address: Address,
  percent: z.number().min(0).max(100),
  funding: z.enum(HOLDER_MAP_FUNDING),
  group: z.string().regex(/^g[1-6]$/).nullable(),
  read_at: Iso,
});

export const HolderMapImageRequest = z.strictObject({
  protocol: z.literal(1),
  kind: z.literal('holder-map'),
  chain: z.literal('solana'),
  address: Address,
  /** Where the holder list and the signatures came from, in the same lowercase form the card carries. */
  source: z.string().regex(/^[a-z0-9_.-]{1,80}$/),
  read_at: Iso,
  holders: z.array(HolderWire).min(1).max(MAX_HOLDER_MAP_HOLDERS),
  /** Accounts whose supply percent was not read. Listed under "not read", never drawn. */
  not_read: z.array(Address).max(MAX_HOLDER_MAP_HOLDERS),
  palette: z.literal('neutral'),
  /** Printed as written. Studio draws these lines and may not rephrase them. */
  reading_line: z.literal(HOLDER_MAP_NOT_PROOF),
  service_line: z.literal(HOLDER_MAP_SHARED_SERVICE),
  exclusion_line: z.literal(HOLDER_MAP_EXCLUSION),
  disclaimer: z.literal(EVIDENCE_CARD_DISCLAIMER),
  requested_at: Iso,
}).superRefine((map, ctx) => {
  const seen = new Set<string>();
  for (const [index, holder] of map.holders.entries()) {
    if (seen.has(holder.address)) ctx.addIssue({ code: 'custom', path: ['holders', index, 'address'], message: 'duplicate holder' });
    seen.add(holder.address);
    // A group id belongs to a grouped account and to nothing else.
    if ((holder.funding === 'grouped') !== (holder.group !== null)) {
      ctx.addIssue({ code: 'custom', path: ['holders', index, 'group'], message: 'a group id goes with grouped funding only' });
    }
  }
  const size = new Map<string, number>();
  for (const holder of map.holders) if (holder.group) size.set(holder.group, (size.get(holder.group) ?? 0) + 1);
  if ([...size.values()].some(n => n < 2)) ctx.addIssue({ code: 'custom', path: ['holders'], message: 'a group needs two accounts' });
  if (map.not_read.some(a => seen.has(a))) ctx.addIssue({ code: 'custom', path: ['not_read'], message: 'an account is drawn or not read, never both' });
  if (map.holders.length + map.not_read.length > MAX_HOLDER_MAP_HOLDERS) ctx.addIssue({ code: 'custom', path: ['not_read'], message: 'too many accounts' });
});
export type HolderMapImageRequest = z.infer<typeof HolderMapImageRequest>;

/** Pure: the frozen payload for one holder map, or null when there is nothing Studio could draw. */
export function holderMapImagePayload(view: HolderMapView, now: Date = new Date()): HolderMapImageRequest | null {
  const parsed = HolderMapImageRequest.safeParse({
    protocol: 1,
    kind: 'holder-map',
    chain: 'solana',
    address: view.mint,
    source: view.source,
    read_at: view.readAt,
    holders: view.holders.map(h => ({ address: h.address, percent: h.percent, funding: h.funding, group: h.group, read_at: h.readAt })),
    not_read: view.notRead,
    palette: 'neutral',
    reading_line: HOLDER_MAP_NOT_PROOF,
    service_line: HOLDER_MAP_SHARED_SERVICE,
    exclusion_line: HOLDER_MAP_EXCLUSION,
    disclaimer: EVIDENCE_CARD_DISCLAIMER,
    requested_at: now.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

export type CardImageOutcome =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

/**
 * Asks the linked Studio to draw the card or the holder map. Never throws: every failure is a
 * reason the owner can read, and the reply goes out as text.
 */
export async function requestEvidenceCardImage(payload: EvidenceCardImageRequest | HolderMapImageRequest): Promise<CardImageOutcome> {
  // The wire shape is proved again at the boundary, so a caller cannot hand over a wider object.
  const checked = (payload as { kind?: unknown }).kind === 'holder-map'
    ? HolderMapImageRequest.safeParse(payload) : EvidenceCardImageRequest.safeParse(payload);
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
