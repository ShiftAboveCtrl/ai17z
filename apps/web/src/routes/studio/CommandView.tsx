import { useResource } from '@app/lib/hooks';
import { Spinner } from '@app/components/ui';
import { Gaps, Panel, Tally } from './shared';

/**
 * One screen that says where things stand.
 *
 * Five numbers and the sentence each of them needs. The temptation with a page
 * called Command is a wall of gauges, and a gauge with no sentence beside it is
 * a number somebody invents a meaning for -- "reply value 18" tells nobody
 * anything, which is the failure `docs/ENGINEERING.md` names.
 *
 * Nothing here is a new measurement. Every figure is the same one its own view
 * shows, so the summary and the detail cannot disagree.
 */

interface Counts {
  opportunities: number;
  declined: number;
  narratives: number;
  launches: number;
  measured: number;
  total: number;
}

export function CommandView({ agentId, onGo }: { agentId: string; onGo: (view: string) => void }) {
  const opportunities = useResource<{ opportunities: unknown[]; declined: unknown[]; topics?: string[] }>(
    `/api/agents/${agentId}/growth/opportunities`,
  );
  const narratives = useResource<{ narratives: unknown[]; gaps: string[]; considered: number }>(
    `/api/agents/${agentId}/growth/narratives`,
  );
  const launches = useResource<{ launches: { warnings: string[] }[] }>(`/api/agents/${agentId}/growth/launches`);
  const content = useResource<{ measured: number; total: number; findings: unknown[]; gaps: string[] }>(
    `/api/agents/${agentId}/growth/content`,
  );

  const loading = opportunities.loading || narratives.loading || launches.loading || content.loading;
  const counts: Counts = {
    opportunities: opportunities.data?.opportunities.length ?? 0,
    declined: opportunities.data?.declined.length ?? 0,
    narratives: narratives.data?.narratives.length ?? 0,
    launches: launches.data?.launches.length ?? 0,
    measured: content.data?.measured ?? 0,
    total: content.data?.total ?? 0,
  };
  const contested = (launches.data?.launches ?? []).filter((launch) => launch.warnings.length > 0).length;

  return (
    <>
      <Panel title="Where things stand" lede="Everything on this page is the same figure its own view shows.">
        {/*
          Nothing is shown until every figure has arrived. A grid of zeroes that
          fills in one square at a time reads as five real answers, and somebody
          who looks away for a second has been told the agent found nothing.
        */}
        {loading && <Spinner />}

        {!loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Tally
            value={counts.opportunities}
            label="worth answering"
            hint={
              counts.declined > 0
                ? `Out of ${counts.opportunities + counts.declined} posts looked at. The rest are on Growth with the reason for each.`
                : 'Nothing has been seen to judge yet.'
            }
          />
          <Tally
            value={counts.narratives}
            label="subjects rising"
            hint={`From ${narratives.data?.considered ?? 0} posts this account has seen.`}
          />
          <Tally
            value={counts.launches}
            label="tickers doing the rounds"
            hint={
              contested > 0
                ? `${contested} of them have more than one address being posted, which means at most one is right.`
                : 'Only tickers more than one account has posted appear at all.'
            }
          />
          <Tally
            value={`${counts.measured}/${counts.total}`}
            label="posts measured"
            hint="A post nobody has read the figures for is left out of every comparison rather than counted as a failure."
          />
          <Tally
            value={content.data?.findings.length ?? 0}
            label="things that worked"
            hint="A comparison needs five measured posts on each side before it says anything."
          />
        </div>
        )}
      </Panel>

      <Panel title="Where to look next" lede="In the order somebody usually wants them.">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['growth', 'Worth speaking into', 'What it might answer, and everything it passed over.'],
            ['radar', 'What is being said', 'Subjects several accounts have started using.'],
            ['relationships', 'Who leads somewhere new', 'Where its attention might go next.'],
            ['analytics', 'What has worked', 'Compared across the posts that were measured.'],
            ['launch', 'What is being launched', 'Tickers and addresses, with nothing added.'],
            ['create', 'Something to say', 'The backlog it draws on when it is next due.'],
          ].map(([id, title, blurb]) => (
            <button
              key={id}
              type="button"
              onClick={() => onGo(id!)}
              className="rounded-xl border border-ink-line px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03]"
            >
              <p className="text-[15px] font-light text-bone">{title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-bone-faint">{blurb}</p>
            </button>
          ))}
        </div>
      </Panel>

      <Gaps
        items={[...(narratives.data?.gaps ?? []), ...(content.data?.gaps ?? [])].slice(0, 6)}
        label="What none of this can tell you"
      />
    </>
  );
}
