import {
  accounts as accountsRepo,
  agents as agentsRepo,
  actions as actionsRepo,
  events as eventsRepo,
  jobs as jobsRepo,
  memories as memoriesRepo,
  observability,
} from '@xbam/database';
import { NotFoundError, PipelineError, createLogger, newId } from '@xbam/shared';
import type { EventType, JobRecord, TraceEvent, TraceEventType } from '@xbam/shared/contracts';
import { ingestNormalizedEvent } from './ingest';

const log = createLogger('rehearse');

/**
 * The Response Lab.
 *
 * Answering the question an owner asks before they will let an agent near
 * their account: *what would it say to this, and why that?* Both halves
 * matter. A draft on its own is a thing to like or dislike; a draft with the
 * evidence behind it is a thing to correct.
 *
 * ## It runs the real pipeline, as a rehearsal
 *
 * Not a simplified copy of it. The playground (`playground.ts`) deliberately
 * runs persona, prompt, model, voice and validator with **no** memory, thread
 * or research, because comparing two personas fairly means holding everything
 * else still. That is the right answer to a different question, and it cannot
 * answer this one. Most of what decides a real reply, meaning who this person
 * is, what was said above, what the agent already believes and what it had to
 * look up, is exactly what the playground leaves out.
 *
 * So a rehearsal manufactures an event and lets the ordinary ten steps run,
 * the same way a scheduled post is manufactured as a `SCHEDULED_TRIGGER` event
 * rather than given a pipeline of its own. What comes back is a real job with
 * a real trace, and the explanation below is a reading of that trace rather
 * than a second account of what happened.
 *
 * ## Nothing published, structurally
 *
 * `dryRun: true` is not a parameter here, it is the whole path: it is set in
 * one place, it cannot be passed in, and the job is **checked** afterwards and
 * cancelled if it somehow is not one. That check exists because the mirror of
 * it has already been paid for: a nested `{ options: { dryRun: true } }` was
 * silently ignored in the scenario harness once and an autonomous agent
 * replied to a stranger.
 *
 * ## A rehearsal is not a sighting
 *
 * The event carries an id of its own rather than the post's, for two reasons
 * that point the same way. `events (channel, account, remote_event_id)` is
 * unique, so borrowing the post's id would mean a rehearsal **suppressed** the
 * real mention that arrived an hour later, and would mean the same post could
 * only ever be rehearsed once. Neither is a thing an owner would expect from
 * pressing a button marked "try this".
 */

/** How long the lab waits for the worker to finish a rehearsal. */
export const REHEARSAL_PATIENCE_MS = 90_000;

export interface RehearsalSubject {
  /** Where this came from. `mock` is something somebody typed. */
  channel: 'x' | 'mock';
  /** The status id, when the subject is a real post. */
  remoteId?: string | null;
  url?: string | null;
  authorHandle: string;
  authorId?: string | null;
  authorName?: string | null;
  text: string;
  /** The post above this one, when there is one. */
  parentText?: string | null;
  parentRemoteId?: string | null;
  conversationRef?: string | null;
  occurredAt?: string | null;
  /** Anything the reader could not establish, carried through to the answer. */
  gaps?: string[];
}

export interface RehearsalRun {
  jobId: string;
  eventId: string;
  agentId: string;
  /** What the lab was asked about, as recorded. */
  subject: RehearsalSubject;
}

/**
 * The kind of event this subject is, which decides what the agent does with it.
 *
 * A real post somebody else wrote is a MENTION as far as the pipeline is
 * concerned: something said, which the agent may or may not answer. Whether it
 * actually names the agent is not this function's business. That is the
 * engagement heuristic's decision, and it is one of the stages the lab exists
 * to show.
 */
function eventTypeFor(): EventType {
  return 'MENTION' as EventType;
}

/**
 * Run one rehearsal, and return the job it produced.
 *
 * The account is passed so context resolution, relationship memory and target
 * verification see what they would really see. Everything that reaches the
 * remote side is behind `!job.dryRun` in the execute step, so passing a real
 * account costs nothing and passing null would make the rehearsal less like
 * the thing it is rehearsing.
 */
export async function rehearse(input: {
  agentId: string;
  accountId?: string | null;
  subject: RehearsalSubject;
  requestedBy?: string | null;
}): Promise<RehearsalRun> {
  const agent = await agentsRepo.getAgent(input.agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.state === 'PAUSED') {
    throw PipelineError.permanent(
      'agent_paused',
      'This agent is paused, so it will not think about anything. Resume it to rehearse a reply.',
    );
  }

  const accountId = input.accountId ?? null;
  if (accountId) {
    const account = await accountsRepo.getAccount(accountId);
    if (!account) throw new NotFoundError('Account');
  }

  const subject = input.subject;
  // Its own id, never the post's. See the note above: borrowing it would both
  // suppress the real sighting and make a post rehearsable exactly once.
  const remoteEventId = `rehearsal-${newId()}`;

  const outcome = await ingestNormalizedEvent({
    accountId,
    onlyAgentId: input.agentId,
    dryRun: true,
    event: {
      channel: subject.channel,
      type: eventTypeFor(),
      remoteEventId,
      remoteMessageId: subject.remoteId ?? remoteEventId,
      remoteAuthorId: subject.authorId ?? null,
      remoteAuthorHandle: subject.authorHandle,
      remoteAuthorDisplayName: subject.authorName ?? subject.authorHandle,
      remoteConversationId: subject.conversationRef ?? subject.remoteId ?? remoteEventId,
      parentRemoteMessageId: subject.parentRemoteId ?? null,
      remoteUrl: subject.url ?? null,
      text: subject.text,
      occurredAt: subject.occurredAt ?? new Date().toISOString(),
      raw: {
        origin: 'rehearsal',
        rehearsal: true,
        requestedBy: input.requestedBy ?? null,
        parentText: subject.parentText ?? null,
        readerGaps: subject.gaps ?? [],
      },
    },
  });

  const created = outcome.jobs[0]?.job;
  if (!created) {
    throw PipelineError.permanent(
      'rehearsal_not_queued',
      'Nothing was queued for this. The agent is not linked to an account that may act on it, ' +
        'or it has no capability for the action it would take.',
    );
  }

  /*
    The assertion, not the flag.

    Everything above sets `dryRun: true` in one place, and this reads the row
    back to see that it landed. A rehearsal that somehow became a real job is
    stopped here rather than being allowed to run and discovered afterwards,
    because afterwards is a reply somebody did not ask for, on a real account.
  */
  const job = await jobsRepo.requireJob(created.id);
  if (!job.dryRun) {
    await jobsRepo.updateJob(job.id, { status: 'CANCELLED', lastError: 'A rehearsal must never be a real job.' });
    throw PipelineError.permanent(
      'rehearsal_not_dry',
      'This was queued as a real action rather than a rehearsal, so it was cancelled before it could run. ' +
        'Nothing was sent.',
    );
  }

  log.info('rehearsal queued', { agentId: input.agentId, jobId: job.id, channel: subject.channel });
  return { jobId: job.id, eventId: job.eventId, agentId: input.agentId, subject };
}

/* ------------------------------------------------------------------------- *
 * Explaining it
 * ------------------------------------------------------------------------- */

/** One thing the agent could see, or one thing it could not. */
export interface RehearsalInput {
  key: string;
  /** What this is, in the owner's words. */
  name: string;
  /** Why it matters to the answer. */
  why: string;
  /** What was actually there. Null when nothing was. */
  value: string | null;
  /**
   * False when this was absent.
   *
   * Stated rather than omitted, because "the agent could not read the picture"
   * and "there was no picture" are different things to be told, and a missing
   * row cannot say the first.
   */
  present: boolean;
}

/** One stage of the pipeline, and what it decided. */
export interface RehearsalStage {
  key: string;
  name: string;
  outcome: 'RAN' | 'DECIDED_AGAINST' | 'SKIPPED' | 'FAILED' | 'WAITING';
  /** What happened, in a sentence somebody can act on. */
  detail: string;
  at: string | null;
}

export interface RehearsalExplanation {
  jobId: string;
  agentId: string;
  status: string;
  dryRun: boolean;
  finished: boolean;
  /** What it was asked about. */
  subject: { handle: string | null; text: string; url: string | null; at: string | null };
  /** What the model wrote, before anything of ours touched it. */
  draft: string | null;
  /** What would have been sent. */
  answer: string | null;
  /** Present when the agent decided to say nothing, with the reasons. */
  silence: string | null;
  inputs: RehearsalInput[];
  stages: RehearsalStage[];
  /** Everything nothing could establish. Named, never left as a blank. */
  gaps: string[];
}

/**
 * Which trace events belong to which stage, and what that stage is called.
 *
 * The trace is already a complete record and it is already conclusions rather
 * than reasoning, since no raw chain-of-thought is stored anywhere in this
 * system,
 * so there is none here to leak. What it is not is *legible*: thirty rows of
 * `MEMORY_SELECTED`, `STANCE_SELECTED`, `RESEARCH_PLANNED` in the order they
 * happened is a log, and an owner reading a log is doing the product's job for
 * it.
 *
 * So the rows are grouped into the stages a person would recognise, in the
 * order the answer was actually built up. A stage with no rows is reported as
 * not having run, which is information: "it did not look anything up" is the
 * answer to half the questions asked about a wrong reply.
 */
const STAGES: { key: string; name: string; types: TraceEventType[] }[] = [
  {
    key: 'context',
    name: 'Read the conversation',
    types: ['CONTEXT_RESOLVED', 'MEDIA_RESOLVED'] as TraceEventType[],
  },
  {
    key: 'who',
    name: 'Worked out who this is',
    types: ['RELATIONSHIP_LOADED'] as TraceEventType[],
  },
  {
    key: 'worth',
    name: 'Decided whether to answer at all',
    types: ['ENGAGEMENT_DECIDED', 'INTENT_SELECTED'] as TraceEventType[],
  },
  {
    key: 'lookups',
    name: 'Looked things up',
    types: ['RESEARCH_DONE', 'CAPABILITY_USED'] as TraceEventType[],
  },
  {
    key: 'memory',
    name: 'Brought back what it remembers',
    types: ['MEMORY_SELECTED'] as TraceEventType[],
  },
  {
    key: 'position',
    name: 'Checked it against what it has said before',
    types: ['STANCE_SELECTED', 'STANCE_CONFLICT', 'STANCE_REVISED', 'REPETITION_DETECTED'] as TraceEventType[],
  },
  {
    key: 'prompt',
    name: 'Assembled the prompt',
    types: ['PROMPT_ASSEMBLED'] as TraceEventType[],
  },
  {
    key: 'model',
    name: 'Asked the model',
    types: ['MODEL_REQUEST_COMPLETED', 'MODEL_REQUEST_FAILED'] as TraceEventType[],
  },
  {
    key: 'voice',
    name: 'Made it sound like the agent',
    types: ['VOICE_COMPILED', 'QUALITY_SCORED'] as TraceEventType[],
  },
  {
    key: 'validator',
    name: 'Checked what it was about to say',
    types: ['VALIDATION_PASSED', 'VALIDATION_FAILED'] as TraceEventType[],
  },
  {
    key: 'target',
    name: 'Confirmed the post it would answer',
    types: ['TARGET_VERIFIED', 'TARGET_VERIFICATION_FAILED'] as TraceEventType[],
  },
  {
    key: 'stop',
    name: 'Stopped, because this was a rehearsal',
    types: ['DRY_RUN_STOPPED', 'ACTION_BLOCKED', 'APPROVAL_REQUESTED'] as TraceEventType[],
  },
];

/** Trace types that mean the stage decided against doing something. */
const AGAINST = new Set<string>(['ENGAGEMENT_DECIDED', 'STANCE_CONFLICT', 'REPETITION_DETECTED']);
const FAILED = new Set<string>(['MODEL_REQUEST_FAILED', 'VALIDATION_FAILED', 'TARGET_VERIFICATION_FAILED']);

function outcomeOf(rows: TraceEvent[], job: JobRecord, key: string): RehearsalStage['outcome'] {
  if (rows.length === 0) return job.status === 'CANCELLED' || isFinished(job) ? 'SKIPPED' : 'WAITING';
  if (rows.some((row) => FAILED.has(row.type))) return 'FAILED';
  // An engagement decision that ended the job is the branch where silence is
  // the answer, not an error. Everywhere else it is simply a decision that ran.
  if (key === 'worth' && job.status === 'CANCELLED') return 'DECIDED_AGAINST';
  if (rows.some((row) => AGAINST.has(row.type)) && key === 'position') return 'DECIDED_AGAINST';
  return 'RAN';
}

const TERMINAL = new Set(['EXECUTED', 'DRY_RUN_COMPLETED', 'PERMANENT_FAILURE', 'CANCELLED', 'REVIEW_REQUIRED']);
function isFinished(job: JobRecord): boolean {
  return TERMINAL.has(job.status);
}

/**
 * Several trace rows read as several things, not as one sentence.
 *
 * A stage usually has more than one row behind it, and joining their messages
 * with a space produced "Passed the filter. Passed 100% of the phrasing
 * appeared in a recent reply" -- three separate findings run together into one
 * that says none of them. Measured on a live rehearsal, which is where this
 * kind of thing is visible and a fixture's single row is not.
 *
 * Repeats are dropped rather than shown twice: the validator runs at ingest and
 * again before publication, and both say "Passed".
 */
function sentences(rows: TraceEvent[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const row of rows) {
    const message = (row.message ?? '').trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    parts.push(message);
  }
  return parts.join(' · ');
}

/** Trimmed for a card, with the fact that it was trimmed visible. */
function shorten(text: string | null | undefined, limit = 400): string | null {
  if (!text) return null;
  const clean = text.trim();
  if (clean.length === 0) return null;
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}...`;
}

/**
 * What fed this answer, and what happened to it.
 *
 * Assembled entirely out of rows that already existed. Nothing here is written
 * during a rehearsal that is not written during a real reply, which is the
 * property that makes the lab worth trusting: an explanation produced by a
 * special path would be an explanation of the special path.
 */
export async function explainRehearsal(jobId: string): Promise<RehearsalExplanation> {
  const job = await jobsRepo.getJob(jobId);
  if (!job) throw new NotFoundError('Job');

  const [event, trace, retrievals, performed] = await Promise.all([
    eventsRepo.getEvent(job.eventId),
    observability.listTrace(job.id),
    memoriesRepo.listRetrievals(job.id),
    actionsRepo.listJobActions(job.id),
  ]);

  const byType = new Map<string, TraceEvent[]>();
  for (const row of trace) {
    const list = byType.get(row.type) ?? [];
    list.push(row);
    byType.set(row.type, list);
  }

  const stages: RehearsalStage[] = STAGES.map((stage) => {
    const rows = stage.types.flatMap((type) => byType.get(type) ?? []);
    rows.sort((a, b) => a.at.localeCompare(b.at));
    const last = rows[rows.length - 1];
    return {
      key: stage.key,
      name: stage.name,
      outcome: outcomeOf(rows, job, stage.key),
      detail:
        rows.length === 0
          ? isFinished(job)
            ? 'Did not run.'
            : 'Has not run yet.'
          : sentences(rows),
      at: last?.at ?? null,
    };
  });

  const raw = (event?.payload ?? {}) as Record<string, unknown>;
  const parentText = typeof raw.parentText === 'string' ? raw.parentText : null;
  const readerGaps = Array.isArray(raw.readerGaps) ? raw.readerGaps.filter((g): g is string => typeof g === 'string') : [];

  const inputs: RehearsalInput[] = [
    {
      key: 'post',
      name: 'What was said',
      why: 'The message itself. Everything else is context for this.',
      value: shorten(event?.text ?? null, 1_000),
      present: Boolean(event?.text?.trim()),
    },
    {
      key: 'author',
      name: 'Who said it',
      why: 'An agent that answers a stranger and a regular the same way is not participating in anything.',
      value: event?.remoteAuthorHandle ? `@${event.remoteAuthorHandle.replace(/^@+/, '')}` : null,
      present: Boolean(event?.remoteAuthorHandle),
    },
    {
      key: 'parent',
      name: 'The post above it',
      why: 'A reply on its own often means nothing. The thing being replied to is usually the subject.',
      value: shorten(parentText, 600),
      present: Boolean(parentText),
    },
    {
      key: 'memory',
      name: 'What it remembered',
      why: 'Retrieved from the agent’s own memory, scored against this message.',
      value:
        retrievals.length > 0
          ? retrievals
              .slice(0, 6)
              .map((row) => shorten(row.content ?? '', 140))
              .filter(Boolean)
              .join(' · ')
          : null,
      present: retrievals.length > 0,
    },
    {
      key: 'lookups',
      name: 'What it looked up',
      why: 'An agent asked about something that happened this morning cannot answer from a training set.',
      value: shorten((byType.get('RESEARCH_DONE' as TraceEventType) ?? []).map((row) => row.message).join(' '), 600),
      present: (byType.get('RESEARCH_DONE' as TraceEventType) ?? []).length > 0,
    },
    {
      key: 'relationship',
      name: 'What it knows about this person',
      why: 'Built only from what was actually published between them, never from somebody’s public timeline.',
      value: shorten((byType.get('RELATIONSHIP_LOADED' as TraceEventType) ?? []).map((row) => row.message).join(' '), 400),
      present: (byType.get('RELATIONSHIP_LOADED' as TraceEventType) ?? []).length > 0,
    },
  ];

  const gaps = [
    ...readerGaps,
    ...inputs.filter((input) => !input.present).map((input) => `${input.name}: nothing was available.`),
  ];

  const cancelled = job.status === 'CANCELLED';
  const decision = (byType.get('ENGAGEMENT_DECIDED' as TraceEventType) ?? [])[0]?.message ?? null;

  return {
    jobId: job.id,
    agentId: job.agentId,
    status: job.status,
    dryRun: job.dryRun,
    finished: isFinished(job),
    subject: {
      handle: event?.remoteAuthorHandle ?? null,
      text: event?.text ?? '',
      url: event?.remoteUrl ?? null,
      at: event?.occurredAt ?? null,
    },
    draft: shorten(job.generatedOutput, 2_000),
    answer:
      shorten((performed[0]?.payload as { text?: string } | undefined)?.text ?? job.validatedOutput, 2_000),
    // Silence is a branch, not an error, and it is the answer an owner most
    // often does not understand without the reasons beside it.
    silence: cancelled ? decision ?? job.lastError ?? 'It decided not to answer.' : null,
    inputs,
    stages,
    gaps,
  };
}
