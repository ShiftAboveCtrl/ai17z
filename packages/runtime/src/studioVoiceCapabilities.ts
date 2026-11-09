import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { VOICE_LIMITS, VoiceCounts, VoiceDocument, VoiceListingId } from '@xbam/shared/contracts';
import { listPublishedVoices, previewVoice, publishVoice, unpublishVoice } from './studioVoice';
import { studioLinkedContext } from './studioLink';

/**
 * What an agent may do about publishing its voice to AI17Z Studio.
 *
 * Four capabilities, all `audience: 'OWNER'` and all `unsetPermission:
 * 'DISABLED'`: an agent whose owner decided nothing about them neither offers
 * nor can run any of them, and a stranger who names one is refused before it
 * is parsed.
 *
 * ## The model asks, the owner confirms
 *
 * `studio_voice.publish` is the only one that sends anything out, and it never
 * takes a flag a model could set. It needs a preview (`studio_voice.preview`)
 * made in the last half hour for exactly the digest it names, and the owner's
 * own message in this conversation containing the phrase the preview printed.
 * That message is `ctx.origin.text`, supplied by the harness; nothing a model
 * writes can stand in for it. A model that has read a hostile document can
 * propose publishing and the owner has to say it, in words that name the
 * document. See `studioVoice.ts`.
 *
 * Turning the Studio Voice pack on is the owner's decision that these may run
 * at all; it does not make the second step go away, and it does not sweep the
 * two writes to ALLOWED.
 *
 * `tests/unit/studioVoice.test.ts` pins this list, each effect, audience and
 * default, and that this file never reaches the wallet, a purchase or the
 * owner-action confirmation that is for signed-in routes.
 */

const Finding = z.object({ field: z.string(), kind: z.string(), excerpt: z.string() });

async function previewReady() {
  return { status: 'AVAILABLE' as const };
}

async function linkedReady() {
  const link = await studioLinkedContext();
  return 'ok' in link
    ? { status: 'UNAVAILABLE' as const, why: `${link.why} Link this installation to AI17Z Studio on the Plugins screen first.` }
    : { status: 'AVAILABLE' as const };
}

const preview = defineCapability({
  id: 'studio_voice.preview',
  name: 'Preview publishing my voice',
  description:
    "Shows the owner exactly what would be published if they shared this agent's voice on AI17Z Studio: the character, style examples and output settings, " +
    'with counts and anything in the text that looks wrong. Nothing is published. Use when the owner asks to share, publish or list this agent\'s voice or character. ' +
    'Show them the whole result and the confirmation phrase, and say that nothing has left yet.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({
    title: z.string().max(VOICE_LIMITS.title).optional(),
    summary: z.string().max(VOICE_LIMITS.summary).optional(),
  }),
  output: z.object({
    state: z.enum(['READY', 'REFUSED']),
    statement: z.string(),
    digest: z.string().nullable(),
    confirmPhrase: z.string().nullable(),
    expiresAt: z.string().nullable(),
    listingId: z.string().nullable(),
    nextVersion: z.number().int().nullable(),
    counts: VoiceCounts.nullable(),
    findings: z.array(Finding),
    notes: z.array(z.string()),
    document: VoiceDocument.nullable(),
  }),
  modelCallable: true,
  timeoutMs: 15_000,
  readiness: previewReady,
  async run(input, ctx) {
    const made = await previewVoice({ agentId: ctx.agentId, title: input.title, summary: input.summary });
    if (!made.ok) {
      return {
        state: 'REFUSED' as const,
        statement: made.why,
        digest: null,
        confirmPhrase: null,
        expiresAt: null,
        listingId: null,
        nextVersion: null,
        counts: null,
        findings: [],
        notes: [],
        document: null,
      };
    }
    const p = made.preview;
    return {
      state: 'READY' as const,
      statement:
        `This is what would be published as version ${p.nextVersion}${p.listingId ? ` of listing ${p.listingId}` : ' of a new listing'}. ` +
        `Nothing has been sent. To publish it, the owner replies with: "${p.confirmPhrase}".`,
      digest: p.digest,
      confirmPhrase: p.confirmPhrase,
      expiresAt: p.expiresAt,
      listingId: p.listingId,
      nextVersion: p.nextVersion,
      counts: p.counts,
      findings: p.findings,
      notes: p.notes,
      document: p.document,
    };
  },
});

const publish = defineCapability({
  id: 'studio_voice.publish',
  name: 'Publish my voice to Studio',
  description:
    "Publishes the voice that was just previewed to AI17Z Studio as a new version. Only works after studio_voice.preview, with the digest it returned, " +
    'and only when the owner has written the confirmation phrase in their own message. Never publish without that; if the phrase is missing, say what it is and wait.',
  category: 'ACCOUNT',
  effect: 'WRITE',
  risk: 'HIGH',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/, 'the digest from the preview') }),
  output: z.object({
    state: z.enum(['PUBLISHED', 'NO_PREVIEW', 'EXPIRED', 'CHANGED_SINCE_PREVIEW', 'NOT_CONFIRMED', 'UNAVAILABLE']),
    statement: z.string(),
    listingId: z.string().nullable(),
    version: z.number().int().nullable(),
    url: z.string().nullable(),
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: linkedReady,
  async run(input, ctx) {
    const out = await publishVoice({
      agentId: ctx.agentId,
      digest: input.digest,
      // The owner's own words, from the harness. Not an argument.
      confirmation: { by: 'OWNER_MESSAGE', text: ctx.origin?.text },
      ownerId: ctx.origin?.ownerId ?? null,
    });
    if (out.state === 'PUBLISHED') {
      return {
        state: out.state,
        statement: out.alreadyPublished
          ? `That exact voice was already published as version ${out.version}; nothing changed. ${out.url}`
          : `Published as version ${out.version}. Anyone can read it now, and earlier versions are unchanged. ${out.url}`,
        listingId: out.listingId,
        version: out.version,
        url: out.url,
      };
    }
    return { state: out.state, statement: out.why, listingId: null, version: null, url: null };
  },
});

const unpublish = defineCapability({
  id: 'studio_voice.unpublish',
  name: 'Unpublish my voice from Studio',
  description:
    'Takes one of the owner\'s published voices off AI17Z Studio, so nobody can read or install it. Copies already installed are not affected. ' +
    'Only when the owner has written "unpublish voice <listing id>" in their own message.',
  category: 'ACCOUNT',
  effect: 'WRITE',
  risk: 'HIGH',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({ listingId: VoiceListingId }),
  output: z.object({
    state: z.enum(['UNPUBLISHED', 'NOT_CONFIRMED', 'UNAVAILABLE']),
    statement: z.string(),
    listingId: z.string().nullable(),
  }),
  modelCallable: true,
  timeoutMs: 30_000,
  readiness: linkedReady,
  async run(input, ctx) {
    const out = await unpublishVoice({
      agentId: ctx.agentId,
      listingId: input.listingId,
      confirmation: { by: 'OWNER_MESSAGE', text: ctx.origin?.text },
      ownerId: ctx.origin?.ownerId ?? null,
    });
    return out.state === 'UNPUBLISHED'
      ? { state: out.state, statement: 'Taken down. It cannot be read or installed from Studio any more; copies already installed are unaffected.', listingId: out.listingId }
      : { state: out.state, statement: out.why, listingId: null };
  },
});

const listings = defineCapability({
  id: 'studio_voice.listings',
  name: 'My published voices',
  description: "The owner's published voices on AI17Z Studio, with their versions and whether each is still listed. Use to find a listing id.",
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'MEDIUM',
  unsetPermission: 'DISABLED',
  audience: 'OWNER',
  input: z.object({}),
  output: z.object({
    state: z.enum(['LISTED', 'UNAVAILABLE']),
    statement: z.string(),
    listings: z.array(
      z.object({
        listingId: z.string(),
        status: z.enum(['PUBLISHED', 'UNPUBLISHED']),
        title: z.string(),
        url: z.string(),
        versions: z.array(z.object({ version: z.number().int(), digest: z.string(), publishedAt: z.string() })),
      }),
    ),
  }),
  modelCallable: true,
  timeoutMs: 25_000,
  readiness: linkedReady,
  async run() {
    const read = await listPublishedVoices();
    if (!read.ok) {
      return { state: 'UNAVAILABLE' as const, statement: `I cannot check Studio right now. ${read.why} I will not guess at it.`, listings: [] };
    }
    return {
      state: 'LISTED' as const,
      statement: read.listings.length === 0 ? 'Nothing is published from this installation.' : `${read.listings.length} listing${read.listings.length === 1 ? '' : 's'} on Studio.`,
      listings: read.listings.map((l) => ({
        listingId: l.listing_id,
        status: l.status,
        title: l.title,
        url: l.url,
        versions: l.versions.map((v) => ({ version: v.version, digest: v.document_sha256, publishedAt: v.published_at })),
      })),
    };
  },
});

export const STUDIO_VOICE_CAPABILITIES = [preview, publish, unpublish, listings] as unknown as AnyCapability[];

export function registerStudioVoiceCapabilities(): void {
  for (const capability of STUDIO_VOICE_CAPABILITIES) registerCapability(capability);
}
