/**
 * Publishing an agent's voice to AI17Z Studio, and taking a listing down.
 *
 * `docs/architecture/STUDIO_VOICE_PUBLISH.md` is the full account; this is the
 * client side of it. `voiceDocument.ts` decides what a voice *is*; this decides
 * when it may leave.
 *
 * ## Two steps, and the second is the owner's
 *
 * `previewVoice` builds the exact document, shows it with its counts and
 * anything in its text that looks wrong, and stores one pending record: the
 * digest, a fresh idempotency key and the phrase that confirms it. Nothing has
 * left the installation.
 *
 * `publishVoice` sends only what that preview showed, and only on a
 * `confirmation`. For a capability the confirmation is the owner's own message
 * in owner chat, which must contain the phrase. That text comes from the
 * harness and not from the model's arguments, so a model that has read a
 * hostile document cannot confirm on the owner's behalf: it can ask, and the
 * owner has to say it. The phrase carries the first characters of the digest,
 * so it confirms *that* document and not "whatever is current".
 *
 * ## Nothing is mutated, ever
 *
 * Studio versions a listing. A second publish with a changed document is
 * version 2; version 1 stays exactly as it was, and a copy somebody installed
 * is a copy. The same document published twice with the same key is one
 * version, which is what makes a retry after a dropped connection safe.
 *
 * ## What it does not keep
 *
 * The installation keeps the listing id (so a later publish adds a version
 * rather than a second listing) and the versions it was told about. Studio is
 * the record. Unpublishing stops new installs and removes the page; it cannot
 * reach a copy somebody already has, and the preview says so.
 */
import { randomUUID } from 'node:crypto';
import {
  VOICE_PROTOCOL,
  VoiceListAnswer,
  VoiceListingId,
  VoicePublicListing,
  VoicePublishAnswer,
  VoiceUnpublishAnswer,
  VoiceVersionAnswer,
  PolicyConfig,
  type VoiceCounts,
  type VoiceDocument,
  type VoiceListing,
} from '@xbam/shared/contracts';
import { agents as agentsRepo, ops } from '@xbam/database';
import {
  describeStudioReply,
  studioAuthed,
  studioLinkedContext,
  studioOrigin,
  studioPublicGet,
  type StudioProblem,
} from './studioLink';
import { countsOf, scanVoice, voiceDigest, voiceFromAgent, type VoiceFinding } from './voiceDocument';

/** How long a preview can be confirmed. Past it the owner looks again. */
export const VOICE_PREVIEW_TTL_MS = 30 * 60_000;

const pendingKey = (agentId: string) => `studio.voice.pending.${agentId}`;
const listingKey = (agentId: string) => `studio.voice.listing.${agentId}`;

interface PendingRecord {
  digest: string;
  idempotencyKey: string;
  listingId: string | null;
  title: string;
  summary: string;
  phrase: string;
  createdAt: string;
  expiresAt: string;
}

export interface ListingRecord {
  listingId: string;
  /** The Studio this listing is on. A listing on another origin is not this one. */
  origin: string;
  status: 'PUBLISHED' | 'UNPUBLISHED';
  versions: Array<{ version: number; digest: string; publishedAt: string }>;
}

/**
 * What this installation was last told about an agent's listing, or null.
 *
 * A read of the record `publishVoice` keeps, for a screen that has to say
 * whether this agent's voice is published. It includes a closed listing, which
 * `previewVoice` deliberately ignores, because "you unpublished it" is worth
 * saying. Studio remains the record; this is only what it last reported.
 */
export async function voiceListingOf(agentId: string): Promise<ListingRecord | null> {
  return (await ops.getSetting<ListingRecord>(listingKey(agentId))) ?? null;
}

/** The words that confirm one exact document. */
export const publishPhrase = (digest: string) => `publish voice ${digest.slice(0, 8)}`;
export const unpublishPhrase = (listingId: string) => `unpublish voice ${listingId}`;

const squash = (value: string) => value.toLowerCase().replace(/[\s]+/g, ' ').trim();

/**
 * Who is confirming.
 *
 * `OWNER_MESSAGE` is a capability's only way in: the text of the owner's own
 * message, which must contain the phrase. `OWNER_ACTION` is for a route the
 * owner reached by being signed in and pressing a button, which is itself the
 * explicit act. A capability file never constructs it, and
 * `tests/unit/studioVoice.test.ts` fails if one does.
 */
export type VoiceConfirmation = { by: 'OWNER_MESSAGE'; text: string | null | undefined } | { by: 'OWNER_ACTION' };

function confirmed(confirmation: VoiceConfirmation, phrase: string): boolean {
  if (confirmation.by === 'OWNER_ACTION') return true;
  return Boolean(confirmation.text) && squash(confirmation.text!).includes(squash(phrase));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface VoicePreview {
  document: VoiceDocument;
  digest: string;
  counts: VoiceCounts;
  /** Text in the voice that reads as an instruction, a denial of being an AI, and so on. */
  findings: VoiceFinding[];
  /** Null starts a listing; otherwise the listing this adds a version to. */
  listingId: string | null;
  /** The version Studio will assign if nothing else publishes first. */
  nextVersion: number;
  confirmPhrase: string;
  expiresAt: string;
  /** What publishing does and does not do, said in the preview rather than after. */
  notes: string[];
}

async function listingFor(agentId: string, origin: string | null): Promise<ListingRecord | null> {
  const record = await ops.getSetting<ListingRecord>(listingKey(agentId));
  if (!record || record.status !== 'PUBLISHED') return null;
  if (origin && record.origin !== origin) return null;
  return record;
}

export async function previewVoice(input: {
  agentId: string;
  title?: string | undefined;
  summary?: string | undefined;
  now?: Date;
}): Promise<{ ok: true; preview: VoicePreview } | { ok: false; why: string }> {
  const agent = await agentsRepo.getAgent(input.agentId);
  if (!agent) return { ok: false, why: 'That agent no longer exists.' };
  const [persona, policyRow] = await Promise.all([
    agentsRepo.getActivePersona(input.agentId),
    agentsRepo.getActivePolicy(input.agentId),
  ]);
  if (!persona) return { ok: false, why: 'That agent has no persona, so there is no voice to publish.' };
  const policy = PolicyConfig.parse(policyRow?.config ?? {});

  const built = voiceFromAgent(
    { persona, output: policy.output },
    { title: input.title?.trim() || agent.name, summary: input.summary?.trim() ?? (agent.description ?? '').slice(0, 500) },
  );
  if (!built.ok) return { ok: false, why: built.problem };

  const where = await studioOrigin();
  const existing = await listingFor(input.agentId, where?.origin ?? null);
  const now = input.now ?? new Date();
  const pending: PendingRecord = {
    digest: built.digest,
    idempotencyKey: randomUUID(),
    listingId: existing?.listingId ?? null,
    title: built.document.title,
    summary: built.document.summary,
    phrase: publishPhrase(built.digest),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + VOICE_PREVIEW_TTL_MS).toISOString(),
  };
  await ops.setSetting(pendingKey(input.agentId), pending);

  const same = existing?.versions.find((v) => v.digest === built.digest);
  const notes = [
    'Only the character answers, style examples and output settings shown above are published. No memory, relationship, credential, wallet, policy, permission, plugin or picture is part of it.',
    'Studio keeps every version. Publishing again with changes adds a new version and never alters one that is listed or one somebody installed.',
    'Anyone can read a published voice, signed in or not. Unpublishing removes the listing and stops new installs; it cannot take back a copy somebody already has.',
  ];
  if (same) notes.unshift(`This exact voice is already published as version ${same.version}. Publishing it again changes nothing.`);
  return {
    ok: true,
    preview: {
      document: built.document,
      digest: built.digest,
      counts: countsOf(built.document),
      findings: scanVoice(built.document),
      listingId: pending.listingId,
      nextVersion: (existing ? Math.max(0, ...existing.versions.map((v) => v.version)) : 0) + 1,
      confirmPhrase: pending.phrase,
      expiresAt: pending.expiresAt,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export type PublishOutcome =
  | { state: 'PUBLISHED'; listingId: string; version: number; url: string; digest: string; alreadyPublished: boolean }
  | { state: 'NO_PREVIEW' | 'EXPIRED' | 'CHANGED_SINCE_PREVIEW' | 'NOT_CONFIRMED' | 'UNAVAILABLE'; why: string };

export async function publishVoice(input: {
  agentId: string;
  /** The digest the owner was shown. A different one is a different document. */
  digest: string;
  confirmation: VoiceConfirmation;
  ownerId?: string | null;
  now?: Date;
}): Promise<PublishOutcome> {
  const now = input.now ?? new Date();
  const pending = await ops.getSetting<PendingRecord>(pendingKey(input.agentId));
  if (!pending || pending.digest !== input.digest) {
    return {
      state: 'NO_PREVIEW',
      why: 'There is no preview of that exact voice to confirm. Preview it first, so the owner sees what would be published.',
    };
  }
  if (Date.parse(pending.expiresAt) < now.getTime()) {
    return { state: 'EXPIRED', why: 'That preview is more than half an hour old. Preview again so the owner sees the voice as it is now.' };
  }
  if (!confirmed(input.confirmation, pending.phrase)) {
    return {
      state: 'NOT_CONFIRMED',
      why: `Nothing was published. Publishing needs the owner to say it in their own message: "${pending.phrase}".`,
    };
  }

  // Rebuilt, not trusted. The persona may have been edited between the preview
  // and the confirmation, and what the owner approved is the document with
  // this digest and no other.
  const [agent, persona, policyRow] = await Promise.all([
    agentsRepo.getAgent(input.agentId),
    agentsRepo.getActivePersona(input.agentId),
    agentsRepo.getActivePolicy(input.agentId),
  ]);
  if (!agent || !persona) return { state: 'UNAVAILABLE', why: 'That agent no longer exists.' };
  const built = voiceFromAgent(
    { persona, output: PolicyConfig.parse(policyRow?.config ?? {}).output },
    { title: pending.title, summary: pending.summary },
  );
  if (!built.ok) return { state: 'CHANGED_SINCE_PREVIEW', why: built.problem };
  if (built.digest !== pending.digest) {
    return { state: 'CHANGED_SINCE_PREVIEW', why: 'The voice changed after it was previewed. Preview it again and confirm what is there now.' };
  }

  const ready = await studioLinkedContext();
  if ('ok' in ready) return { state: 'UNAVAILABLE', why: ready.why };

  const answer = await studioAuthed('/api/v1/installation/voices', {
    method: 'POST',
    json: {
      protocol: VOICE_PROTOCOL,
      idempotency_key: pending.idempotencyKey,
      listing_id: pending.listingId,
      document: built.document,
      document_sha256: built.digest,
    },
  }).catch((error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }));
  // The pending record stays on any failure, so a retry reuses the key and a
  // request that reached Studio but whose answer was lost is still one version.
  if ('ok' in answer) return { state: 'UNAVAILABLE', why: answer.why };
  if (answer.status === 409) {
    return {
      state: 'UNAVAILABLE',
      why: `Studio would not take it: ${typeof answer.body?.error_description === 'string' ? answer.body.error_description.slice(0, 200) : 'the listing is closed or the request conflicts with an earlier one'}. Preview again to start fresh.`,
    };
  }
  if (answer.status !== 200 && answer.status !== 201) return { state: 'UNAVAILABLE', why: describeStudioReply(answer) };

  const parsed = VoicePublishAnswer.safeParse(answer.body);
  if (!parsed.success) {
    return { state: 'UNAVAILABLE', why: 'Studio answered with something other than a publish receipt, so it was not treated as published.' };
  }
  const receipt = parsed.data;
  if (receipt.document_sha256 !== built.digest) {
    return { state: 'UNAVAILABLE', why: 'Studio stored a document with a different digest than the one sent, so it was not treated as published.' };
  }
  if (pending.listingId && receipt.listing_id !== pending.listingId) {
    return { state: 'UNAVAILABLE', why: 'Studio answered for a different listing than the one asked for, so it was not treated as published.' };
  }
  if (new URL(receipt.url).origin !== ready.where.origin) {
    return { state: 'UNAVAILABLE', why: 'Studio\'s receipt linked to a page that is not on Studio, so it was not used.' };
  }

  const before = await listingFor(input.agentId, ready.where.origin);
  const previous = before && before.listingId === receipt.listing_id ? before : null;
  const known = previous?.versions.find((v) => v.version === receipt.version);
  const sameDigestBefore = previous?.versions.find((v) => v.digest === built.digest);
  // A version number Studio had already given to different content, or a
  // second number for content it already had, means it is not versioning the
  // way the contract says. Refused rather than recorded.
  if ((known && known.digest !== built.digest) || (sameDigestBefore && sameDigestBefore.version !== receipt.version)) {
    return { state: 'UNAVAILABLE', why: 'Studio\'s version numbering does not match what this installation has already been told, so nothing was recorded.' };
  }
  const versions = [...(previous?.versions ?? [])];
  if (!known) versions.push({ version: receipt.version, digest: built.digest, publishedAt: receipt.published_at });
  const record: ListingRecord = {
    listingId: receipt.listing_id,
    origin: ready.where.origin,
    status: 'PUBLISHED',
    versions: versions.sort((a, b) => a.version - b.version),
  };
  await ops.setSetting(listingKey(input.agentId), record);
  await ops.setSetting(pendingKey(input.agentId), null);
  await ops
    .audit({
      actorUserId: input.ownerId ?? agent.ownerId ?? null,
      action: 'studio.voice.publish',
      entityType: 'agent',
      entityId: input.agentId,
      data: { listingId: receipt.listing_id, version: receipt.version, digest: built.digest, confirmedBy: input.confirmation.by },
    })
    .catch(() => undefined); // An audit that fails must not turn a published voice into an error the owner retries.

  return {
    state: 'PUBLISHED',
    listingId: receipt.listing_id,
    version: receipt.version,
    url: receipt.url,
    digest: built.digest,
    alreadyPublished: Boolean(known),
  };
}

// ---------------------------------------------------------------------------
// Unpublish and list
// ---------------------------------------------------------------------------

export type UnpublishOutcome =
  | { state: 'UNPUBLISHED'; listingId: string }
  | { state: 'NOT_CONFIRMED' | 'UNAVAILABLE'; why: string };

export async function unpublishVoice(input: {
  agentId: string;
  listingId: string;
  confirmation: VoiceConfirmation;
  ownerId?: string | null;
}): Promise<UnpublishOutcome> {
  const id = VoiceListingId.safeParse(input.listingId);
  if (!id.success) return { state: 'UNAVAILABLE', why: 'That is not a listing id.' };
  const phrase = unpublishPhrase(id.data);
  if (!confirmed(input.confirmation, phrase)) {
    return { state: 'NOT_CONFIRMED', why: `Nothing was unpublished. Taking a listing down needs the owner to say it in their own message: "${phrase}".` };
  }
  const ready = await studioLinkedContext();
  if ('ok' in ready) return { state: 'UNAVAILABLE', why: ready.why };

  const answer = await studioAuthed(`/api/v1/installation/voices/${encodeURIComponent(id.data)}/unpublish`, {
    method: 'POST',
    json: { protocol: VOICE_PROTOCOL, idempotency_key: randomUUID() },
  }).catch((error: Error) => ({ ok: false as const, why: `Studio could not be reached: ${error.message}` }));
  if ('ok' in answer) return { state: 'UNAVAILABLE', why: answer.why };
  if (answer.status === 404) return { state: 'UNAVAILABLE', why: 'Studio has no such listing under this installation.' };
  if (answer.status !== 200) return { state: 'UNAVAILABLE', why: describeStudioReply(answer) };
  const parsed = VoiceUnpublishAnswer.safeParse(answer.body);
  if (!parsed.success || parsed.data.listing_id !== id.data) {
    return { state: 'UNAVAILABLE', why: 'Studio answered with something other than an unpublish receipt, so it was not treated as taken down.' };
  }

  const record = await ops.getSetting<ListingRecord>(listingKey(input.agentId));
  // Closed locally, so the next preview starts a fresh listing instead of
  // asking Studio to add a version to one it has shut.
  if (record && record.listingId === id.data) await ops.setSetting(listingKey(input.agentId), { ...record, status: 'UNPUBLISHED' });
  await ops
    .audit({
      actorUserId: input.ownerId ?? null,
      action: 'studio.voice.unpublish',
      entityType: 'agent',
      entityId: input.agentId,
      data: { listingId: id.data, confirmedBy: input.confirmation.by },
    })
    .catch(() => undefined);
  return { state: 'UNPUBLISHED', listingId: id.data };
}

export async function listPublishedVoices(): Promise<{ ok: true; listings: VoiceListing[] } | StudioProblem> {
  const ready = await studioLinkedContext();
  if ('ok' in ready) return ready;
  const answer = await studioAuthed('/api/v1/installation/voices', { method: 'GET' }).catch((error: Error) => ({
    ok: false as const,
    why: `Studio could not be reached: ${error.message}`,
  }));
  if ('ok' in answer) return answer;
  if (answer.status === 404) return { ok: false, why: 'This Studio does not take published voices yet.' };
  if (answer.status !== 200) return { ok: false, why: describeStudioReply(answer) };
  const parsed = VoiceListAnswer.safeParse(answer.body);
  if (!parsed.success) return { ok: false, why: 'Studio answered with something other than a list of voices, so none of it was used.' };
  if (parsed.data.listings.some((l) => new URL(l.url).origin !== ready.where.origin)) {
    return { ok: false, why: 'Studio\'s list linked to a page that is not on Studio, so none of it was used.' };
  }
  return { ok: true, listings: parsed.data.listings };
}

// ---------------------------------------------------------------------------
// Reading a published voice (no credential, no account)
// ---------------------------------------------------------------------------

export interface FetchedVoice {
  listingId: string;
  version: number;
  publishedAt: string;
  digest: string;
  document: VoiceDocument;
  counts: VoiceCounts;
  findings: VoiceFinding[];
}

/**
 * One version of a published voice, as anybody can read it.
 *
 * Sent without this installation's token or proof: the voice is public, and
 * which installation is reading it is not Studio's business. Whatever comes
 * back is held to the strict schema and then to its own digest, so a Studio
 * that served different bytes than it listed is caught here and not after an
 * agent exists.
 */
export async function fetchPublishedVoice(listingId: string, version?: number): Promise<{ ok: true; voice: FetchedVoice } | StudioProblem> {
  const id = VoiceListingId.safeParse(listingId);
  if (!id.success) return { ok: false, why: 'That is not a listing id.' };

  let wanted = version;
  if (wanted === undefined) {
    const listing = await studioPublicGet(`/api/v1/voices/${encodeURIComponent(id.data)}`);
    if ('ok' in listing) return listing;
    if (listing.status === 404 || listing.status === 410) return { ok: false, why: 'That voice is not listed any more.' };
    if (listing.status !== 200) return { ok: false, why: describeStudioReply(listing) };
    const parsedListing = VoicePublicListing.safeParse(listing.body);
    if (!parsedListing.success || parsedListing.data.listing_id !== id.data) {
      return { ok: false, why: 'Studio answered with something other than a voice listing, so none of it was used.' };
    }
    wanted = parsedListing.data.latest_version;
  }
  if (wanted === undefined || !Number.isInteger(wanted) || wanted < 1) return { ok: false, why: 'That is not a version number.' };
  const target: number = wanted;

  const answer = await studioPublicGet(`/api/v1/voices/${encodeURIComponent(id.data)}/versions/${target}`);
  if ('ok' in answer) return answer;
  if (answer.status === 404 || answer.status === 410) return { ok: false, why: 'That voice, or that version of it, is not listed any more.' };
  if (answer.status !== 200) return { ok: false, why: describeStudioReply(answer) };
  const parsed = VoiceVersionAnswer.safeParse(answer.body);
  if (!parsed.success) {
    return { ok: false, why: 'Studio\'s voice could not be read as an AI17Z voice, so none of it was used.' };
  }
  const body = parsed.data;
  if (body.listing_id !== id.data || body.version !== target) {
    return { ok: false, why: 'Studio answered for a different voice or version than the one asked for, so none of it was used.' };
  }
  const digest = voiceDigest(body.document);
  if (digest !== body.document_sha256) {
    return { ok: false, why: 'The voice does not match the digest Studio lists for it. It is damaged or was altered, so none of it was used.' };
  }
  return {
    ok: true,
    voice: {
      listingId: body.listing_id,
      version: body.version,
      publishedAt: body.published_at,
      digest,
      document: body.document,
      counts: countsOf(body.document),
      findings: scanVoice(body.document),
    },
  };
}
