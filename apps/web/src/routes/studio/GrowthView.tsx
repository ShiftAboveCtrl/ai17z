import { useState } from 'react';
import { useResource } from '@app/lib/hooks';
import { EmptyState, Spinner } from '@app/components/ui';
import { Card, NoAccount, Panel, Reasons } from './shared';

/**
 * Which conversations might be worth starting, and the ones that were not.
 *
 * The declines are the larger half of this screen and that is deliberate. An
 * empty Opportunities list reads as a broken feature; the same list with forty
 * declines and a sentence each reads as an answer, and it is the honest one --
 * an agent that finds an opportunity in every post is an agent that replies to
 * strangers about subjects it knows nothing about.
 *
 * Nothing here can send anything. A post that looks worth answering opens on X
 * so a person decides, because the alternative is a button that publishes under
 * somebody's own name from a screen designed for browsing.
 */

interface Opportunity {
  statusId: string;
  handle: string;
  value: number;
  reasons: { name: string; detail: string; points: number }[];
}

interface Declined {
  statusId: string;
  handle: string;
  reason: string;
  detail: string;
}

interface Verdict {
  ok?: boolean;
  reason?: string;
  opportunities: Opportunity[];
  declined: Declined[];
  topics?: string[];
}

/**
 * In the order somebody would want to understand them.
 *
 * Every reason the engine can actually give, and nothing else. Crowding is not
 * here because it is not a decline: a busy thread under somebody the agent has
 * a real relationship with is still worth answering, so it is a cost the other
 * factors can outweigh rather than a door closing.
 */
const DECLINE_ORDER = ['off_topic', 'too_old', 'already_engaged', 'nothing_said', 'age_unknown', 'own_post', 'blocked'];

const DECLINE_WORDS: Record<string, string> = {
  off_topic: 'Nothing it has anything to say about',
  too_old: 'The conversation has moved on',
  already_engaged: 'It has just spoken to them',
  nothing_said: 'Too short to answer',
  age_unknown: 'No timestamp, so possibly days old',
  own_post: 'Its own posts',
  blocked: 'You asked it not to',
};

export function GrowthView({ agentId }: { agentId: string }) {
  const view = useResource<Verdict>(`/api/agents/${agentId}/growth/opportunities`);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const opportunities = view.data?.opportunities ?? [];
  const declined = view.data?.declined ?? [];
  const grouped = new Map<string, Declined[]>();
  for (const item of declined) {
    grouped.set(item.reason, [...(grouped.get(item.reason) ?? []), item]);
  }
  const groups = [...grouped.entries()].sort(
    (a, b) => DECLINE_ORDER.indexOf(a[0]) - DECLINE_ORDER.indexOf(b[0]),
  );

  return (
    <>
      <Panel
        title="Worth speaking into"
        lede={
          view.data?.topics?.length
            ? `Judged against what this agent talks about: ${view.data.topics.join(', ')}.`
            : 'Judged against what this agent talks about.'
        }
      >
        {view.loading && <Spinner />}

        {!view.loading && view.data?.ok === false && (
          <NoAccount agentId={agentId} what="This agent is not reading anything, so there is nothing to weigh up." />
        )}

        {!view.loading && view.data?.ok !== false && opportunities.length === 0 && (
          <EmptyState
            title="Nothing worth answering right now"
            detail={
              view.data?.topics?.length
                ? `${declined.length} post${declined.length === 1 ? '' : 's'} looked at. The reasons are below.`
                : 'This agent has no subjects set, so it declines everything. Add topics under Character and it will start finding things.'
            }
          />
        )}

        <div className="space-y-3">
          {opportunities.map((opportunity) => (
            <Card
              key={opportunity.statusId}
              title={`@${opportunity.handle}`}
              score={`${opportunity.value}`}
              action={
                <a
                  className="btn-ghost text-[12px]"
                  href={`https://x.com/i/web/status/${opportunity.statusId}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open on X
                </a>
              }
            >
              <Reasons items={opportunity.reasons} />
            </Card>
          ))}
        </div>
      </Panel>

      {groups.length > 0 && (
        <Panel
          title="What it passed over"
          lede="Every post it looked at and left alone, with the reason. This is most of the work."
        >
          <div className="space-y-2">
            {groups.map(([reason, items]) => (
              <div key={reason} className="rounded-xl border border-ink-line">
                <button
                  type="button"
                  className="flex w-full items-baseline gap-4 px-4 py-3 text-left"
                  aria-expanded={openGroup === reason}
                  onClick={() => setOpenGroup(openGroup === reason ? null : reason)}
                >
                  <span className="font-mono text-[12px] text-bone-dim">{items.length}</span>
                  <span className="text-[13px] text-bone-dim">{DECLINE_WORDS[reason] ?? reason}</span>
                  <span className="ml-auto font-mono text-[11px] text-bone-faint">
                    {openGroup === reason ? 'hide' : 'show'}
                  </span>
                </button>
                {openGroup === reason && (
                  <ul className="space-y-2 border-t border-ink-line px-4 py-3">
                    {items.slice(0, 25).map((item) => (
                      <li key={item.statusId} className="break-words text-[12px] leading-relaxed text-bone-faint">
                        <span className="text-bone-dim">@{item.handle}</span> — {item.detail}
                      </li>
                    ))}
                    {items.length > 25 && (
                      <li className="text-[12px] text-bone-faint">
                        and {items.length - 25} more for the same reason.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
