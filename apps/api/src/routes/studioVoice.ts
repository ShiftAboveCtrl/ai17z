import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agents as agentsRepo, type UserRow } from '@xbam/database';
import { ConflictError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { VOICE_LIMITS, VoiceListingId } from '@xbam/shared/contracts';
import {
  fetchPublishedVoice,
  inspectVoice,
  installPublishedVoice,
  installVoice,
  listPublishedVoices,
  parseVoice,
  previewVoice,
  publishVoice,
  studioStatus,
  unpublishVoice,
  voiceListingOf,
  type VoiceInspection,
} from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Publishing an agent's voice to Studio, and installing one, as the owner
 * reaches them from the agent page and the agent list.
 *
 * Owner control plane only. None of this is a capability and no model reaches
 * it. Every route here goes through the function the capability goes through,
 * `previewVoice`, `publishVoice`, `unpublishVoice`, `installVoice` and
 * `installPublishedVoice`, so the rules live in one place: the document is the
 * allowlist `voiceFromAgent` builds, publishing needs a stored preview of the
 * *same digest* that has not expired, the document is rebuilt and compared
 * before it leaves, and an installed voice is the powerless draft the install
 * code makes. There is no second path to Studio and no second way to make an
 * agent.
 *
 * What differs from the capability is who confirms. A capability needs the
 * owner to say a phrase in their own message, because a model proposes it. A
 * route is reached by a signed-in owner pressing a button, which is itself the
 * act, so it passes `OWNER_ACTION`; the digest in the request is still checked
 * against the stored preview, so a button wired to a stale or invented digest
 * publishes nothing.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

const Digest = z.string().regex(/^[0-9a-f]{64}$/, 'not a sha256 digest');

const PreviewBody = z
  .object({
    title: z.string().trim().max(VOICE_LIMITS.title).optional(),
    summary: z.string().trim().max(VOICE_LIMITS.summary).optional(),
  })
  .strict();

const PublishBody = z.object({ digest: Digest }).strict();
const UnpublishBody = z.object({ listingId: VoiceListingId }).strict();

const FromDocument = {
  document: z.unknown().refine((value) => value !== undefined && value !== null, 'a voice document is required'),
};
const FromListing = { listingId: VoiceListingId, version: z.number().int().min(1).optional() };
const InstallExtras = {
  name: z.string().trim().max(120).optional(),
  acknowledgeFindings: z.boolean().optional(),
};

/**
 * Where a voice to look at or install comes from: a document the owner
 * brought (a file they chose), or a listing on the linked Studio. Exactly one,
 * and nothing else: each shape is strict, so an unknown key is a refusal.
 */
const Source = z.union([z.object(FromDocument).strict(), z.object(FromListing).strict()]);
const InstallBody = z.union([
  z.object({ ...FromDocument, ...InstallExtras }).strict(),
  z.object({ ...FromListing, ...InstallExtras }).strict(),
]);

const invalid = (problem: string): VoiceInspection => ({
  valid: false,
  problem,
  title: null,
  summary: null,
  digest: null,
  counts: null,
  findings: [],
  notes: [],
});

export async function registerStudioVoiceRoutes(app: FastifyInstance): Promise<void> {
  /** Whether the voice can be published at all, and what this installation last heard about this agent's listing. */
  app.get(
    '/api/agents/:id/studio-voice',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const [status, listing] = await Promise.all([studioStatus(), voiceListingOf(agent.id)]);
      return {
        studio: { state: status.state, origin: status.origin },
        listing,
      };
    }),
  );

  /** Builds the exact document and stores the preview a publish must match. Sends nothing. */
  app.post(
    '/api/agents/:id/studio-voice/preview',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(PreviewBody, request);
      return previewVoice({
        agentId: agent.id,
        ...(body.title ? { title: body.title } : {}),
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
      });
    }),
  );

  app.post(
    '/api/agents/:id/studio-voice/publish',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(PublishBody, request);
      const outcome = await publishVoice({
        agentId: agent.id,
        digest: body.digest,
        confirmation: { by: 'OWNER_ACTION' },
        ownerId: user.id,
      });
      // The gate said no: the request is wrong for the state of things, and
      // retrying it unchanged will not help. A Studio that could not be
      // reached is different, and is an answer the page shows as a sentence.
      if (outcome.state !== 'PUBLISHED' && outcome.state !== 'UNAVAILABLE') {
        throw new ConflictError(outcome.why, { state: outcome.state });
      }
      return outcome;
    }),
  );

  app.post(
    '/api/agents/:id/studio-voice/unpublish',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const body = parseBody(UnpublishBody, request);
      return unpublishVoice({
        agentId: agent.id,
        listingId: body.listingId,
        confirmation: { by: 'OWNER_ACTION' },
        ownerId: user.id,
      });
    }),
  );

  /** Every listing this installation has on the linked Studio, as Studio reports them. */
  app.get(
    '/api/studio/voices',
    handler(async (request) => {
      await requireUser(request);
      return listPublishedVoices();
    }),
  );

  /**
   * Looks at a voice and creates nothing. Never an error for a voice that
   * cannot be used: that is something to be told, and the screen shows it.
   */
  app.post(
    '/api/studio/voices/inspect',
    handler(async (request) => {
      await requireUser(request);
      const source = parseBody(Source, request);
      if ('document' in source) {
        // The document is returned beside the counts so the screen can show the
        // whole voice, and it is the parsed one: what installing would use.
        const parsed = parseVoice(source.document);
        return {
          inspection: inspectVoice(source.document),
          document: parsed.ok ? parsed.document : null,
          source: { kind: 'FILE' as const },
        };
      }

      const fetched = await fetchPublishedVoice(source.listingId, source.version);
      if (!fetched.ok) {
        return { inspection: invalid(fetched.why), document: null, source: { kind: 'STUDIO' as const, listingId: source.listingId, version: null, publishedAt: null } };
      }
      return {
        // From the document that passed the digest check, so what is shown is
        // what installing it would use.
        inspection: inspectVoice(fetched.voice.document),
        document: fetched.voice.document,
        source: { kind: 'STUDIO' as const, listingId: fetched.voice.listingId, version: fetched.voice.version, publishedAt: fetched.voice.publishedAt },
      };
    }),
  );

  /** Makes one new agent: a draft, observe only, switched off, owned by the person pressing the button. */
  app.post(
    '/api/studio/voices/install',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(InstallBody, request);
      const common = {
        ownerId: user.id,
        createdBy: user.id,
        ...(body.name ? { name: body.name } : {}),
        ...(body.acknowledgeFindings === undefined ? {} : { acknowledgeFindings: body.acknowledgeFindings }),
      };
      if ('document' in body) return installVoice({ ...common, document: body.document });
      return installPublishedVoice({
        ...common,
        listingId: body.listingId,
        ...(body.version === undefined ? {} : { version: body.version }),
      });
    }),
  );
}
