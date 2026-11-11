import { jobs, observability } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { envBool } from '@xbam/shared';
import type { JobBundle } from './loadJob';
import { adapterContext } from './channelContext';
import { forgetPostMedia, mediaRefsOf, storePostMedia, type PostMediaRef } from './postMedia';
import { pluginCreativeMedia } from './pluginCreativeMedia';

interface PostMediaDecision {
  chosen: boolean;
  reason: string;
  media: PostMediaRef[];
}

/** Original posts only. Disabled work changes neither prompt, context, output nor attachment bytes. */
export async function preparePostMedia(bundle: JobBundle): Promise<void> {
  if (bundle.job.actionType !== 'POST') return;
  if (bundle.job.resolvedContext?.meta?.postMediaDecision) return;
  const decision: PostMediaDecision = { chosen: false, reason: 'feature off', media: [] };
  const enabled = envBool('AI17Z_POST_MEDIA_ENABLED', false);
  if (enabled) {
    const attached = mediaRefsOf(bundle.event.payload);
    const adapter = getChannelAdapter(bundle.job.channel);
    if (attached.length) {
      decision.chosen = true;
      decision.reason = 'media already supplied';
    } else if (!bundle.job.resolvedContext) {
      decision.reason = 'post context unavailable';
    } else if (!adapter.supportsMedia) {
      decision.reason = 'channel cannot attach media';
    } else {
      const brief = bundle.event.text ?? '';
      const url = brief.match(/https:\/\/[^\s<>"']+/)?.[0]?.replace(/[.,;!?)\]]+$/, '');
      decision.reason = url ? 'screenshot unavailable' : 'no URL to show';
      let bytes: Uint8Array | null = null;
      if (url && adapter.capturePostMedia) {
        // Capture is optional evidence. Its failure leaves a reason, never invented media.
        bytes = await adapter.capturePostMedia(await adapterContext(bundle), url).catch(() => null);
        if (bytes) decision.reason = /release/i.test(brief) ? 'release page screenshot' : 'live page screenshot';
      } else if (!url && envBool('AI17Z_CREATIVE_MEDIA_ENABLED', false)) {
        bytes = await pluginCreativeMedia(bundle).catch(() => null);
        if (bytes) decision.reason = 'creative Plugin image';
      }
      if (bytes) {
        try {
          decision.media = [await storePostMedia({ agentId: bundle.agent.id, jobId: bundle.job.id, bytes, scope: { source: 'post_media_decision' } })];
          decision.chosen = true;
        } catch {
          decision.reason = 'media could not be stored';
        }
      }
    }
  }
  await observability.emitTrace({
    jobId: bundle.job.id, agentId: bundle.agent.id, type: 'POST_MEDIA_DECIDED',
    message: `Post media: ${decision.reason}.`,
    data: { phase: 'post_media', chosen: decision.chosen, reason: decision.reason },
  });
  // Keep the disabled path byte-identical. The trace is its only added observation.
  if (enabled && bundle.job.resolvedContext) {
    const context = { ...bundle.job.resolvedContext, meta: { ...bundle.job.resolvedContext.meta, postMediaDecision: decision } };
    try {
      await jobs.updateJob(bundle.job.id, { resolvedContext: context });
    } catch (error) {
      await forgetPostMedia(decision.media.map(m => m.artifactId));
      throw error;
    }
    bundle.job.resolvedContext = context;
  }
}

/** References survive reloads and retries without recapturing a different page. */
export function decidedPostMedia(bundle: JobBundle): PostMediaRef[] {
  const decision = bundle.job.resolvedContext?.meta?.postMediaDecision as PostMediaDecision | undefined;
  return mediaRefsOf({ media: decision?.media });
}
