import { capabilityInvocations, plugins } from '@xbam/database';
import { MAX_CREATIVE_IMAGE_BASE64, buildVersion, createLogger, envBool, pluginCapabilityId, pluginRuns } from '@xbam/shared';
import { invokeCapability } from '@xbam/tools';
import type { JobBundle } from './loadJob';
import { capabilitySettings } from './capabilityPermissions';
import { pauseState } from './killSwitch';

/** A declared Plugin hook, using the same permission, network, quota and audit path as other calls. */
export async function pluginCreativeMedia(bundle: JobBundle): Promise<Uint8Array | null> {
  if (!envBool('AI17Z_POST_MEDIA_ENABLED', false) || !envBool('AI17Z_CREATIVE_MEDIA_ENABLED', false)) return null;
  const settings = await capabilitySettings(bundle.agent.id);
  const paused = (await pauseState()).paused;
  if (paused) return null;
  for (const record of await plugins.listInstalledPlugins()) {
    const declaration = record.manifest.creative;
    if (!declaration || !record.manifest.features.includes('CREATIVE_PROVIDER') ||
      !pluginRuns(record.manifest.compatibility, buildVersion().version).ok) continue;
    const capabilityId = pluginCapabilityId(record.id, declaration.capability);
    // Creative work is opt-in even when the underlying HTTP read defaults to Allowed.
    if (settings.permissions.get(capabilityId) !== 'ALLOWED') continue;
    const result = await invokeCapability({
      call: { id: capabilityId, input: { [declaration.promptField]: (bundle.event.text ?? '').slice(0, 2_000) } },
      context: { agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
        config: settings.configs.get(capabilityId) ?? {}, logger: createLogger('creative-media') },
      permission: { stored: 'ALLOWED', paused },
    });
    await capabilityInvocations.recordInvocation({
      agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId, capabilityId,
      step: 0, outcome: result.outcome, detail: result.detail, input: result.input,
      // Image bytes belong in POST_MEDIA, never in trace or invocation history.
      output: result.outcome === 'SUCCEEDED' ? { imageReturned: true } : null, durationMs: result.durationMs,
    });
    if (result.outcome !== 'SUCCEEDED') continue;
    const encoded = (result.output as Record<string, unknown> | null)?.[declaration.imageField];
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > MAX_CREATIVE_IMAGE_BASE64) continue;
    return Buffer.from(encoded, 'base64');
  }
  return null;
}
