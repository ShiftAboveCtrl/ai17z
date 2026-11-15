import { agents, jobs, observability, withAdvisoryLock } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { PolicyConfig } from '@xbam/shared/contracts';
import type { JobBundle } from './loadJob';
import { evidenceCardOf } from './evidenceCard';
import { evidenceCardRequest } from './research';
import { evidenceCardImagePayload, requestEvidenceCardImage } from './studioEvidenceCardImage';
import { forgetPostMedia, mediaRefsOf, storePostMedia, type PostMediaRef } from './postMedia';

/** What was decided about a picture for one card reply, kept on the job so a retry sends the same bytes. */
interface CardImageDecision {
  chosen: boolean;
  reason: string;
  media: PostMediaRef[];
}

const META_KEY = 'evidenceCardImage';

/**
 * Decides, once per job, whether this evidence card reply carries a picture.
 *
 * Off unless the owner turned `tools.evidenceCardImage` on, and read again from the
 * current policy because a card can sit in review for hours. Every way of not getting
 * a picture (not linked, slow, not an image, channel cannot attach) is a recorded
 * reason and leaves the reply as the text card it already was. A dry run asks nobody:
 * nothing leaves the machine for a reply that will not be sent.
 */
export async function prepareEvidenceCardImage(bundle: JobBundle, output: string): Promise<void> {
  const card = evidenceCardOf(bundle);
  if (!card || bundle.job.actionType !== 'REPLY') return;
  return withAdvisoryLock(`evidence-card-image:${bundle.job.id}`, () => decide(bundle, card, output));
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

  const next = { ...context, meta: { ...context.meta, [META_KEY]: decision } };
  try {
    await jobs.updateJob(bundle.job.id, { resolvedContext: next });
  } catch (error) {
    await forgetPostMedia(decision.media.map(m => m.artifactId));
    throw error;
  }
  bundle.job.resolvedContext = next;
  await observability.emitTrace({ jobId: bundle.job.id, agentId: bundle.agent.id, type: 'RESEARCH_DONE',
    message: decision.chosen ? 'Evidence card picture attached.' : `Evidence card sent as text: ${decision.reason}.`,
    data: { capability: 'evidence_card_image', chosen: decision.chosen, reason: decision.reason } }).catch(() => undefined);
}

/** References survive reloads and retries without asking Studio for a different picture. */
export function decidedEvidenceCardImage(bundle: JobBundle): PostMediaRef[] {
  const decision = (bundle.job.resolvedContext?.meta as Record<string, unknown> | undefined)?.[META_KEY] as CardImageDecision | undefined;
  return mediaRefsOf({ media: decision?.media });
}
