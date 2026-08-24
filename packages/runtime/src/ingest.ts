import type { ActionType, JobRecord, NormalizedEvent } from '@xbam/shared/contracts';
import { PolicyConfig } from '@xbam/shared/contracts';
import { actionIdempotencyKey, createLogger } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  conversations as conversationsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
  prompts as promptsRepo,
  withTransaction,
} from '@xbam/database';
import { REPLY_TEMPLATE_KEY } from '@xbam/prompts';

const log = createLogger('ingest');

export interface IngestOutcome {
  eventId: string;
  eventCreated: boolean;
  jobs: Array<{ job: JobRecord; created: boolean; agentId: string }>;
  skipped: Array<{ agentId: string; reason: string }>;
}

export interface IngestOptions {
  accountId: string | null;
  event: NormalizedEvent;
  /** Restrict to a single agent. Used by mock injection and manual triggers. */
  onlyAgentId?: string;
  /** Overrides the policy default for this event. */
  dryRun?: boolean;
}

/** Agent states that may receive work. PAUSED and ERROR agents stay idle. */
const RUNNABLE_STATES = new Set(['DRAFT', 'ACTIVE']);

/**
 * Turns a channel event into durable work.
 *
 * The event row and every job it produces are written in one transaction and
 * keyed on the remote event id, so this function is safe to call repeatedly with
 * the same event: the second call returns the same rows and creates nothing.
 */
export async function ingestNormalizedEvent(options: IngestOptions): Promise<IngestOutcome> {
  const { event, accountId } = options;

  const links = options.onlyAgentId
    ? [{ agentId: options.onlyAgentId, triggerEventTypes: [event.type], actionType: 'REPLY' as ActionType }]
    : accountId
      ? (await accountsRepo.listAccountAgents(accountId)).map((link) => ({
          agentId: link.agentId,
          triggerEventTypes: link.triggerEventTypes,
          actionType: link.actionType,
        }))
      : [];

  const template = await promptsRepo.getActiveTemplate(REPLY_TEMPLATE_KEY);

  return withTransaction(async (tx) => {
    const { event: stored, created: eventCreated } = await eventsRepo.ingestEvent(tx, accountId, event);
    const outcome: IngestOutcome = { eventId: stored.id, eventCreated, jobs: [], skipped: [] };

    for (const link of links) {
      const agent = await agentsRepo.getAgent(link.agentId);
      if (!agent) {
        outcome.skipped.push({ agentId: link.agentId, reason: 'agent no longer exists' });
        continue;
      }
      if (!RUNNABLE_STATES.has(agent.state)) {
        outcome.skipped.push({ agentId: agent.id, reason: `agent is ${agent.state}` });
        continue;
      }
      if (!link.triggerEventTypes.includes(event.type)) {
        outcome.skipped.push({ agentId: agent.id, reason: `not triggered by ${event.type}` });
        continue;
      }

      const policyRow = await agentsRepo.getActivePolicy(agent.id);
      const policy = PolicyConfig.parse(policyRow?.config ?? {});
      if (policy.automation.mode === 'MANUAL_ONLY' && !options.onlyAgentId) {
        outcome.skipped.push({ agentId: agent.id, reason: 'automation mode is MANUAL_ONLY' });
        continue;
      }

      const conversationRef = event.remoteConversationId ?? event.remoteEventId;
      const conversation = await conversationsRepo.upsertConversation(tx, {
        agentId: agent.id,
        accountId,
        channel: event.channel,
        remoteConversationId: conversationRef,
        remoteUserId: event.remoteAuthorId,
        remoteHandle: event.remoteAuthorHandle,
      });
      await conversationsRepo.recordMessage(tx, {
        conversationId: conversation.id,
        direction: 'INBOUND',
        remoteMessageId: event.remoteMessageId,
        parentRemoteMessageId: event.parentRemoteMessageId,
        authorRemoteId: event.remoteAuthorId,
        authorHandle: event.remoteAuthorHandle,
        body: event.text,
      });

      const idempotencyKey = actionIdempotencyKey({
        channel: event.channel,
        accountId,
        remoteEventId: event.remoteEventId,
        actionType: link.actionType,
        agentId: agent.id,
      });

      const { job, created } = await jobsRepo.createJob(tx, {
        eventId: stored.id,
        agentId: agent.id,
        accountId,
        channel: event.channel,
        actionType: link.actionType,
        idempotencyKey,
        dryRun: options.dryRun ?? policy.automation.dryRunDefault,
        maxAttempts: policy.safety.maxAttempts,
        personaVersionId: agent.personaVersionId,
        policyVersionId: agent.policyVersionId,
        pipelineVersionId: agent.pipelineVersionId,
        promptTemplateVersionId: template.id,
        conversationId: conversation.id,
      });
      outcome.jobs.push({ job, created, agentId: agent.id });

      if (created) {
        await observability.emitTrace({
          jobId: job.id,
          agentId: agent.id,
          type: 'JOB_CREATED',
          message: `${event.type} from @${event.remoteAuthorHandle ?? 'unknown'} on ${event.channel}`,
          data: {
            dryRun: job.dryRun,
            actionType: link.actionType,
            remoteEventId: event.remoteEventId,
            idempotencyKey,
          },
        });
      }
    }

    log.info('event ingested', {
      channel: event.channel,
      remoteEventId: event.remoteEventId,
      eventCreated,
      jobsCreated: outcome.jobs.filter((j) => j.created).length,
      skipped: outcome.skipped.length,
    });
    return outcome;
  });
}
