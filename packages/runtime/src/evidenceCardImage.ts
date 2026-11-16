import { agents, jobs, observability, withAdvisoryLock } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { PolicyConfig } from '@xbam/shared/contracts';
import type { JobBundle } from './loadJob';
import { evidenceCardOf } from './evidenceCard';
import { evidenceCardRequest } from './research';
import { evidenceCardImagePayload, holderMapImagePayload, requestEvidenceCardImage } from './studioEvidenceCardImage';
import { forgetPostMedia, mediaRefsOf, storePostMedia, type PostMediaRef } from './postMedia';

/** What was decided about a picture for one card reply, kept on the job so a retry sends the same bytes. */
interface CardImageDecision {
  chosen: boolean;
  reason: string;
  media: PostMediaRef[];
}

const META_KEY = 'evidenceCardImage';
const MAP_META_KEY = 'holderMapImage';

/**
 * Decides, once per job, whether this evidence card reply carries a picture.
 *
 * Off unless the owner turned `tools.evidenceCardImage` on, and read again from the
 * current policy because a card can sit in review for hours. Every way of not getting
 * a picture (not linked, slow, not an image, channel cannot attach) is a recorded
 * reason and leaves the reply as the text card it already was. A dry run asks nobody:
 * nothing leaves the machine for a reply that will not be sent.
 *
 * The holder map is a second picture with its own owner switch (`tools.holderMap`) and its own
 * recorded decision. Either, both or neither may be on; each falls back to text on its own.
 */
export async function prepareEvidenceCardImage(bundle: JobBundle, output: string): Promise<void> {
  const card = evidenceCardOf(bundle);
  if (!card || bundle.job.actionType !== 'REPLY') return;
  return withAdvisoryLock(`evidence-card-image:${bundle.job.id}`, async () => {
    await decide(bundle, card, output);
    await decideHolderMap(bundle, card, output);
  });
}

/** Records one decision on the job and a trace, forgetting any stored picture if the job could not be updated. */
async function record(bundle: JobBundle, key: string, decision: CardImageDecision, capability: string, subject: string): Promise<void> {
  const context = bundle.job.resolvedContext!;
  const next = { ...context, meta: { ...context.meta, [key]: decision } };
  try {
    await jobs.updateJob(bundle.job.id, { resolvedContext: next });
  } catch (error) {
    await forgetPostMedia(decision.media.map(m => m.artifactId));
    throw error;
  }
  bundle.job.resolvedContext = next;
  await observability.emitTrace({ jobId: bundle.job.id, agentId: bundle.agent.id, type: 'RESEARCH_DONE',
    message: decision.chosen ? `${subject} picture attached.` : `${subject} sent as text: ${decision.reason}.`,
    data: { capability, chosen: decision.chosen, reason: decision.reason } }).catch(() => undefined);
}

/**
 * The holder map picture. Drawn from the view stored on the card, so the figures in the pixels
 * are the figures in the approved text twin, which stays in the reply whether or not a picture
 * arrives: Studio being unlinked, slow or answering badly costs nothing but the picture.
 */
async function decideHolderMap(bundle: JobBundle, card: NonNullable<ReturnType<typeof evidenceCardOf>>, output: string): Promise<void> {
  const context = bundle.job.resolvedContext;
  // No block on the card, no decision and no trace: a card without a map is byte for byte what it was.
  if (!context || !card.holderMap || (context.meta as Record<string, unknown>)[MAP_META_KEY]) return;
  const current = await agents.getActivePolicy(bundle.agent.id);
  const policy = PolicyConfig.parse(current?.config ?? {});
  if (!policy.tools.holderMap || !policy.tools.evidenceCards) return;

  const decision: CardImageDecision = { chosen: false, reason: 'no picture', media: [] };
  const view = card.holderMap.view;
  const adapter = getChannelAdapter(bundle.job.channel);
  if (bundle.job.dryRun) decision.reason = 'dry run';
  else if (!adapter.supportsMedia) decision.reason = 'channel cannot attach media';
  else if (output !== card.text) decision.reason = 'text is not the approved card';
  else if (!view || card.holderMap.form === 'note') decision.reason = 'holder map was not read';
  else {
    const payload = holderMapImagePayload(view);
    if (!payload) decision.reason = 'no account with a read supply percent to draw';
    else {
      const picture = await requestEvidenceCardImage(payload).catch(() => ({ ok: false as const, reason: 'Studio unavailable' }));
      if (!picture.ok) decision.reason = picture.reason;
      else {
        try {
          decision.media = [await storePostMedia({ agentId: bundle.agent.id, jobId: bundle.job.id, bytes: picture.bytes,
            scope: { source: 'holder_map_image' } })];
          decision.chosen = true;
          decision.reason = 'Studio holder map image';
        } catch {
          decision.reason = 'media could not be stored';
        }
      }
    }
  }
  await record(bundle, MAP_META_KEY, decision, 'holder_map_image', 'Holder map');
}

async function decide(bundle: JobBundle, card: NonNullable<ReturnType<typeof evidenceCardOf>>, output: string): Promise<void> {
  const context = bundle.job.resolvedContext;
  if (!context || (context.meta as Record<string, unknown>)[META_KEY]) return;
  const current = await agents.getActivePolicy(bundle.agent.id);
  const policy = PolicyConfig.parse(current?.config ?? {});
  // Absent policy flag leaves no trace at all: the job is byte for byte what it was before this feature.
  if (!policy.tools.evidenceCardImage || !policy.tools.evidenceCards) return;

  const decision: CardImageDecision = { chosen: false, reason: 'no picture', media: [] };
  const request = evidenceCardRequest(context.incomingText);
  const adapter = getChannelAdapter(bundle.job.channel);
  if (bundle.job.dryRun) decision.reason = 'dry run';
  else if (!adapter.supportsMedia) decision.reason = 'channel cannot attach media';
  else if (output !== card.text) decision.reason = 'text is not the approved card';
  else if (!request?.address || !request.chain || request.refusal) decision.reason = 'no token on this card';
  else if (!card.readings.some(r => r.value !== null)) decision.reason = 'card has no readings';
  else {
    const payload = evidenceCardImagePayload({ chain: request.chain, address: request.address, readings: card.readings });
    if (!payload) decision.reason = 'card is not in the frozen payload shape';
    else {
      const picture = await requestEvidenceCardImage(payload).catch(() => ({ ok: false as const, reason: 'Studio unavailable' }));
      if (!picture.ok) decision.reason = picture.reason;
      else {
        try {
          decision.media = [await storePostMedia({ agentId: bundle.agent.id, jobId: bundle.job.id, bytes: picture.bytes,
            scope: { source: 'evidence_card_image' } })];
          decision.chosen = true;
          decision.reason = 'Studio card image';
        } catch {
          decision.reason = 'media could not be stored';
        }
      }
    }
  }

  await record(bundle, META_KEY, decision, 'evidence_card_image', 'Evidence card');
}

/** References survive reloads and retries without asking Studio for a different picture. The card's picture comes first. */
export function decidedEvidenceCardImage(bundle: JobBundle): PostMediaRef[] {
  const meta = bundle.job.resolvedContext?.meta as Record<string, unknown> | undefined;
  const media = [META_KEY, MAP_META_KEY].flatMap(key => (meta?.[key] as CardImageDecision | undefined)?.media ?? []);
  return mediaRefsOf({ media });
}
