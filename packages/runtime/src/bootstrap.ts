import { createLogger, errorMessage } from '@xbam/shared';
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
  await upgradePipelinesWithResearch().catch((error) =>
    log.warn('could not add the research node to existing pipelines', { message: errorMessage(error) }),
  );
}

/** Gives an agent the default pipeline if it does not have one yet. */
export async function ensureAgentPipeline(agentId: string, triggerLabel?: string): Promise<void> {
  const existing = await pipelinesRepo.getActivePipeline(agentId);
  if (existing) return;
  await pipelinesRepo.savePipelineVersion(agentId, defaultPipelineDraft(triggerLabel), null);
}

/**
 * Adds the research node to pipelines that predate it.
 *
 * `ensureAgentPipeline` gives an agent the stock graph only when it has none,
 * so a feature added to the default pipeline reaches new agents and nobody
 * else. Every existing agent would have gone on being unable to look anything
 * up, which is exactly the sort of silent half-rollout that makes a feature
 * look broken.
 *
 * Deliberately conservative: it only touches a pipeline that still has the
 * stock `intent -> memory` edge and no research node. A graph somebody has
 * edited is theirs, and is left alone.
 */
export async function upgradePipelinesWithResearch(): Promise<number> {
  const agentIds = await pipelinesRepo.agentsWithPipelines();
  let upgraded = 0;

  for (const agentId of agentIds) {
    const pipeline = await pipelinesRepo.getActivePipeline(agentId);
    if (!pipeline) continue;
    if (pipeline.nodes.some((n) => n.kind === 'RESEARCH')) continue;

    const intentToMemory = pipeline.edges.find((e) => e.from === 'intent' && e.to === 'memory');
    if (!intentToMemory) continue;

    const nodes = [
      ...pipeline.nodes,
      { key: 'research', kind: 'RESEARCH' as const, label: 'Look it up', config: {}, x: 0, y: 8 },
    ];
    const edges = [
      ...pipeline.edges.filter((e) => !(e.from === 'intent' && e.to === 'memory')),
      { from: 'intent', to: 'research', branch: 'next' as const, condition: null },
      { from: 'research', to: 'memory', branch: 'next' as const, condition: null },
    ];

    await pipelinesRepo.savePipelineVersion(
      agentId,
      { name: pipeline.name, nodes, edges, changeNote: 'Added the research node' },
      null,
    );
    upgraded += 1;
  }

  if (upgraded > 0) log.info('added the research node to existing pipelines', { upgraded });
  return upgraded;
}
