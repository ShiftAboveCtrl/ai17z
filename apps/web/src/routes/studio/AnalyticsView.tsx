import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Spinner } from '@app/components/ui';
import { Card, Gaps, Panel } from './shared';

/**
 * What has worked, and what has not been measured.
 *
 * Two lists, and the second one is not padding. A post whose impressions were
 * never read is shown with its figures blank rather than as a row of zeroes,
 * because an owner reading zero concludes the post failed, and what actually
 * happened is that nobody looked.
 *
 * The findings above them refuse to appear below five posts on either side of a
 * comparison. That refusal is the feature: six posts will produce a confident
 * sentence about the ideal length of a post, and somebody will rewrite their
 * agent's voice on the strength of it.
 */

interface Finding {
  dimension: string;
  label: string;
  comparedTo: string;
  sampleSize: number;
  comparedSampleSize: number;
  rate: number;
  comparedRate: number;
  detail: string;
}

interface Signals {
  findings: Finding[];
  gaps: string[];
  measured: number;
  total: number;
}

interface PublishedPost {
  action_id: string;
  remote_post_id: string;
  text: string;
  published_at: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  observed_at: string | null;
}

const figure = (value: number | null) => (value === null ? '—' : value.toLocaleString());

export function AnalyticsView({ agentId }: { agentId: string }) {
  const signals = useResource<Signals>(`/api/agents/${agentId}/growth/content`);
  const posts = useResource<{ items: PublishedPost[] }>(`/api/agents/${agentId}/growth/posts`);
  const items = posts.data?.items ?? [];

  return (
    <>
      <Panel
        title="What has worked"
        lede={
          signals.data
            ? `${signals.data.measured} of ${signals.data.total} published posts have been measured.`
            : 'Compared across the posts that have been measured.'
        }
      >
        {signals.loading && <Spinner />}

        {!signals.loading && (signals.data?.findings.length ?? 0) === 0 && (
          <EmptyState
            title="Not enough to say anything yet"
            detail="A comparison needs at least five measured posts on each side. Below that a single post that got picked up decides the answer, which is worse than no answer."
          />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {(signals.data?.findings ?? []).map((finding) => (
            <Card
              key={`${finding.dimension}-${finding.label}`}
              title={finding.label}
              score={`${finding.rate} vs ${finding.comparedRate}`}
              meta={finding.detail}
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">
                engagements per thousand impressions
              </p>
            </Card>
          ))}
        </div>

        <Gaps items={signals.data?.gaps ?? []} label="Comparisons that could not be made" />
      </Panel>

      <Panel title="Every post" lede="Newest first, with the freshest reading of each.">
        {posts.loading && <Spinner />}

        {!posts.loading && items.length === 0 && (
          <EmptyState
            title="Nothing published yet"
            detail="A post appears here once the agent has actually sent it. Dry runs are not public positions and are not counted."
          />
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-left text-[13px]">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">
                  <th className="py-2 pr-4 font-normal">Post</th>
                  <th className="py-2 pr-4 text-right font-normal">Impressions</th>
                  <th className="py-2 pr-4 text-right font-normal">Likes</th>
                  <th className="py-2 pr-4 text-right font-normal">Replies</th>
                  <th className="py-2 text-right font-normal">Read</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.action_id} className="border-t border-ink-line align-top">
                    <td className="max-w-md py-2.5 pr-4">
                      <a
                        className="break-words text-bone-dim hover:text-bone"
                        href={`https://x.com/i/web/status/${row.remote_post_id}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {row.text.slice(0, 140) || '(no text recorded)'}
                      </a>
                      <p className="mt-1 text-[11px] text-bone-faint">{timeAgo(row.published_at)}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono text-bone-dim">{figure(row.impressions)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-bone-dim">{figure(row.likes)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono text-bone-dim">{figure(row.replies)}</td>
                    <td className="py-2.5 text-right text-[11px] text-bone-faint">
                      {/* Never measured, which is not the same as measured at zero. */}
                      {row.observed_at ? timeAgo(row.observed_at) : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
