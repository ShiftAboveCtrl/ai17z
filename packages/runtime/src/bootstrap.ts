import { createLogger, errorMessage } from '@xbam/shared';
import { pipelines as pipelinesRepo, prompts as promptsRepo } from '@xbam/database';
import { DEFAULT_TEMPLATES } from '@xbam/prompts';
import { registerBuiltinCapabilities, syncToolCatalogue } from '@xbam/tools';
import {
  registerContractUpstreams,
  registerDefiUpstreams,
  registerEvmUpstreams,
  registerMarketUpstreams,
  registerBitcoinUpstreams,
  registerGovernanceUpstreams,
  registerIpfsUpstreams,
  registerReferenceUpstreams,
  registerSolanaUpstreams,
  registerTokenRiskUpstreams,
  useQuotaCoordinator,
} from '@xbam/upstream';
import { InstallationQuotaCoordinator } from './upstreamQuota';
import { registerChainCapabilities } from './chainCapabilities';
import { registerContractCapabilities } from './contractCapabilities';
import { registerDefiCapabilities } from './defiCapabilities';
import { registerTokenRiskCapabilities } from './tokenRiskCapabilities';
import { registerSolanaCapabilities } from './solanaCapabilities';
import { registerBitcoinCapabilities } from './bitcoinCapabilities';
import { registerGovernanceCapabilities } from './governanceCapabilities';
import { registerStorageCapabilities } from './storageCapabilities';
import { registerReferenceCapabilities } from './referenceCapabilities';
import { defaultPipelineDraft } from './defaultPipeline';
import { registerXCapabilities } from './xCapabilities';

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
  // The capability registry is process-wide and in memory, so it is filled
  // here rather than at import time: a module that registers on load makes
  // the contents of the registry depend on what happened to be imported.
  registerBuiltinCapabilities();
  // X's are registered here rather than in packages/channels: a capability
  // needs an account row and a browser session, which is database work the
  // channel package does not do. The selector boundary is unaffected --
  // what crosses it is still only the normalised shapes.
  registerXCapabilities();

  // Every upstream call in this process now goes through a coordinator that
  // other processes can see. The default one counts alone, which is right for a
  // unit test and wrong for an installation: a container worker and a native
  // worker each holding one would each believe they had the whole allowance,
  // and the endpoint would be shown twice what AI17Z thought it was sending.
  //
  // Which processes this has to cover, checked rather than assumed -- a process
  // that reaches `ask()` without coming through here would quietly spend a
  // budget nobody else could see:
  //
  //   apps/api      -- capability invocations from the interface. Calls this.
  //   apps/worker   -- the pipeline and the capability loop. Calls this.
  //   import-ai4cz  -- calls this, except on a dry run, which reaches nothing.
  //   scenarios/run -- ingests events and stops; the worker executes them, so
  //                    it never reaches an upstream itself.
  //   unit tests    -- deliberately left with the in-memory one.
  const quota = new InstallationQuotaCoordinator();
  useQuotaCoordinator(quota);
  log.info('upstream quota coordinated', quota.describe());

  // Upstreams are registered here for the same reason capabilities are: a
  // registry filled at import time contains whatever happened to be imported.
  registerEvmUpstreams();
  registerContractUpstreams();
  registerMarketUpstreams();
  registerDefiUpstreams();
  registerTokenRiskUpstreams();
  registerSolanaUpstreams();
  registerBitcoinUpstreams();
  registerGovernanceUpstreams();
  registerIpfsUpstreams();
  registerReferenceUpstreams();
  // The capabilities that read a chain, registered after the upstreams they
  // ask. The model asks `chain.read_balance`; which node answers is provenance.
  registerChainCapabilities();
  registerContractCapabilities();
  registerDefiCapabilities();
  registerTokenRiskCapabilities();
  registerSolanaCapabilities();
  registerBitcoinCapabilities();
  registerGovernanceCapabilities();
  registerStorageCapabilities();
  registerReferenceCapabilities();

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
