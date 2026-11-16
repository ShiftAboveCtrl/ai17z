import { agents, jobs, observability, withAdvisoryLock } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { PolicyConfig } from '@xbam/shared/contracts';
import { validateMedia } from '@xbam/shared';
import type { JobBundle } from './loadJob';
import { studioInstallationFile } from './studioLink';
import { EVIDENCE_CARD_IMAGE_MAX_BYTES, EVIDENCE_CARD_IMAGE_TIMEOUT_MS } from './studioEvidenceCardImage';
import { forgetPostMedia, mediaRefsOf, storePostMedia, type PostMediaRef } from './postMedia';
import { RECAP_IDEA_SOURCE, ReceiptsRecapImageRequest, RECEIPTS_RECAP_IMAGE_PATH, receiptsRecapImagePayload, type Recap } from './receiptsRecap';

interface RecapImageDecision {
  chosen: boolean;
  reason: string;
  media: PostMediaRef[];
}

const META_KEY = 'receiptsRecapImage';

type Outcome = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/** Asks the linked Studio to draw the recap. Never throws: every failure is a reason and the post goes out as text. */
export async function requestReceiptsRecapImage(payload: ReceiptsRecapImageRequest): Promise<Outcome> {
  const checked = ReceiptsRecapImageRequest.safeParse(payload);
  if (!checked.success) return { ok: false, reason: 'recap is not in the frozen payload shape' };
  const answer = await studioInstallationFile(RECEIPTS_RECAP_IMAGE_PATH, checked.data, {
    timeoutMs: EVIDENCE_CARD_IMAGE_TIMEOUT_MS, maxBytes: EVIDENCE_CARD_IMAGE_MAX_BYTES,
  });
  if (!answer.ok) return { ok: false, reason: 'Studio unavailable' };
  if (answer.status !== 200 || !answer.bytes || answer.bytes.byteLength === 0) return { ok: false, reason: `Studio answered ${answer.status} with no picture` };
  if (answer.bytes.byteLength > EVIDENCE_CARD_IMAGE_MAX_BYTES) return { ok: false, reason: 'picture too large' };
  try {
    // From the bytes. A content type is a claim, and a document is not a picture.
    if (validateMedia(answer.bytes).kind !== 'IMAGE') return { ok: false, reason: 'Studio answer was not a still image' };
  } catch {
    return { ok: false, reason: 'Studio answer was not an image' };
  }
  return { ok: true, bytes: answer.bytes };
}

/**
 * Decides, once per job, whether this recap post carries a picture. Off unless the
 * owner turned `studio.receiptsRecapImage` on, and read again from the current
 * policy. Every way of not getting a picture is a recorded reason and leaves the
 * post as the text it already was. A dry run asks nobody.
 */
export async function prepareReceiptsRecapImage(bundle: JobBundle, recap: Recap | null): Promise<void> {
  if (!recap || bundle.job.actionType !== 'POST') return;
  if ((bundle.event.payload as { ideaSource?: string }).ideaSource !== RECAP_IDEA_SOURCE) return;
  return withAdvisoryLock(`receipts-recap-image:${bundle.job.id}`, () => decide(bundle, recap));
}

async function decide(bundle: JobBundle, recap: Recap): Promise<void> {
  const context = bundle.job.resolvedContext;
  if (!context || (context.meta as Record<string, unknown>)[META_KEY]) return;
  const current = await agents.getActivePolicy(bundle.agent.id);
  const policy = PolicyConfig.parse(current?.config ?? {});
  // Absent flag leaves no trace: the job is byte for byte what it was.
  if (!policy.studio.receiptsRecapImage || !policy.studio.postReceiptsRecap) return;

  const decision: RecapImageDecision = { chosen: false, reason: 'no picture', media: [] };
  const adapter = getChannelAdapter(bundle.job.channel);
  if (bundle.job.dryRun) decision.reason = 'dry run';
  else if (!adapter.supportsMedia) decision.reason = 'channel cannot attach media';
  else {
    const payload = receiptsRecapImagePayload(recap);
    if (!payload) decision.reason = 'recap is not in the frozen payload shape';
    else {
      const picture = await requestReceiptsRecapImage(payload).catch(() => ({ ok: false as const, reason: 'Studio unavailable' }));
      if (!picture.ok) decision.reason = picture.reason;
      else {
        try {
          decision.media = [await storePostMedia({ agentId: bundle.agent.id, jobId: bundle.job.id, bytes: picture.bytes, scope: { source: 'receipts_recap_image' } })];
          decision.chosen = true;
          decision.reason = 'Studio recap image';
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
    await forgetPostMedia(decision.media.map((m) => m.artifactId));
    throw error;
  }
  bundle.job.resolvedContext = next;
  await observability.emitTrace({ jobId: bundle.job.id, agentId: bundle.agent.id, type: 'RESEARCH_DONE',
    message: decision.chosen ? 'Receipts recap picture attached.' : `Receipts recap sent as text: ${decision.reason}.`,
    data: { capability: 'receipts_recap_image', chosen: decision.chosen, reason: decision.reason } }).catch(() => undefined);
}

export function decidedReceiptsRecapImage(bundle: JobBundle): PostMediaRef[] {
  const decision = (bundle.job.resolvedContext?.meta as Record<string, unknown> | undefined)?.[META_KEY] as RecapImageDecision | undefined;
  return mediaRefsOf({ media: decision?.media });
}
