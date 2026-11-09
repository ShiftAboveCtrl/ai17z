import { z } from 'zod';
import { EmojiUse } from './policy';

/**
 * A voice that can be published to AI17Z Studio and installed from it.
 *
 * `docs/architecture/STUDIO_VOICE_PUBLISH.md` is the full account. The shape of
 * this file is the safety argument, so it is worth stating once here.
 *
 * ## An allowlist, and a short one
 *
 * A voice is how an agent sounds: its character answers, its style examples and
 * the few output settings that are about register. It is not an agent. There is
 * no field for a memory, a relationship, a stance, a credential, a wallet, a
 * model, a tool, a plugin, a permission, a policy, a schedule or a picture,
 * and there is no field for an identity: no agent id, no owner, no display
 * name, no `identityKind`, no represented entity, no `mayDenyBeingAI`. Nothing
 * is *removed* from a bigger document on the way out. The document is built
 * from named fields and everything else is never read, so a field added to
 * `PersonaDraft` or `PolicyConfig` next year does not publish itself.
 *
 * Every object is `.strict()`: an unknown key is a refusal, not something that
 * rides along into an installation nobody inspected.
 *
 * ## Text is data
 *
 * The free text fields are what the voice *is*, so they are the one place a
 * hostile author can put words. They are held to what text can be checked for:
 * length, no control or direction-override characters, and, for the short
 * labels that might end up near a filename or a URL, nothing path-shaped.
 * Beyond that they are data. Nothing here is interpreted, executed, joined into
 * a command or given a say in policy, and `studioVoice.ts` scans them for
 * instruction-shaped text so a person sees it before installing, rather than
 * pretending a regular expression is a defence.
 *
 * ## No defaults
 *
 * Unlike most schemas here, nothing in this one has a `.default()`. The digest
 * Studio stores is taken over the canonical JSON of the document, and a
 * document that parsed to something different from what was sent would have a
 * digest nobody could reproduce.
 */

/** The document format. A different value is a different thing, not a newer one. */
export const VOICE_DOCUMENT_FORMAT = 'ai17z-voice' as const;
/** Bumped when a change would make an older reader misread a voice. */
export const VOICE_DOCUMENT_VERSION = 1;
/** The wire protocol with Studio, bumped separately from the document. */
export const VOICE_PROTOCOL = 1;
/** A voice this large is not a voice, whatever it says it is. */
export const MAX_VOICE_BYTES = 128 * 1024;

export const VOICE_LIMITS = {
  title: 80,
  summary: 500,
  biography: 6_000,
  personality: 4_000,
  tone: 1_000,
  styleGuidelines: 4_000,
  styleExample: 1_000,
  styleExamples: 50,
  topic: 80,
  topics: 40,
  languagePolicy: 500,
  prohibitedBehavior: 300,
  prohibitedBehaviors: 40,
  maxCharacters: 4_000,
  emojiAllowed: 60,
} as const;

/**
 * Characters text has no business containing.
 *
 * C0 and C1 controls other than tab, newline and carriage return; the Unicode
 * bidirectional overrides and isolates, which make text read differently from
 * how it is stored; line and paragraph separators; and the byte order mark.
 * Zero-width joiners are left alone because emoji sequences need them.
 *
 * Code points rather than a character class, so the source holds no invisible
 * character a reviewer cannot see.
 */
export function hasForbiddenCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (
      c <= 8 ||
      c === 0x0b ||
      c === 0x0c ||
      (c >= 0x0e && c <= 0x1f) ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Something shaped like a place on a disk or a traversal out of one.
 *
 * Only the short labels are held to this. A style example may say "gm/gn", and
 * a paragraph may mention a folder, because nothing here ever opens a path. A
 * *label* is different: titles and topics are the strings most likely to be
 * reused somewhere a filesystem or a URL is within reach, so they cannot look
 * like one.
 */
const PATH_SHAPED = /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:[\\/]|^~[\\/]|^\\\\|^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\\/;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasForbiddenCharacters(value), {
      message: 'contains control or direction-override characters',
    });

const label = (max: number) =>
  text(max)
    .refine((value) => !/[\r\n]/.test(value), { message: 'must be a single line' })
    .refine((value) => !PATH_SHAPED.test(value.trim()), { message: 'must not look like a file path or an address' });

export const VoiceSettings = z
  .object({
    emoji: z
      .object({
        use: EmojiUse,
        maxPerMessage: z.number().int().min(0).max(20),
        allowed: z.array(text(16)).max(VOICE_LIMITS.emojiAllowed),
        messagesPercent: z.number().int().min(0).max(100),
      })
      .strict(),
    maxCharacters: z.number().int().min(1).max(VOICE_LIMITS.maxCharacters),
    forbidHashtags: z.boolean(),
    forbidLinks: z.boolean(),
    forbidMentionsOfOthers: z.boolean(),
    stripSurroundingQuotes: z.boolean(),
  })
  .strict();
export type VoiceSettings = z.infer<typeof VoiceSettings>;

/** The character answers: how the voice thinks and sounds. Persona field names, on purpose. */
export const VoiceCharacter = z
  .object({
    biography: text(VOICE_LIMITS.biography),
    personality: text(VOICE_LIMITS.personality),
    tone: text(VOICE_LIMITS.tone),
    styleGuidelines: text(VOICE_LIMITS.styleGuidelines),
    styleExamples: z.array(text(VOICE_LIMITS.styleExample)).max(VOICE_LIMITS.styleExamples),
    topics: z.array(label(VOICE_LIMITS.topic)).max(VOICE_LIMITS.topics),
    languagePolicy: text(VOICE_LIMITS.languagePolicy),
    responseLength: z.enum(['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE']),
    prohibitedBehaviors: z.array(text(VOICE_LIMITS.prohibitedBehavior)).max(VOICE_LIMITS.prohibitedBehaviors),
  })
  .strict();
export type VoiceCharacter = z.infer<typeof VoiceCharacter>;

export const VoiceDocument = z
  .object({
    format: z.literal(VOICE_DOCUMENT_FORMAT),
    version: z.literal(VOICE_DOCUMENT_VERSION),
    /** The listing's name. Not the agent's: an installer picks the new agent's own. */
    title: label(VOICE_LIMITS.title).refine((value) => value.trim().length > 0, { message: 'must not be empty' }),
    summary: text(VOICE_LIMITS.summary),
    character: VoiceCharacter,
    settings: VoiceSettings,
  })
  .strict()
  .refine(
    (doc) =>
      [doc.character.biography, doc.character.personality, doc.character.tone, doc.character.styleGuidelines].some(
        (value) => value.trim().length > 0,
      ) || doc.character.styleExamples.some((value) => value.trim().length > 0),
    { message: 'A voice with nothing in it is not worth publishing.', path: ['character'] },
  );
export type VoiceDocument = z.infer<typeof VoiceDocument>;

// ---------------------------------------------------------------------------
// The wire contract with Studio
// ---------------------------------------------------------------------------

/** What Studio assigns. Constrained so it is safe to put in a path without trusting it. */
export const VoiceListingId = z.string().regex(/^[a-z0-9][a-z0-9_-]{5,63}$/, 'not a listing id');
export type VoiceListingId = z.infer<typeof VoiceListingId>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'not a sha256 digest');
const Timestamp = z.iso.datetime({ offset: true });

/** Sent to Studio. Everything in it was previewed. */
export const VoicePublishRequest = z
  .object({
    protocol: z.literal(VOICE_PROTOCOL),
    /** Makes a retried request one request. Fresh for each preview. */
    idempotency_key: z.uuid(),
    /** Null starts a listing; an id adds a version to it. */
    listing_id: VoiceListingId.nullable(),
    document: VoiceDocument,
    document_sha256: Sha256,
  })
  .strict();
export type VoicePublishRequest = z.infer<typeof VoicePublishRequest>;

export const VoicePublishAnswer = z
  .object({
    protocol: z.literal(VOICE_PROTOCOL),
    listing_id: VoiceListingId,
    version: z.number().int().min(1),
    document_sha256: Sha256,
    status: z.literal('PUBLISHED'),
    published_at: Timestamp,
    url: z.url(),
  })
  .strict();
export type VoicePublishAnswer = z.infer<typeof VoicePublishAnswer>;

export const VoiceVersionSummary = z
  .object({ version: z.number().int().min(1), document_sha256: Sha256, published_at: Timestamp })
  .strict();

export const VoiceListing = z
  .object({
    listing_id: VoiceListingId,
    status: z.enum(['PUBLISHED', 'UNPUBLISHED']),
    title: z.string().max(VOICE_LIMITS.title),
    url: z.url(),
    versions: z.array(VoiceVersionSummary).max(500),
  })
  .strict();
export type VoiceListing = z.infer<typeof VoiceListing>;

export const VoiceListAnswer = z
  .object({ protocol: z.literal(VOICE_PROTOCOL), listings: z.array(VoiceListing).max(200) })
  .strict();
export type VoiceListAnswer = z.infer<typeof VoiceListAnswer>;

export const VoiceUnpublishRequest = z
  .object({ protocol: z.literal(VOICE_PROTOCOL), idempotency_key: z.uuid() })
  .strict();

export const VoiceUnpublishAnswer = z
  .object({
    protocol: z.literal(VOICE_PROTOCOL),
    listing_id: VoiceListingId,
    status: z.literal('UNPUBLISHED'),
    unpublished_at: Timestamp,
  })
  .strict();
export type VoiceUnpublishAnswer = z.infer<typeof VoiceUnpublishAnswer>;

/** A published listing as anybody, signed in or not, can read it. */
export const VoicePublicListing = z
  .object({
    protocol: z.literal(VOICE_PROTOCOL),
    listing_id: VoiceListingId,
    status: z.literal('PUBLISHED'),
    title: z.string().max(VOICE_LIMITS.title),
    summary: z.string().max(VOICE_LIMITS.summary),
    latest_version: z.number().int().min(1),
    versions: z.array(VoiceVersionSummary).min(1).max(500),
    url: z.url(),
  })
  .strict();
export type VoicePublicListing = z.infer<typeof VoicePublicListing>;

/** A published version as anybody, signed in or not, can read it. */
export const VoiceVersionAnswer = z
  .object({
    protocol: z.literal(VOICE_PROTOCOL),
    listing_id: VoiceListingId,
    version: z.number().int().min(1),
    status: z.literal('PUBLISHED'),
    published_at: Timestamp,
    document_sha256: Sha256,
    document: VoiceDocument,
  })
  .strict();
export type VoiceVersionAnswer = z.infer<typeof VoiceVersionAnswer>;

/** What is counted out of a parsed voice, shown before anything is installed. */
export const VoiceCounts = z
  .object({
    styleExamples: z.number().int(),
    topics: z.number().int(),
    prohibitedBehaviors: z.number().int(),
    allowedEmoji: z.number().int(),
    characters: z.number().int(),
  })
  .strict();
export type VoiceCounts = z.infer<typeof VoiceCounts>;
