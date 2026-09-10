import { useState } from 'react';
import { post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { EmptyState, Spinner } from '@app/components/ui';
import { Card, Gaps, NoAccount, Panel } from './shared';

/**
 * What a lot of accounts have started talking about.
 *
 * The number on each row is the share of recent posts that mention it, and the
 * sentence under it is the whole claim. A term is only here because several
 * different accounts used it -- one account repeating itself is somebody's
 * hobby horse, and showing it as a narrative would make the loudest account in
 * the timeline set the agenda.
 *
 * "Add as an idea" is the only action, and it writes to the backlog the posting
 * engine already reads. Nothing here posts anything: an agent coming due looks
 * at the backlog and may still decide there is nothing to say, which is the
 * behaviour `docs/ENGINEERING.md` describes and not something a screen should
 * be able to route around.
 */

interface Narrative {
  term: string;
  authors: number;
  mentions: number;
  share: number;
  priorShare?: number;
  lift?: number;
  examples: string[];
  detail: string;
}

interface Reading {
  ok?: boolean;
  narratives: Narrative[];
  gaps: string[];
  considered: number;
}

export function RadarView({ agentId }: { agentId: string }) {
  const reading = useResource<Reading>(`/api/agents/${agentId}/growth/narratives`);
  const [added, setAdded] = useState<Record<string, 'saving' | 'done' | string>>({});

  const addIdea = async (narrative: Narrative) => {
    setAdded((prev) => ({ ...prev, [narrative.term]: 'saving' }));
    try {
      await post(`/api/agents/${agentId}/ideas`, {
        summary: `Something worth saying about ${narrative.term}`,
        detail: `${narrative.detail} Seen from ${narrative.examples.map((h) => `@${h}`).join(', ')}.`,
      });
      setAdded((prev) => ({ ...prev, [narrative.term]: 'done' }));
    } catch (error) {
      setAdded((prev) => ({
        ...prev,
        [narrative.term]: error instanceof Error ? error.message : 'That could not be saved.',
      }));
    }
  };

  const narratives = reading.data?.narratives ?? [];

  return (
    <Panel
      title="What is being said"
      lede={
        reading.data
          ? `From ${reading.data.considered} posts this account has seen.`
          : 'From what this account has seen.'
      }
    >
      {reading.loading && <Spinner />}

      {!reading.loading && reading.data?.ok === false && (
        <NoAccount agentId={agentId} what="This agent has seen nothing, because it is not reading anything." />
      )}

      {!reading.loading && reading.data?.ok !== false && narratives.length === 0 && (
        <EmptyState
          title="Nothing is rising"
          detail="A subject appears here once several different accounts have used it. One account repeating itself is not a narrative, and neither is a quiet morning."
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {narratives.map((narrative) => {
          const state = added[narrative.term];
          return (
            <Card
              key={narrative.term}
              title={narrative.term}
              score={`${Math.round(narrative.share * 100)}%`}
              meta={narrative.detail}
              action={
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn-ghost text-[12px]"
                    disabled={state === 'saving' || state === 'done'}
                    onClick={() => addIdea(narrative)}
                  >
                    {state === 'done' ? 'In the backlog' : state === 'saving' ? 'Saving' : 'Add as an idea'}
                  </button>
                  {state && state !== 'saving' && state !== 'done' && (
                    <span className="text-[12px] text-signal-fail">{state}</span>
                  )}
                </div>
              }
            >
              <p className="text-[12px] text-bone-faint">
                {narrative.authors} account{narrative.authors === 1 ? '' : 's'}
                {narrative.examples.length > 0 && `, including ${narrative.examples.map((h) => `@${h}`).join(', ')}`}
              </p>
            </Card>
          );
        })}
      </div>

      <Gaps items={reading.data?.gaps ?? []} label="What this cannot tell you" />
    </Panel>
  );
}
