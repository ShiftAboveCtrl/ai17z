import type { VoiceCounts, VoiceDocument } from '@xbam/shared/contracts';

/**
 * What the voice routes answer with, as the screens read it.
 *
 * Hand-written beside the routes in `apps/api/src/routes/studioVoice.ts` rather
 * than imported from the runtime, which is Node-side code the browser bundle
 * must not reach. The document and its counts are the shared contract itself.
 */

export type VoiceFindingKind =
  | 'INSTRUCTION_OVERRIDE'
  | 'PROMPT_EXTRACTION'
  | 'IDENTITY_DENIAL'
  | 'SECRET_REQUEST'
  | 'MONEY_INSTRUCTION'
  | 'MARKUP'
  | (string & {});

export interface VoiceFinding {
  /** A path into the document, like `character.styleExamples.3`. */
  field: string;
  kind: VoiceFindingKind;
  excerpt: string;
}

export interface VoicePreview {
  document: VoiceDocument;
  digest: string;
  counts: VoiceCounts;
  findings: VoiceFinding[];
  listingId: string | null;
  nextVersion: number;
  confirmPhrase: string;
  expiresAt: string;
  notes: string[];
}

export type StudioLinkState = 'NOT_CONFIGURED' | 'NOT_LINKED' | 'PENDING' | 'REVOKED' | 'LINKED';

export interface VoiceStatus {
  studio: { state: StudioLinkState; origin: string | null };
  listing: {
    listingId: string;
    origin: string;
    status: 'PUBLISHED' | 'UNPUBLISHED';
    versions: Array<{ version: number; digest: string; publishedAt: string }>;
  } | null;
}

export type PublishAnswer =
  | { state: 'PUBLISHED'; listingId: string; version: number; url: string; digest: string; alreadyPublished: boolean }
  | { state: 'UNAVAILABLE'; why: string };

export interface StudioListing {
  listing_id: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
  title: string;
  url: string;
  versions: Array<{ version: number; document_sha256: string; published_at: string }>;
}

export type ListingsAnswer = { ok: true; listings: StudioListing[] } | { ok: false; why: string };

export interface VoiceInspection {
  valid: boolean;
  problem: string | null;
  title: string | null;
  summary: string | null;
  digest: string | null;
  counts: VoiceCounts | null;
  findings: VoiceFinding[];
  notes: string[];
}

export interface InspectAnswer {
  inspection: VoiceInspection;
  /** The parsed voice, or null when it could not be read. The one an install would use. */
  document: VoiceDocument | null;
  source:
    | { kind: 'FILE' }
    | { kind: 'STUDIO'; listingId: string; version: number | null; publishedAt: string | null };
}

export interface InstallAnswer {
  agentId: string;
  name: string;
  counts: VoiceCounts;
  findings: VoiceFinding[];
  notes: string[];
}

/** The short form of a digest an owner can compare by eye, as in the confirmation phrase. */
export const shortDigest = (digest: string) => digest.slice(0, 8);

const FINDING_WORDS: Record<string, string> = {
  INSTRUCTION_OVERRIDE: 'Reads like an instruction to the model',
  PROMPT_EXTRACTION: 'Asks the model to reveal its prompt',
  IDENTITY_DENIAL: 'Denies being an AI',
  SECRET_REQUEST: 'Asks for a key or seed phrase',
  MONEY_INSTRUCTION: 'Tells the agent to move funds',
  MARKUP: 'Contains markup',
};

export const describeFinding = (kind: VoiceFindingKind) => FINDING_WORDS[kind] ?? 'Looks wrong';

/**
 * A listing id from what somebody pasted: the id itself, or the page address
 * Studio gave them. Anything else is refused here, so no free text is ever
 * placed in a request path.
 */
export function listingIdFrom(pasted: string): string | null {
  const text = pasted.trim();
  if (!text) return null;
  const pattern = /^[a-z0-9][a-z0-9_-]{5,63}$/;
  if (pattern.test(text)) return text;
  try {
    const last = new URL(text).pathname.split('/').filter(Boolean).pop() ?? '';
    return pattern.test(last) ? last : null;
  } catch {
    return null;
  }
}
