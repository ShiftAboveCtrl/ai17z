import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePolling, useResource } from '@app/lib/hooks';
import type { JobSummary } from '@app/lib/types';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { EmptyState, ErrorPanel, Loading } from '@app/components/ui';
import { JobCard } from '@app/components/JobCard';

const FILTERS = [
  { key: 'live', label: 'Live', statuses: 'RECEIVED,CONTEXT_RESOLVED,MEMORY_RESOLVED,GENERATED,VALIDATED,CONTEXT_RESOLVING,MEMORY_RETRIEVING,GENERATING,VALIDATING,EXECUTING' },
  { key: 'waiting', label: 'Needs review', statuses: 'WAITING_FOR_APPROVAL,REVIEW_REQUIRED' },
  { key: 'done', label: 'Completed', statuses: 'EXECUTED,DRY_RUN_COMPLETED' },
  { key: 'failed', label: 'Failed', statuses: 'PERMANENT_FAILURE,RETRYABLE_FAILURE' },
  { key: 'all', label: 'Everything', statuses: '' },
] as const;

export function ActivityPage() {
  const [params] = useSearchParams();
  const agentId = params.get('agentId');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');

  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: '30' });
    if (agentId) query.set('agentId', agentId);
    const statuses = FILTERS.find((f) => f.key === filter)?.statuses;
    if (statuses) query.set('status', statuses);
    return `/api/jobs?${query.toString()}`;
  }, [agentId, filter]);

  const jobs = useResource<{ items: JobSummary[]; total: number }>(path);
  const counts = useResource<{ counts: Record<string, number> }>(
    agentId ? `/api/jobs/counts?agentId=${agentId}` : '/api/jobs/counts',
  );

  const hasLive = (jobs.data?.items ?? []).some(
    (j) => !['EXECUTED', 'DRY_RUN_COMPLETED', 'PERMANENT_FAILURE', 'CANCELLED'].includes(j.status),
  );
  usePolling(() => {
    jobs.reload();
    counts.reload();
  }, 3000, hasLive || filter === 'live');

  const needsReview =
    (counts.data?.counts.WAITING_FOR_APPROVAL ?? 0) + (counts.data?.counts.REVIEW_REQUIRED ?? 0);

  return (
    <main className="mx-auto max-w-page px-6 pb-32 pt-32 sm:px-10 sm:pt-44">
      <header className="mb-14">
        <FadeIn>
          <p className="eyebrow mb-6">
            {jobs.data ? `${jobs.data.total} job${jobs.data.total === 1 ? '' : 's'}` : 'Loading'}
            {needsReview > 0 ? ` · ${needsReview} waiting for you` : ''}
          </p>
        </FadeIn>
        <AnimatedText as="h1" text="Activity" className="monument text-[16vw] leading-[0.84] sm:text-[9vw] lg:text-[6.5vw]" />
      </header>

      <div className="scroll-x mb-10 -mx-6 px-6 sm:mx-0 sm:px-0">
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`whitespace-nowrap rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                filter === f.key ? 'border-signal-calm/60 bg-signal-calm/[0.08] text-bone' : 'border-ink-line text-bone-faint hover:text-bone-dim'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {jobs.loading && !jobs.data ? (
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
