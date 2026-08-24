import { createLogger } from '@xbam/shared';
import { pipelines as pipelinesRepo, prompts as promptsRepo } from '@xbam/database';
import { DEFAULT_TEMPLATES } from '@xbam/prompts';
import { syncToolCatalogue } from '@xbam/tools';
import { defaultPipelineDraft } from './defaultPipeline';

const log = createLogger('bootstrap');

/**
 * Brings code-owned catalogue data into the database.
 *
 * Prompt templates and tools live in code as the source of truth but are stored
 * as versioned rows so they can be inspected, referenced by a job, and later
 * edited. Re-running this is a no-op unless a definition actually changed.
 */
export async function bootstrapRuntime(): Promise<void> {
  for (const template of DEFAULT_TEMPLATES) {
    const version = await promptsRepo.upsertTemplate(template);
    log.info('prompt template ready', { key: template.key, version: version.version });
  }
  await syncToolCatalogue();
}

/** Gives an agent the default pipeline if it does not have one yet. */
export async function ensureAgentPipeline(agentId: string, triggerLabel?: string): Promise<void> {
  const existing = await pipelinesRepo.getActivePipeline(agentId);
  if (existing) return;
  await pipelinesRepo.savePipelineVersion(agentId, defaultPipelineDraft(triggerLabel), null);
}
