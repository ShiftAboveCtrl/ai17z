import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useResource } from '@app/lib/hooks';
import { ErrorPanel, Loading } from '@app/components/ui';
import { Crash } from '@app/components/Crash';
import { CommandView } from './studio/CommandView';
import { CreateView } from './studio/CreateView';
import { RadarView } from './studio/RadarView';
import { RelationshipsView } from './studio/RelationshipsView';
import { GrowthView } from './studio/GrowthView';
import { AnalyticsView } from './studio/AnalyticsView';
import { LaunchView } from './studio/LaunchView';
import { ExperimentsView } from './studio/ExperimentsView';

/**
 * X Studio: what the agent has seen and what it did, rather than how it is set up.
 *
 * A page of its own rather than a seventh tab on the agent screen, and that is
 * a deliberate line rather than a routing convenience. The agent page is where
 * somebody decides what their agent *is* -- its persona, its policies, what it
 * may reach for. This is where they look at what came of it. Mixing the two
 * puts a setting nobody should change casually next to a chart somebody refreshes
 * every hour.
 *
 * It also keeps the agent page's five tabs at five. They are sized to fit a
 * 375px phone without a sideways scroller, and a tab you have to swipe to
 * discover is a tab most people never find.
 *
 * Nothing on this page publishes anything. Every route behind it is a GET
 * except adding to the idea backlog, which is the same backlog the posting
 * engine already reads and still decides about.
 */

const VIEWS = [
  { id: 'command', label: 'Command', blurb: 'What the agent has seen, and what came of it.' },
  { id: 'growth', label: 'Growth', blurb: 'What might be worth answering, and what was passed over.' },
  { id: 'radar', label: 'Radar', blurb: 'What a lot of accounts have started saying.' },
  { id: 'relationships', label: 'People', blurb: 'Who leads somewhere this agent does not already reach.' },
  { id: 'analytics', label: 'Analytics', blurb: 'What has worked, from the posts that were measured.' },
  { id: 'launch', label: 'Launches', blurb: 'Tickers and addresses, with nothing added to them.' },
  { id: 'create', label: 'Create', blurb: 'What it has to say, before it says it.' },
  { id: 'experiments', label: 'Experiments', blurb: 'One question at a time, answered slowly or not at all.' },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

interface AgentDetail {
  agent: { id: string; name: string };
}

export function StudioPage() {
  const { agentId = '' } = useParams();
  const { data, error, loading } = useResource<AgentDetail>(agentId ? `/api/agents/${agentId}` : null);
  const [view, setView] = useState<ViewId>('command');

  if (loading) return <Loading label="Opening Studio" />;
  if (error || !data) {
    return (
      <main className="mx-auto max-w-page px-6 py-16 sm:px-10">
        <ErrorPanel title="That agent could not be opened." detail={error ?? 'It may have been deleted.'} />
      </main>
    );
  }

  const current = VIEWS.find((entry) => entry.id === view)!;

  return (
    <main className="pb-24">
      {/* Clear of the fixed top bar, at the same offset every other page uses. */}
      <header className="mx-auto max-w-page px-6 pt-24 sm:px-10 sm:pt-28">
        <p className="eyebrow">X Studio</p>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-3xl font-light tracking-tight text-bone sm:text-4xl">{data.agent.name}</h1>
          <Link className="btn-ghost text-[12px]" to={`/agents/${agentId}`}>
            Settings
          </Link>
        </div>
      </header>

      <nav aria-label="Studio" className="sticky top-[3.75rem] z-30 mt-6 border-y border-ink-line bg-ink/90 backdrop-blur-md sm:top-[3.5rem]">
        <div className="mx-auto max-w-page px-4 sm:px-8">
          {/*
            Eight of these do not fit a phone side by side, so this one
            scrolls. The agent page's five are sized not to; the difference is
            that these are places to look rather than places to change
            something, and missing one costs nothing.
          */}
          <ul className="-mx-1 flex gap-1 overflow-x-auto py-2">
            {VIEWS.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    setView(entry.id);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  aria-current={view === entry.id ? 'page' : undefined}
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors ${
                    view === entry.id
                      ? 'bg-white/[0.06] text-bone'
                      : 'text-bone-faint hover:bg-white/[0.03] hover:text-bone-dim'
                  }`}
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="mx-auto max-w-page px-6 sm:px-10">
        <p className="pt-6 text-[13px] text-bone-faint">{current.blurb}</p>

        {/*
          A view that throws leaves the navigation standing. These read six
          different endpoints and one of them failing should not take the other
          five with it.
        */}
        <Crash area="view">
          <div className="mt-6">
            {view === 'command' && <CommandView agentId={agentId} onGo={(next) => setView(next as ViewId)} />}
            {view === 'growth' && <GrowthView agentId={agentId} />}
            {view === 'radar' && <RadarView agentId={agentId} />}
            {view === 'relationships' && <RelationshipsView agentId={agentId} />}
            {view === 'analytics' && <AnalyticsView agentId={agentId} />}
            {view === 'launch' && <LaunchView agentId={agentId} />}
            {view === 'create' && <CreateView agentId={agentId} />}
            {view === 'experiments' && <ExperimentsView agentId={agentId} />}
          </div>
        </Crash>
      </div>
    </main>
  );
}
