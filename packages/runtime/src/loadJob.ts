import type { Account, JobRecord, PersonaVersion, PolicyConfig } from '@xbam/shared/contracts';
import { PolicyConfig as PolicyConfigSchema, RegressionCandidate } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  conversations as conversationsRepo,
  events as eventsRepo,
  type ConversationRecord,
  type EventRecord,
} from '@xbam/database';
import type { Agent } from '@xbam/shared/contracts';

export interface JobBundle {
  job: JobRecord;
  agent: Agent;
  persona: PersonaVersion;
  policy: PolicyConfig;
  event: EventRecord;
  account: Account | null;
  conversation: ConversationRecord | null;
}

/**
 * Loads everything a job needs, pinned to the versions it was admitted under.
 * Editing a persona mid-flight must not change what an in-progress job does.
 */
export async function loadJobBundle(job: JobRecord): Promise<JobBundle> {
  const rawCandidate = job.resolvedContext?.meta?.candidate;
  if (rawCandidate !== undefined && !job.dryRun) {
    throw PipelineError.permanent('candidate_not_dry', 'A candidate configuration is only allowed on a rehearsal.');
  }
  const parsed = rawCandidate === undefined ? null : RegressionCandidate.safeParse(rawCandidate);
  if (parsed && !parsed.success) throw PipelineError.permanent('candidate_invalid', 'The rehearsal candidate is invalid.');
  const candidate = parsed?.success ? parsed.data : null;
  const agent = await agentsRepo.getAgent(job.agentId);
  if (!agent) throw PipelineError.permanent('agent_deleted', 'The agent that owns this job no longer exists.');

  let persona = job.personaVersionId
    ? await agentsRepo.getPersonaVersion(job.personaVersionId)
    : await agentsRepo.getActivePersona(job.agentId);
  if (!persona) {
    throw PipelineError.permanent('persona_missing', 'This job has no persona version to generate from.');
  }
  if (candidate?.persona) persona = { ...persona, ...candidate.persona };

  const policyRow = job.policyVersionId
    ? await agentsRepo.getPolicyVersion(job.policyVersionId)
    : await agentsRepo.getActivePolicy(job.agentId);
  const policy = PolicyConfigSchema.parse(candidate?.policy ?? policyRow?.config ?? {});

  const event = await eventsRepo.getEvent(job.eventId);
  if (!event) throw PipelineError.permanent('event_missing', 'The source event for this job is gone.');

  const account = job.accountId ? await accountsRepo.getAccount(job.accountId) : null;
  const conversation = job.conversationId ? await conversationsRepo.getConversation(job.conversationId) : null;

  return { job, agent, persona, policy, event, account, conversation };
}
