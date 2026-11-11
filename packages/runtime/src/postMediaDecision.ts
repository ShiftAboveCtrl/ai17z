import { postMediaDecisions, withAdvisoryLock } from '@xbam/database';
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
  return withAdvisoryLock(`post-media:${bundle.job.id}`, () => decidePostMedia(bundle));
}

async function decidePostMedia(bundle: JobBundle): Promise<void> {
  const previous = await postMediaDecisions.get(bundle.job.id);
  if (previous) {
    if (previous.reason !== 'feature off' && bundle.job.resolvedContext) {
      bundle.job.resolvedContext.meta = { ...bundle.job.resolvedContext.meta, postMediaDecision: previous };
    }
    return;
  }
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
      // Capture URLs only from owner-authored ideas, never generated or ingested text.
      const ownerAuthored = ['manual', 'you'].includes(String(bundle.event.payload.ideaSource));
      const brief = ownerAuthored ? bundle.event.text ?? '' : '';
      const url = brief.match(/https:\/\/[^\s<>"']+/)?.[0]?.replace(/[.,;!?)\]]+$/, '');
      decision.reason = url ? 'screenshot unavailable' : 'no URL to show';
      let bytes: Uint8Array | null = null;
      const hosts = bundle.policy.media.allowedCaptureHosts;
      let allowed = false;
      try { allowed = Boolean(url && hosts.some(host => host.toLowerCase() === new URL(url).hostname)); } catch { /* Invalid owner URL: no capture. */ }
      if (url && !allowed) decision.reason = 'URL not in owner capture host allowlist (empty denies all)';
      if (url && allowed && adapter.capturePostMedia) {
        // Capture is optional evidence. Its failure leaves a reason, never invented media.
        bytes = await adapter.capturePostMedia(await adapterContext(bundle), url, hosts).catch(() => null);
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
  // Rehearsals and dry runs may decide and capture; only execution may publish,
  // and its dry-run gate must always prevent publishing those jobs.
  const context = enabled && bundle.job.resolvedContext
    ? { ...bundle.job.resolvedContext, meta: { ...bundle.job.resolvedContext.meta, postMediaDecision: decision } }
    : null;
  try {
    const saved = await postMediaDecisions.save({ jobId: bundle.job.id, agentId: bundle.agent.id, decision, enabled, context });
    if (!saved) {
      await forgetPostMedia(decision.media.map(m => m.artifactId));
      return;
    }
  } catch (error) {
    await forgetPostMedia(decision.media.map(m => m.artifactId));
    throw error;
  }
  if (context) bundle.job.resolvedContext = context;
}

/** References survive reloads and retries without recapturing a different page. */
export function decidedPostMedia(bundle: JobBundle): PostMediaRef[] {
  const decision = bundle.job.resolvedContext?.meta?.postMediaDecision as PostMediaDecision | undefined;
  return mediaRefsOf({ media: decision?.media });
}
