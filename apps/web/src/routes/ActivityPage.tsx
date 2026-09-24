import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePolling, useResource } from '@app/lib/hooks';
import { post } from '@app/lib/api';
import type { JobSummary, MentionRow, MentionState } from '@app/lib/types';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { EmptyState, ErrorPanel, Loading } from '@app/components/ui';
import { Explain } from '@app/components/Explain';
import { timeAgo } from '@app/lib/format';
import { JobCard } from '@app/components/JobCard';
import { MentionCard } from '@app/components/MentionCard';

/**
 * Two questions, not one.
 *
 * The jobs list answers "what did the agent do", which is what you want when
 * something went wrong. The inbox answers "who said something to me and did
 * they get an answer", which is what you want the rest of the time -- and until
 * this existed there was nowhere at all to see a mention the agent never picked
 * up, because a mention with no job has no card in a list of jobs.
 */
const VIEWS = [
  { key: 'inbox', label: 'Mentions' },
  { key: 'waiting', label: 'Waiting for you' },
  { key: 'jobs', label: 'Jobs' },
] as const;

/**
 * What an owner is being asked, in the order a person should meet them.
 *
 * The same six the runtime ranks by, spelled here because the browser cannot
 * import the runtime. They are held against each other in
 * `tests/unit/attentionQueue.test.ts` rather than being trusted to agree.
 */
const KIND_LABELS: Record<string, string> = {
  SECURITY: 'Needs you to sign in or clear a security check',
  DIRECT_INBOUND: 'Somebody wrote to this agent',
  IRREVERSIBLE: 'Something that cannot be taken back',
  AGENT_DECISION: 'A decision the agent made',
  GROWTH_OPPORTUNITY: 'A conversation that looks worth joining',
  ROUTINE_GROWTH: 'Speaking first to somebody who did not ask',
};

interface AttentionItem {
  jobId: string;
  kind: string;
  eventType: string;
  authorHandle: string | null;
  createdAt: string;
  value: number | null;
}

interface AttentionWindowData {
  visible: AttentionItem[];
  /** Kept and counted rather than deleted. Never hidden from the owner. */
  backlogCount: number;
  backlogByKind: Record<string, number>;
  staleCount: number;
  groupedCount: number;
}

const MENTION_FILTERS: { key: MentionState | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'REPLIED', label: 'Replied' },
  { key: 'NEEDS_REVIEW', label: 'Waiting for you' },
  { key: 'DECLINED', label: 'Left alone' },
  { key: 'NOT_ACTIONED', label: 'Not picked up' },
  { key: 'FAILED', label: 'Failed' },
];

const FILTERS = [
  { key: 'live', label: 'Live', statuses: 'RECEIVED,CONTEXT_RESOLVED,MEMORY_RESOLVED,GENERATED,VALIDATED,CONTEXT_RESOLVING,MEMORY_RETRIEVING,GENERATING,VALIDATING,EXECUTING' },
  { key: 'waiting', label: 'Needs review', statuses: 'WAITING_FOR_APPROVAL,REVIEW_REQUIRED' },
  { key: 'done', label: 'Completed', statuses: 'EXECUTED,DRY_RUN_COMPLETED' },
  { key: 'failed', label: 'Failed', statuses: 'PERMANENT_FAILURE,RETRYABLE_FAILURE' },
  { key: 'all', label: 'Everything', statuses: '' },
] as const;

/** One filter chip, so the two lists cannot drift apart visually. */
const CHIP = (active: boolean) =>
  `whitespace-nowrap rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
    active ? 'border-signal-calm/60 bg-signal-calm/[0.08] text-bone' : 'border-ink-line text-bone-faint hover:text-bone-dim'
  }`;

export function ActivityPage() {
  const [params] = useSearchParams();
  const agentId = params.get('agentId');
  const [view, setView] = useState<(typeof VIEWS)[number]['key']>('inbox');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [mentionFilter, setMentionFilter] = useState<MentionState | 'all'>('all');
  /*
    Who wrote to the agent, as opposed to what it came across.

    With the radar running, these are not comparable quantities. Measured on a
    live installation over seventy-two hours: 2,058 posts found by watching
    keywords against fifteen mentions and replies from actual people. A list
    holding both is a list of the first, and the question this page exists to
    answer is the second.
  */
  const [directOnly, setDirectOnly] = useState(true);

  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: '30' });
    if (agentId) query.set('agentId', agentId);
    const statuses = FILTERS.find((f) => f.key === filter)?.statuses;
    if (statuses) query.set('status', statuses);
    return `/api/jobs?${query.toString()}`;
  }, [agentId, filter]);

  const mentionPath = useMemo(() => {
    const query = new URLSearchParams({ limit: '40' });
    if (agentId) query.set('agentId', agentId);
    if (mentionFilter !== 'all') query.set('state', mentionFilter);
    return `/api/mentions?${query.toString()}`;
  }, [agentId, mentionFilter]);

  const jobs = useResource<{ items: JobSummary[]; total: number }>(path);
  const waiting = useResource<AttentionWindowData>(
    agentId ? `/api/jobs/waiting?agentId=${agentId}` : '/api/jobs/waiting',
  );
  const mentions = useResource<{ items: MentionRow[]; counts: Record<MentionState, number> }>(mentionPath);
  const counts = useResource<{ counts: Record<string, number>; awaitingAPerson: number }>(
    agentId ? `/api/jobs/counts?agentId=${agentId}` : '/api/jobs/counts',
  );

  const hasLive = (jobs.data?.items ?? []).some(
    (j) => !['EXECUTED', 'DRY_RUN_COMPLETED', 'PERMANENT_FAILURE', 'CANCELLED'].includes(j.status),
  );
  usePolling(
    () => {
      jobs.reload();
      counts.reload();
      mentions.reload();
      waiting.reload();
    },
    3000,
    hasLive || filter === 'live',
  );

  /*
    Taken from the one definition rather than added up here.

    Adding the two decision statuses counts rehearsals, which publish nothing
    and settle nothing, so this header said two were waiting while the chip
    below it said none.
  */
  const needsReview = counts.data?.awaitingAPerson ?? 0;

  // The two numbers somebody running a social account actually wants: how many
  // people got an answer, and how many did not.
  const replied = mentions.data?.counts.REPLIED ?? 0;
  const unanswered = (mentions.data?.counts.DECLINED ?? 0) + (mentions.data?.counts.NOT_ACTIONED ?? 0);

  /*
    Stopping everything at once.

    Cancelling one job at a time is the precise tool and the wrong one when a
    queue has run away: more arrive while you work through it. This is the
    button for that moment, and it is deliberately not hidden behind a menu --
    somebody looking for it is already having a bad time.

    Confirmed first, because it throws away work in progress, and it names the
    number so the confirmation says something true rather than "are you sure".
  */
  const [stopping, setStopping] = useState(false);
  const inFlight =
    (counts.data?.counts.RECEIVED ?? 0) +
    (counts.data?.counts.CONTEXT_RESOLVED ?? 0) +
    (counts.data?.counts.MEMORY_RESOLVED ?? 0) +
    (counts.data?.counts.GENERATED ?? 0) +
    (counts.data?.counts.VALIDATED ?? 0) +
    (counts.data?.counts.RETRYABLE_FAILURE ?? 0);

  const stopEverything = async () => {
    setStopping(true);
    try {
      await post(agentId ? `/api/jobs/cancel-all?agentId=${agentId}` : '/api/jobs/cancel-all', {});
      jobs.reload();
      counts.reload();
      mentions.reload();
      waiting.reload();
    } finally {
      setStopping(false);
    }
  };

  return (
    <main className="mx-auto max-w-page px-6 pb-24 pt-32 sm:px-10 sm:pt-28">
      <header className="mb-8">
        <FadeIn>
          <p className="eyebrow mb-2">
            {view === 'inbox'
              ? mentions.data
                ? `${replied} answered · ${unanswered} left alone`
                : 'Loading'
              : jobs.data
                ? `${jobs.data.total} job${jobs.data.total === 1 ? '' : 's'}`
                : 'Loading'}
            {needsReview > 0 ? ` · ${needsReview} waiting for you` : ''}
          </p>
        </FadeIn>
        <AnimatedText as="h1" text="Activity" className="monument text-[12vw] leading-[0.95] sm:text-[4.4vw] lg:text-[3.2rem]" />
        <Explain label="this page" className="mt-3">
          <p><strong>Everything your agents have done, and everything they decided not to do.</strong></p>
          <p>Every incoming message becomes a job with a full record of its reasoning: what it read, what it looked up, what it wrote, and whether it was sent. Opening one shows all of it.</p>
          <p>This is the place to look when a reply was not what you expected. Deciding to stay quiet is recorded here too, with its reasons.</p>
        </Explain>
      </header>

      <div className="mb-8 flex flex-wrap items-center gap-2">
        {inFlight > 0 && (
          <button
            type="button"
            className="order-last ml-auto rounded-full border border-signal-fail/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-signal-fail transition-colors hover:bg-signal-fail/10 disabled:opacity-50"
            onClick={() => {
              if (window.confirm(`Stop ${inFlight} job${inFlight === 1 ? '' : 's'} that have not finished?`)) {
                void stopEverything();
              }
            }}
            disabled={stopping}
          >
            {stopping ? 'Stopping...' : `Stop ${inFlight} in flight`}
          </button>
        )}
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            aria-pressed={view === v.key}
            className={`rounded-full px-5 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${
              view === v.key ? 'bg-bone text-ink' : 'border border-ink-line text-bone-faint hover:text-bone-dim'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="scroll-x mb-10 -mx-6 px-6 sm:mx-0 sm:px-0">
        <div className="flex gap-2">
          {/*
            Who wrote in, as opposed to what the agent came across.

            These are not comparable quantities and a list holding both is a
            list of the second. Measured on a live installation over
            seventy-two hours: 2,058 posts found by watching keywords against
            fifteen messages from actual people.
          */}
          {view === 'inbox' && (
            <button
              type="button"
              onClick={() => setDirectOnly((on) => !on)}
              aria-pressed={directOnly}
              className={CHIP(directOnly)}
            >
              {directOnly ? 'Sent to this agent' : 'Everything the radar saw'}
            </button>
          )}
          {view === 'inbox'
            ? MENTION_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setMentionFilter(f.key)}
                  aria-pressed={mentionFilter === f.key}
                  className={CHIP(mentionFilter === f.key)}
                >
                  {f.label}
                  {f.key !== 'all' && mentions.data ? ` ${mentions.data.counts[f.key] ?? 0}` : ''}
                </button>
              ))
            : view === 'waiting'
            ? null
            : FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={CHIP(filter === f.key)}
                >
                  {f.label}
                </button>
              ))}
        </div>
      </div>

      {view === 'waiting' ? (
        waiting.loading && !waiting.data ? (
          <Loading label="Loading what is waiting" />
        ) : waiting.error ? (
          <ErrorPanel title="What is waiting could not be loaded." detail={waiting.error} />
        ) : (waiting.data?.visible.length ?? 0) === 0 ? (
          <EmptyState
            title="Nothing is waiting for you."
            detail="Decisions the agent cannot make on its own appear here."
          />
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 [&>*]:min-w-0 lg:grid-cols-2">
              {waiting.data?.visible.map((item, index) => (
                <FadeIn key={item.jobId} delay={Math.min(index * 0.04, 0.3)}>
                  <Link to={`/jobs/${item.jobId}`} className="card block p-6 hover:border-signal-calm/50">
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-signal-wait">
                      {KIND_LABELS[item.kind] ?? item.kind}
                    </p>
                    <p className="mt-3 break-words text-sm text-bone">
                      {item.authorHandle ? `@${item.authorHandle}` : 'No author recorded'}
                    </p>
                    <p className="mt-1 break-words font-mono text-[10px] text-bone-faint">
                      {item.eventType.toLowerCase().replace(/_/g, ' ')} · {timeAgo(item.createdAt)}
                      {item.value !== null ? ` · scored ${item.value}` : ''}
                    </p>
                  </Link>
                </FadeIn>
              ))}
            </div>
            {/*
              What did not fit, said plainly.

              This list is capped so no single repetitive kind of request can
              fill it, which makes the count below the whole difference between
              a short list and a short list hiding sixty-five things. Nothing
              is deleted, and answering what is shown brings the rest forward.
            */}
            {(waiting.data?.backlogCount ?? 0) > 0 && (
              <p className="break-words text-sm text-bone-dim">
                {waiting.data!.backlogCount} more {waiting.data!.backlogCount === 1 ? 'is' : 'are'} waiting behind
                these:{' '}
                {Object.entries(waiting.data!.backlogByKind)
                  .map(([kind, n]) => `${n} × ${(KIND_LABELS[kind] ?? kind).toLowerCase()}`)
                  .join(', ')}
                . They come forward as you answer these.
              </p>
            )}
            {(waiting.data?.groupedCount ?? 0) > 0 && (
              <p className="break-words text-sm text-bone-faint">
                {waiting.data!.groupedCount} asked about something already shown here, so they are not asked twice.
              </p>
            )}
            {(waiting.data?.staleCount ?? 0) > 0 && (
              <p className="break-words text-sm text-bone-faint">
                {waiting.data!.staleCount} stopped being a live decision, because the post is gone or the request was
                overtaken. They are kept, and no longer take a place here.
              </p>
            )}
          </div>
        )
      ) : view === 'inbox' ? (
        mentions.loading && !mentions.data ? (
          <Loading label="Loading mentions" />
        ) : mentions.error ? (
          <ErrorPanel title="Mentions could not be loaded." detail={mentions.error} />
        ) : (mentions.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            title="Nothing has come in."
            detail={
              mentionFilter === 'all'
                ? 'Connect an account and the radar will start recording what it finds here.'
                : 'No mentions are in this state right now.'
            }
          />
        ) : (
          <div className="grid gap-4 [&>*]:min-w-0 lg:grid-cols-2">
            {mentions.data?.items.map((mention, index) => (
              <FadeIn key={mention.eventId} delay={Math.min(index * 0.04, 0.3)}>
                <MentionCard mention={mention} />
              </FadeIn>
            ))}
          </div>
        )
      ) : jobs.loading && !jobs.data ? (
        <Loading label="Loading activity" />
      ) : jobs.error ? (
        <ErrorPanel title="Activity could not be loaded." detail={jobs.error} />
      ) : (jobs.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="Nothing here."
          detail={filter === 'all' ? 'Inject a test event from an agent activity section to see the pipeline run.' : 'No jobs match this filter right now.'}
        />
      ) : (
        <div className="grid gap-4 [&>*]:min-w-0 lg:grid-cols-2">
          {/*
            `min-w-0` on the children is not decoration. A grid item defaults to
            `min-width: auto`, so it refuses to shrink below the min-content
            width of what is inside it -- a card holding a handle and a job
            summary pushed its track from 342px to 405px, and the whole page
            scrolled sideways on a phone. The track was always right; the item
            was ignoring it.
          */}
          {jobs.data?.items.map((job, index) => (
            <FadeIn key={job.id} delay={Math.min(index * 0.04, 0.3)}>
              <JobCard job={job} showAgent={!agentId} />
            </FadeIn>
          ))}
        </div>
      )}
    </main>
  );
}
