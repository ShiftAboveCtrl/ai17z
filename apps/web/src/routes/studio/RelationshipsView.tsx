import { useResource } from '@app/lib/hooks';
import { EmptyState, Spinner } from '@app/components/ui';
import { Card, Gaps, NoAccount, Panel, Reasons } from './shared';

/**
 * Who leads somewhere this agent does not already reach.
 *
 * The word is meant literally. A bridge connects two groups that are otherwise
 * separate, so an account entirely inside the circle the agent already talks to
 * scores low however well liked it is -- the audience behind them has heard
 * everything already.
 *
 * This is not a ranking of people, and the screen has to say so. Nothing in the
 * reply path reads these numbers: whether to answer somebody is decided by what
 * they said, never by who they are. What this ranks is where the agent's own
 * attention might go next, which is a question about the agent.
 */

interface Bridge {
  handle: string;
  value: number;
  band: string;
  factors: { name: string; detail: string; points: number }[];
  gaps: string[];
  blocked: boolean;
}

const BANDS: Record<string, string> = {
  STRONG: 'Leads somewhere new',
  WORTH_KNOWING: 'Worth knowing',
  WEAK: 'Little reach beyond here',
  NONE: 'Nothing measured either way',
};

export function RelationshipsView({ agentId }: { agentId: string }) {
  const view = useResource<{ ok?: boolean; reason?: string; items: Bridge[] }>(
    `/api/agents/${agentId}/growth/bridges`,
  );
  const items = view.data?.items ?? [];

  return (
    <Panel
      title="Who leads somewhere new"
      lede="Ranked by how much of an audience sits behind them that this agent does not already reach. It is about where its attention goes next, not about anybody's worth."
    >
      {view.loading && <Spinner />}

      {!view.loading && view.data?.ok === false && (
        <NoAccount agentId={agentId} what="This agent has spoken to nobody, because it is not connected anywhere." />
      )}

      {!view.loading && view.data?.ok !== false && items.length === 0 && (
        <EmptyState
          title="Nobody to weigh up yet"
          detail="This fills in as the agent has conversations. Somebody it has never spoken to and never seen mentioned is not somebody it can say anything about."
        />
      )}

      <div className="space-y-3">
        {items.map((bridge) => (
          <Card
            key={bridge.handle}
            title={`@${bridge.handle}`}
            score={bridge.blocked ? 'blocked' : `${bridge.value}`}
            meta={bridge.blocked ? 'You asked this agent not to engage with them.' : BANDS[bridge.band]}
          >
            <Reasons items={bridge.factors} />
            <Gaps items={bridge.gaps} label="Not measured" />
          </Card>
        ))}
      </div>
    </Panel>
  );
}
