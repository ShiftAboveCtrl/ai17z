import { useEffect, useState } from 'react';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import { del, post } from '@app/lib/api';
import { EmptyState, RetryablePanel, Spinner, Working } from '@app/components/ui';
import { Card, Gaps, NoAccount, Panel, Reasons } from './shared';
import { PersonPanel } from './PersonPanel';

/**
 * Who this agent talks to, who they are, and who leads somewhere new.
 *
 * Three claims of different kinds sit on this screen, and the ranking is only
 * one of them. The bridge score is about where the agent's own attention might
 * go next -- not a ranking of people, and nothing in the reply path reads it.
 * Whether to answer somebody is decided by what they said.
 *
 * ### Reading somebody is an action, not a render
 *
 * What their account actually says comes from the canonical X intelligence
 * layer, and it is asked for rather than fetched on sight. A card that read X
 * when it appeared would cost one browser request per person on the screen,
 * against the signed-in session the agent needs for its actual work. So the
 * list shows what has already been read, and an owner asks for the rest.
 *
 * The request is recorded and executed by the worker, which is the only process
 * with a browser. It is a read: there is no follow, like, reply or message
 * anywhere in the layer it ends up in, and no setting that adds one.
 */

interface BridgeScore {
  handle: string;
  value: number;
  band: string;
  factors: { name: string; detail: string; points: number }[];
  gaps: string[];
  blocked: boolean;
}

interface PersonRow {
  handle: string;
  bridge: BridgeScore;
  relationship: {
    displayName: string | null;
    userId: string | null;
    familiarity: string;
    disposition: string;
    inboundCount: number;
    outboundCount: number;
    lastInteractionAt: string | null;
    ownerNote: string;
  } | null;
  observed: {
    handle: string;
    userId: string | null;
    displayName: string | null;
    followers: number | null;
    outcome: string;
    detail: string;
    observedAt: string;
    sampleSize: number;
    confident: boolean;
    topics: { term: string; count: number }[];
  } | null;
}

const BANDS: Record<string, string> = {
  STRONG: 'Leads somewhere new',
  WORTH_KNOWING: 'Worth knowing',
  WEAK: 'Little reach beyond here',
  NONE: 'Nothing measured either way',
};

/**
 * How long a read is followed before the screen stops waiting on it.
 *
 * A browser task waits for a lease on the account, and the account may be
 * mid-poll, so a read can sit queued for a while before it starts. Past this
 * the screen says so rather than spinning at something that may already have
 * stopped -- the row is written whatever happens, including for a refusal, so
 * there is always something to come back to.
 */
const FOLLOW_FOR_SECONDS = 150;

function summaryLine(person: PersonRow): string {
  const parts: string[] = [];
  const observed = person.observed;
  if (observed?.outcome === 'OK') {
    if (typeof observed.followers === 'number') parts.push(`${observed.followers.toLocaleString()} followers`);
    if (observed.topics.length > 0) parts.push(`writes about ${observed.topics.slice(0, 3).map((t) => t.term).join(', ')}`);
  } else if (observed) {
    parts.push(observed.detail);
  }
  const relationship = person.relationship;
  if (relationship) {
    parts.push(
      `${relationship.inboundCount} from them, ${relationship.outboundCount} from the agent`,
    );
  }
  return parts.join(' · ');
}

export function RelationshipsView({ agentId }: { agentId: string }) {
  const view = useResource<{ ok?: boolean; reason?: string; items: PersonRow[] }>(`/api/agents/${agentId}/people`);
  const [open, setOpen] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ handle: string; detail: string } | null>(null);
  const [lookup, setLookup] = useState('');
  const elapsed = useElapsed(reading !== null);

  const items = view.data?.items ?? [];

  /*
    A read happens in the worker, so the only honest way to know it finished is
    to look. Polling the list rather than the task: the row being there is the
    thing somebody is waiting for, and a completed task whose row had not been
    written yet would say "done" a moment early.
  */
  usePolling(() => view.reload(), 3_000, reading !== null);

  /*
    Stop waiting when the row appears, or when waiting has stopped being
    honest. In an effect rather than during the render that notices it: setting
    state while rendering is a re-render inside a render, and the version of
    this that did it worked by accident.

    Both exits matter. The row is written whatever the read found -- including
    for a refusal, which is why a protected account is an answer here rather
    than a spinner that never stops.
  */
  const readLanded = reading
    ? items.some((item) => item.handle.toLowerCase() === reading.toLowerCase() && item.observed !== null)
    : false;

  useEffect(() => {
    if (!reading) return;
    if (readLanded) {
      setReading(null);
      return;
    }
    if (elapsed > FOLLOW_FOR_SECONDS) {
      setFailed({
        handle: reading,
        detail:
          'This is taking longer than expected. The browser may be busy with the agent’s own work, or it may need signing in. What was found is recorded either way, so it is worth looking again in a minute.',
      });
      setReading(null);
    }
  }, [reading, readLanded, elapsed]);

  const read = async (handle: string, refresh: boolean) => {
    setFailed(null);
    setReading(handle);
    try {
      await post(`/api/agents/${agentId}/people/${encodeURIComponent(handle)}/read`, { refresh });
    } catch (error) {
      setReading(null);
      setFailed({ handle, detail: error instanceof Error ? error.message : 'That could not be started.' });
    }
  };

  /**
   * Forget that somebody was looked up.
   *
   * A record of who an owner has been curious about is theirs to delete, and a
   * route nothing in the interface reaches is how "@handle is signed out" got
   * raised eleven thousand times against a `DELETE /api/accounts/:id` that had
   * existed all along. Nothing else goes with it: the relationship is what
   * passed between the agent and them, which is a different record.
   */
  const forget = async (handle: string) => {
    setFailed(null);
    try {
      await del(`/api/agents/${agentId}/people/${encodeURIComponent(handle)}`);
      view.reload();
    } catch (error) {
      setFailed({ handle, detail: error instanceof Error ? error.message : 'That could not be forgotten.' });
    }
  };

  const lookSomebodyUp = async (event: React.FormEvent) => {
    event.preventDefault();
    const handle = lookup.trim().replace(/^@+/, '');
    if (!handle) return;
    setLookup('');
    setOpen(handle);
    await read(handle, true);
  };

  return (
    <Panel
      title="Who this agent knows"
      lede="Ranked by how much of an audience sits behind them that this agent does not already reach. It is about where its attention goes next, not about anybody's worth. Reading somebody's account asks X for their profile and recent posts, and nothing else."
    >
      {view.loading && <Spinner />}

      {!view.loading && view.data?.ok === false && (
        <NoAccount agentId={agentId} what="This agent has spoken to nobody, because it is not connected anywhere." />
      )}

      {!view.loading && view.data?.ok !== false && (
        <form className="mb-4 flex flex-wrap items-center gap-2" onSubmit={lookSomebodyUp}>
          <label className="text-[12px] text-bone-faint" htmlFor="people-lookup">
            Look somebody up
          </label>
          <input
            id="people-lookup"
            className="field w-48 text-[13px]"
            placeholder="@handle"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="btn-ghost text-[12px]" disabled={reading !== null || lookup.trim() === ''}>
            Read their account
          </button>
        </form>
      )}

      {reading && (
        <div className="mb-4">
          <Working
            label={`Reading @${reading} on X`}
            seconds={elapsed}
            slowAfter={20}
            slowHint="Still going. The read waits its turn behind whatever else the browser is doing for this account."
          />
        </div>
      )}

      {failed && (
        <div className="mb-4">
          <RetryablePanel
            title={`Reading @${failed.handle} did not finish`}
            detail={failed.detail}
            onRetry={() => void read(failed.handle, true)}
          />
        </div>
      )}

      {!view.loading && view.data?.ok !== false && items.length === 0 && (
        <EmptyState
          title="Nobody to weigh up yet"
          detail="This fills in as the agent has conversations. Somebody it has never spoken to and never seen mentioned is not somebody it can say anything about — but you can still look anybody up above."
        />
      )}

      <div className="space-y-3">
        {items.map((person) => {
          const expanded = open?.toLowerCase() === person.handle.toLowerCase();
          return (
            <Card
              key={person.handle}
              title={
                <button
                  type="button"
                  className="text-left hover:text-bone-dim"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : person.handle)}
                >
                  @{person.handle}
                  {person.observed?.displayName ? ` · ${person.observed.displayName}` : ''}
                </button>
              }
              score={person.bridge.blocked ? 'blocked' : `${person.bridge.value}`}
              meta={
                person.bridge.blocked
                  ? 'You asked this agent not to engage with them.'
                  : [BANDS[person.bridge.band], summaryLine(person)].filter(Boolean).join(' · ')
              }
              action={
                <div className="flex flex-wrap gap-4">
                  <button
                    type="button"
                    className="btn-quiet px-0 text-[12px]"
                    disabled={reading !== null}
                    onClick={() => void read(person.handle, Boolean(person.observed))}
                  >
                    {person.observed ? 'Read their account again' : 'Read their account'}
                  </button>
                  {person.observed && (
                    <button
                      type="button"
                      className="btn-quiet px-0 text-[12px]"
                      onClick={() => void forget(person.handle)}
                    >
                      Forget what was read
                    </button>
                  )}
                </div>
              }
            >
              {expanded && (
                <>
                  <Reasons items={person.bridge.factors} />
                  <Gaps items={person.bridge.gaps} label="Not measured" />
                  <div className="mt-4">
                    <PersonPanel agentId={agentId} handle={person.handle} />
                  </div>
                </>
              )}
            </Card>
          );
        })}
      </div>
    </Panel>
  );
}
