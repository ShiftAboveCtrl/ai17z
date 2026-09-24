import type {
  ActionType,
  Capability,
  JobRecord,
  NormalizedEvent as NormalizedEventType,
  RelationshipContext,
} from '@xbam/shared/contracts';
import { z } from 'zod';
import { NormalizedEvent, PolicyConfig } from '@xbam/shared/contracts';
import { PipelineError, actionIdempotencyKey, createLogger, envInt, sanitizeText } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  conversations as conversationsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  observability,
  prompts as promptsRepo,
  relationships as relationshipsRepo,
  withTransaction,
  type Tx,
} from '@xbam/database';
import { REPLY_TEMPLATE_KEY } from '@xbam/prompts';
import { getChannelAdapter, isChannelImplemented } from '@xbam/channels';
import { cannotPossiblyEngage, recentRepliesTo } from './engagement';
import { outreachHeadroom } from './steps/social';

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
    /** Record the event and stop. See `recordOnly` on IngestOptions. */
    recordOnly: z.boolean().optional(),
  })
  .strict();

export interface IngestOptions {
  accountId: string | null;
  event: NormalizedEvent;
  /** Restrict to a single agent. Used by mock injection and manual triggers. */
  onlyAgentId?: string;
  /** Overrides the policy default for this event. */
  dryRun?: boolean;
  /**
   * Record the event and consider no agent at all.
   *
   * For a monitor the owner is watching for context rather than to act on. The
   * post is kept -- it is real, it happened, and the agent may need it later to
   * know what a conversation is about -- but nothing is queued from it.
   *
   * Before this, a source with mayTrigger off discarded its candidates outright
   * while counting them as "context only", so watching an account for context
   * produced no context, no event, and no record that anything had been seen.
   */
  recordOnly?: boolean;
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
 * How old a post may be and still be worth answering.
 *
 * The retroactive window above covers something we recorded and ignored. This
 * covers the other half: something we are seeing for the first time that was
 * written long before we looked.
 *
 * Both happen for ordinary reasons. A monitor scrolls eight screens into a
 * search result and reaches last month. An account is connected and its
 * notifications tab is a year of history. A source is added, or the agent is
 * switched on after a week off. Every one of those is a first sighting of a post
 * nobody expects a reply to, and each one queues a job, takes the account lease,
 * spends a model call, and delays the message that arrived a minute ago.
 *
 * Two hours because a reply is a conversation and conversations have a shelf
 * life. Answering a two-hour-old mention is late; answering a two-day-old one
 * reads as a bot working through a backlog, which is exactly what it is.
 *
 * Deliberately generous in one direction: a post whose age cannot be read at all
 * is treated as current. Refusing what we cannot measure would silently drop
 * real mentions the first time X changed its markup.
 */
const MAX_POST_AGE_MS = envInt('AI17Z_MAX_POST_AGE_MINUTES', 120) * 60_000;

/**
 * The same window, for somebody who wrote to the agent directly.
 *
 * The two hours above are right about an opportunity the radar found: joining
 * a stranger's two-hour-old thread uninvited is late, and joining their
 * two-day-old one is a bot working through a backlog.
 *
 * A mention or a reply is not that. Somebody addressed this account and is
 * waiting. Being slow to answer them is a worse fault than being slow, and it
 * is the agent's own discovery latency that made it late, not theirs.
 *
 * Measured on a live installation before this existed: sixteen mentions and
 * replies from real people were recorded and never considered, every one of
 * them because it was first seen between three and a hundred and fifty-one
 * hours after it was written. Not one produced a job, an answer, or anything
 * the owner could see. The freshness rule was working exactly as written; what
 * was wrong was applying an uninvited-outreach rule to somebody's question.
 *
 * A day, because a question answered the next morning is still an answer and
 * still reads as a person catching up, while a week later reads as a machine
 * that found an old row. Anything past it is still recorded, still in the
 * inbox, and still answerable by hand.
 */
const MAX_DIRECT_POST_AGE_MS = envInt('AI17Z_MAX_DIRECT_POST_AGE_MINUTES', 24 * 60) * 60_000;

/** Somebody wrote to the agent, as opposed to the radar finding a post. */
const DIRECT_INBOUND = new Set(['MENTION', 'REPLY', 'DIRECT_MESSAGE']);

/**
 * How old this kind of event may be and still be worth answering.
 *
 * Exported so the rule can be held to without an account, a link and a
 * browser: what is worth pinning is the decision, and the decision is this
 * function.
 */
export function freshnessWindowFor(type: string): number {
  return DIRECT_INBOUND.has(type) ? MAX_DIRECT_POST_AGE_MS : MAX_POST_AGE_MS;
}

/**
 * How far apart a backlog of late answers is spaced.
 *
 * Twelve minutes, so a dozen mentions found after a day offline go out across
 * two hours rather than in six minutes.
 */
const CATCH_UP_SPACING_MS = 12 * 60_000;

/** The most a catch-up answer will be held back, however deep the backlog. */
const MAX_CATCH_UP_DELAY_MS = 6 * 60 * 60_000;

/**
 * When a late answer should go out, given how many are already queued.
 *
 * Answering somebody a day later is right; answering twelve people a day later
 * within six minutes of each other is a machine working through a backlog, and
 * it reads as one to every person who sees it. The rate limit is no help here:
 * thirty seconds between actions is what it is for, and thirty seconds twelve
 * times is the burst.
 *
 * This is the case the two-hour window used to prevent by refusing the work
 * outright. Widening it to a day for direct inbound -- which is right, because
 * the lateness is the agent's own discovery and not theirs -- gives that fault
 * somewhere to reappear, so the spacing has to arrive with it.
 *
 * Only for catch-up. A mention that is genuinely new runs now, which is almost
 * every mention: the ordinary case is a post minutes old and this returns null
 * for it. And a delay is not a decision -- each job re-reads freshness, the
 * conversation and the person when its turn comes, so an opportunity that
 * stopped being one in the meantime is declined then rather than sent.
 */
async function catchUpDelayMs(
  tx: Tx,
  agentId: string,
  type: string,
  age: number | null,
): Promise<Date | null> {
  if (age === null || age <= MAX_POST_AGE_MS || !DIRECT_INBOUND.has(type)) return null;
  const rows = await tx
    .many<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs
        WHERE agent_id = $1 AND run_at > now()
          AND status NOT IN ('EXECUTED','DRY_RUN_COMPLETED','CANCELLED','PERMANENT_FAILURE')`,
      [agentId],
    )
    .catch(() => [] as { n: string }[]);
  const queued = Number(rows[0]?.n ?? 0);
  return new Date(Date.now() + Math.min((queued + 1) * CATCH_UP_SPACING_MS, MAX_CATCH_UP_DELAY_MS));
}

/** How old the post is, or null when nothing readable said. */
function postAgeMs(occurredAt: string | null | undefined, now = Date.now()): number | null {
  if (!occurredAt) return null;
  const at = new Date(occurredAt).getTime();
  if (!Number.isFinite(at)) return null;
  // A timestamp in the future is a clock disagreement, not an old post.
  return Math.max(0, now - at);
}

/**
 * The link a manual trigger acts through.
 *
 * Which events trigger the agent is deliberately overridden here -- a manual
 * trigger is a person deciding that *this* event is worth acting on, and that
 * exemption is the whole point of the path.
 *
 * What the agent then *does* is not the person's to invent, and this used to
 * hard-code REPLY. An agent configured to LIKE, asked to act on a post, posted
 * a reply to it instead: the wrong public action, and not one the owner had
 * chosen. The capability check below inherited the same mistake, asking whether
 * REPLY was granted rather than the action that would actually run -- so an
 * agent granted LIKE and not REPLY was refused, and one granted REPLY but
 * configured never to use it was allowed.
 *
 * Falls back to REPLY only when there is no link at all, which is the case the
 * mock channel's inject route has always been in.
 */
async function manualTriggerLink(
  accountId: string | null,
  agentId: string,
  type: NormalizedEventType['type'],
): Promise<{ agentId: string; triggerEventTypes: string[]; actionType: ActionType }[]> {
  const links = accountId ? await accountsRepo.listAccountAgents(accountId) : [];
  const own = links.find((link) => link.agentId === agentId);
  return [
    {
      agentId,
      triggerEventTypes: [type],
      actionType: own?.actionType ?? ('REPLY' as ActionType),
    },
  ];
}

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

  // Watched for context, not to act on. The event is still recorded, because
  // it happened and the agent may need it later to know what a thread is about.
  const links = options.recordOnly
    ? []
    : options.onlyAgentId
    ? await manualTriggerLink(accountId, options.onlyAgentId, event.type)
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

  /*
    What it takes to know, before spending anything, that this one is a no.

    Only gathered for a post the agent came across rather than one addressed to
    it, and only when there is an agent to gather it for. Three indexed reads
    against the amount of work a keyword match was costing before the decision
    was taken: a status page walked, every picture on it described by a vision
    model, a relationship assembled, a pipeline run. See `cannotPossiblyEngage`.
  */
  const triage = new Map<string, { topics: string[]; relationship: RelationshipContext | null; recent: number }>();
  // The account's own handle decides whether a keyword match is actually
  // addressed to the agent, which takes it out of unprompted territory
  // entirely. `policy.content.selfHandles` is an aliases list nobody fills in.
  let selfHandle: string | null = null;
  if (event.type === 'KEYWORD_MATCH' && !options.onlyAgentId) {
    selfHandle = accountId ? ((await accountsRepo.getAccount(accountId))?.handle ?? null) : null;
    for (const link of links) {
      if (triage.has(link.agentId)) continue;
      const persona = await agentsRepo.getActivePersona(link.agentId).catch(() => null);
      const relationship = event.remoteAuthorHandle
        ? await relationshipsRepo
            .find({ agentId: link.agentId, channel: event.channel, handle: event.remoteAuthorHandle })
            .catch(() => null)
        : null;
      triage.set(link.agentId, {
        topics: persona?.topics ?? [],
        // Only the three fields the score reads. The full context is assembled
        // later by the step that needs all of it; building it here would be
        // the expensive work this exists to avoid.
        relationship: relationship
          ? {
              known: true,
              handle: relationship.handle,
              familiarity: relationship.familiarity,
              historyLine: '',
              topics: [],
              summary: null,
              ownerNote: null,
              disposition: relationship.disposition,
              callback: null,
            }
          : null,
        recent: await recentRepliesTo(link.agentId, event.remoteAuthorHandle).catch(() => 0),
      });
    }
  }

  const pendingTraces: Array<{ jobId: string; agentId: string; data: Record<string, unknown> }> = [];

  const outcome = await withTransaction(async (tx) => {
    const { event: stored, created: eventCreated } = await eventsRepo.ingestEvent(tx, accountId, event);
    const outcome: IngestOutcome = { eventId: stored.id, eventCreated, jobs: [], skipped: [] };

    // A post written long before we saw it. Recorded, so the inbox shows it and
    // a person can act on it, but no work is queued: it is history, not a
    // conversation. A manual trigger is somebody deciding otherwise.
    const age = postAgeMs(event.occurredAt);
    const window = freshnessWindowFor(event.type);
    if (age !== null && age > window && !options.onlyAgentId) {
      const hours = Math.round(age / 3_600_000);
      for (const link of links) {
        outcome.skipped.push({
          agentId: link.agentId,
          reason:
            hours >= 1
              ? `posted about ${hours}h ago, past the ${Math.round(window / 60_000)} minute freshness window`
              : `posted ${Math.round(age / 60_000)} minutes ago, past the freshness window`,
        });
      }
      log.info('event recorded but too old to answer', {
        remoteEventId: event.remoteEventId,
        ageHours: hours,
      });
      return outcome;
    }

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
      const policyRow = policiesById.get(agent.id) ?? null;
      const policy = PolicyConfig.parse(policyRow?.config ?? {});

      // Turning outreach on is the whole decision. Requiring KEYWORD_MATCH to
      // be added to the link as well would be a second setting that has to
      // agree with the first, in another screen -- which is exactly how
      // `reply_search` and `own_threads` came to find replies for months and
      // have every one of them dropped here with "not triggered by REPLY".
      //
      // So the policy is the single source of truth for this one type, and
      // nothing needs to be kept in sync with it.
      const triggered =
        link.triggerEventTypes.includes(event.type) ||
        (event.type === 'KEYWORD_MATCH' && policy.outreach.enabled);

      if (!triggered) {
        outcome.skipped.push({
          agentId: agent.id,
          reason:
            event.type === 'KEYWORD_MATCH'
              ? 'found by watching, and this agent does not approach people unprompted'
              : `not triggered by ${event.type}`,
        });
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

      /*
        The cheap half of a decision the expensive half was making anyway.

        Deliberately placed *after* the event, the conversation and the inbound
        message are written. Nothing is lost by declining here: the post is on
        record, it is in the inbox, and a person can still act on it. What does
        not happen is the status page being walked, the pictures on it being
        described by a vision model, and a pipeline running to reach the same
        conclusion.

        Only for a post the agent came across. A mention or a reply goes
        through the full run whatever it scores, because somebody asked.
      */
      const bounds = triage.get(agent.id);
      if (bounds && event.type === 'KEYWORD_MATCH') {
        const selfHandles = [selfHandle, ...policy.content.selfHandles]
          .filter((h): h is string => Boolean(h))
          .map((h) => h.replace(/^@+/, '').toLowerCase());
        const directlyAddressed = selfHandles.some((self) => event.text.toLowerCase().includes(`@${self}`));
        /*
          A thread the agent is already in is not an approach to a stranger.

          `stepEngagement` settles this with `alreadyInThread`, and it changes
          which bar applies: a conversation the agent is part of is held to the
          ordinary reply threshold rather than to the much higher outreach one.
          Declining here on the outreach bar would therefore refuse something
          the full run would have taken, which is the one thing this whole
          design promises not to do.

          The conversation was written a few lines above, so the answer is a
          read of the rows that are already there. Anything the agent has said
          in this thread settles it, and the full pipeline decides.
        */
        const spokenHere = await conversationsRepo.hasSpokenIn(tx, conversation.id);
        /*
          The budget and the per-person cooldown, asked before the work rather
          than after it.

          These are the same two checks `stepEngagement` has always made, and
          the same function makes them. They were simply being made at the far
          end of a pipeline run: an agent that had already approached its five
          people for the day still walked a status page and described every
          picture on it before being told it had no approaches left.

          A day's budget and a seven-day per-author cooldown are exactly the
          kind of thing a job should never be created to discover.
        */
        const unprompted = !directlyAddressed && !spokenHere;
        const declined = !unprompted
          ? null
          : (await outreachHeadroom(agent.id, policy.outreach, event.remoteAuthorHandle).catch(() => null)) ??
            cannotPossiblyEngage({
              text: event.text,
              directlyAddressed,
              topics: bounds.topics,
              outreach: policy.outreach,
              policy: policy.engagement,
              relationship: bounds.relationship,
              recentRepliesToPerson: bounds.recent,
            });
        if (declined) {
          outcome.skipped.push({ agentId: agent.id, reason: declined });
          continue;
        }
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
        runAt: await catchUpDelayMs(tx, agent.id, event.type, age),
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
