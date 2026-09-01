import type { ActionType, Capability, JobRecord, NormalizedEvent as NormalizedEventType } from '@xbam/shared/contracts';
import { z } from 'zod';
import { NormalizedEvent, PolicyConfig } from '@xbam/shared/contracts';
import { PipelineError, actionIdempotencyKey, createLogger, sanitizeText } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  conversations as conversationsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
  prompts as promptsRepo,
  withTransaction,
} from '@xbam/database';
import { REPLY_TEMPLATE_KEY } from '@xbam/prompts';
import { getChannelAdapter, isChannelImplemented } from '@xbam/channels';

const log = createLogger('ingest');

export interface IngestOutcome {
  eventId: string;
  eventCreated: boolean;
  jobs: Array<{ job: JobRecord; created: boolean; agentId: string }>;
  skipped: Array<{ agentId: string; reason: string }>;
}

/**
 * What ingest accepts, checked at run time and not only by the compiler.
 *
 * Strict on purpose. A caller that misspells a key -- passing `{ options: {
 * dryRun: true } }` instead of `{ dryRun: true }`, which is a mistake I made --
 * would otherwise have the key silently ignored and fall through to the policy
 * default. When the policy default is "act for real", a typo in a test harness
 * publishes a reply. Failing the call is the only acceptable answer: the
 * dangerous option must never be what you get by getting it wrong.
 */
export const IngestOptionsSchema = z
  .object({
    accountId: z.string().uuid().nullable(),
    event: NormalizedEvent,
    /** Restrict to a single agent. Used by mock injection and manual triggers. */
    onlyAgentId: z.string().uuid().optional(),
    /** Overrides the policy default for this event. */
    dryRun: z.boolean().optional(),
  })
  .strict();

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
 * How far back work may be created for something already recorded.
 *
 * Widening what an agent is triggered by must change what happens next, not
 * what happened yesterday. Without this, adding REPLY to an account link would
 * have made a live agent answer sixteen replies it had recorded and ignored
 * over the previous ten hours -- all at once, as fast as its rate limit allowed,
 * to people who had long since moved on. The same trap is waiting behind
 * MONITOR_ONLY: switch an agent to autonomous and it answers everything it ever
 * watched.
 *
 * Six hours because a reply worth answering is answered while the conversation
 * is still happening, and a monitor that is merely slow -- backed off, waiting
 * on a browser, restarted -- is minutes behind, never hours.
 *
 * This applies only to an event that was already on record. A post discovered
 * for the first time is new work whatever timestamp it carries.
 */
const RETROACTIVE_WORK_WINDOW_MS = 6 * 60 * 60_000;

/**
 * Turns a channel event into durable work.
 *
 * The event row and every job it produces are written in one transaction and
 * keyed on the remote event id, so this function is safe to call repeatedly with
 * the same event: the second call returns the same rows and creates nothing.
 */
export async function ingestNormalizedEvent(input: IngestOptions): Promise<IngestOutcome> {
  const parsed = IngestOptionsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw PipelineError.permanent(
      'ingest_bad_options',
      `Ingest was called with options it does not accept: ${issue?.path.join('.') || 'unknown'} ${issue?.message ?? ''}. ` +
        'Nothing was queued. This is refused rather than defaulted because the default is to act for real.',
      { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    );
  }
  const options = parsed.data as IngestOptions;
  const { accountId } = options;

  // Cleaned once, here, because this is the one door every channel comes
  // through. A NUL byte in a mention is not a hypothetical -- Postgres text
  // cannot store one, so it came back as an unclassified driver error at
  // ingest, from a post anybody can write. Zero-widths and bidirectional
  // overrides go the same way: they survive the round trip and come out as
  // something else on somebody's client.
  const event: NormalizedEventType = {
    ...options.event,
    text: sanitizeText(options.event.text ?? ''),
    remoteAuthorDisplayName: options.event.remoteAuthorDisplayName
      ? sanitizeText(options.event.remoteAuthorDisplayName)
      : options.event.remoteAuthorDisplayName,
  };

  const links = options.onlyAgentId
    ? [{ agentId: options.onlyAgentId, triggerEventTypes: [event.type], actionType: 'REPLY' as ActionType }]
    : accountId
      ? (await accountsRepo.listAccountAgents(accountId)).map((link) => ({
          agentId: link.agentId,
          triggerEventTypes: link.triggerEventTypes,
          actionType: link.actionType,
        }))
      : [];

  // Capabilities are read once here and checked again at execution. Checking
  // twice is deliberate: this stops the work being queued at all, and the second
  // check is what actually prevents the action if a grant is revoked meanwhile.
  const grants = new Map<string, Set<Capability>>();
  if (accountId) {
    for (const link of links) {
      grants.set(link.agentId, await capabilitiesRepo.grantsFor(link.agentId, accountId));
    }
  }

  const template = await promptsRepo.getActiveTemplate(REPLY_TEMPLATE_KEY);

  // Decided once, at ingest, so routing does not depend on which worker asks.
  const requiresBrowser = isChannelImplemented(event.channel)
    ? getChannelAdapter(event.channel).requiresBrowser
    : false;

  // Read before the transaction opens, never inside it.
  //
  // `withTransaction` holds one pooled connection for its whole body, so a
  // pooled read taken inside it needs a second connection at the same time.
  // With enough concurrent ingests every connection in the pool is held by a
  // transaction waiting for one that does not exist, and the pool deadlocks
  // until each attempt times out. Twelve monitors surfacing one post -- which
  // is an ordinary Tuesday for the radar -- dropped eleven of them.
  //
  // Neither of these is modified by the transaction, so hoisting them is also
  // the shorter transaction, which is what you want under contention anyway.
  const agentsById = new Map<string, Awaited<ReturnType<typeof agentsRepo.getAgent>>>();
  const policiesById = new Map<string, Awaited<ReturnType<typeof agentsRepo.getActivePolicy>>>();
  for (const link of links) {
    if (agentsById.has(link.agentId)) continue;
    agentsById.set(link.agentId, await agentsRepo.getAgent(link.agentId));
    policiesById.set(link.agentId, await agentsRepo.getActivePolicy(link.agentId));
  }

  const pendingTraces: Array<{ jobId: string; agentId: string; data: Record<string, unknown> }> = [];

  const outcome = await withTransaction(async (tx) => {
    const { event: stored, created: eventCreated } = await eventsRepo.ingestEvent(tx, accountId, event);
    const outcome: IngestOutcome = { eventId: stored.id, eventCreated, jobs: [], skipped: [] };

    // Something recorded long ago that never produced work does not produce it
    // now. A manual trigger is a person asking on purpose and is exempt.
    const staleMs = Date.now() - new Date(stored.ingestedAt).getTime();
    if (!eventCreated && !options.onlyAgentId && staleMs > RETROACTIVE_WORK_WINDOW_MS) {
      const hours = Math.round(staleMs / 3_600_000);
      for (const link of links) {
        outcome.skipped.push({
          agentId: link.agentId,
          reason: `first seen ${hours}h ago and nothing was queued for it then; not queuing it retroactively`,
        });
      }
      return outcome;
    }

    for (const link of links) {
      const agent = agentsById.get(link.agentId) ?? null;
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

      // A manual trigger carries no account link and so has nothing to check.
      const granted = grants.get(agent.id);
      if (granted) {
        if (!granted.has('READ')) {
          outcome.skipped.push({ agentId: agent.id, reason: 'not permitted to read this account' });
          continue;
        }
        if (!granted.has(link.actionType as Capability)) {
          outcome.skipped.push({
            agentId: agent.id,
            reason: `not permitted to ${link.actionType} through this account`,
          });
          continue;
        }
      }

      const policyRow = policiesById.get(agent.id) ?? null;
      const policy = PolicyConfig.parse(policyRow?.config ?? {});
      const mode = policy.automation.mode;

      // OFF does no work at all, not even for a manual trigger.
      if (mode === 'OFF') {
        outcome.skipped.push({ agentId: agent.id, reason: 'automation mode is OFF' });
        continue;
      }
      // MONITOR_ONLY still records the event and the conversation below, so the
      // owner can see what arrived, but creates no job and generates nothing.
      // A manual trigger is an explicit human act and overrides MANUAL_ONLY.
      if (mode === 'MANUAL_ONLY' && !options.onlyAgentId) {
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

      if (mode === 'MONITOR_ONLY' && !options.onlyAgentId) {
        outcome.skipped.push({ agentId: agent.id, reason: 'automation mode is MONITOR_ONLY: recorded, not acted on' });
        continue;
      }

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
        requiresBrowser,
      });
      outcome.jobs.push({ job, created, agentId: agent.id });

      if (created) {
        // The trace row has a foreign key to jobs, and trace writes go through
        // their own connection, so this cannot be emitted until we have committed.
        pendingTraces.push({
          jobId: job.id,
          agentId: agent.id,
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

  for (const trace of pendingTraces) {
    await observability.emitTrace({
      jobId: trace.jobId,
      agentId: trace.agentId,
      type: 'JOB_CREATED',
      message: `${event.type} from @${event.remoteAuthorHandle ?? 'unknown'} on ${event.channel}`,
      data: trace.data,
    });
  }

  return outcome;
}
