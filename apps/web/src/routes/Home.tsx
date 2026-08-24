import { Link } from 'react-router-dom';
import { ArrowUpRight, Plus } from 'lucide-react';
import { useResource } from '@app/lib/hooks';
import type { AgentListItem } from '@app/lib/types';
import { compactNumber, humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { AnimatedText, FadeIn, MagneticElement } from '@app/components/motion';
import { EmptyState, ErrorPanel, Loading, StatusDot } from '@app/components/ui';

/**
 * The agents are the interface.
 *
 * No statistics wall, no widget grid. One agent per card, given room, with only
 * the facts that tell you whether it is working.
 */
export function Home() {
  const { data, error, loading, reload } = useResource<{ items: AgentListItem[] }>('/api/agents');

  if (loading && !data) return <Loading label="Loading agents" />;
  if (error) {
    return (
      <main className="mx-auto max-w-page px-6 pt-40 sm:px-10">
        <ErrorPanel
          title="Your agents could not be loaded."
          detail={error}
          actions={
            <button type="button" className="btn-ghost" onClick={reload}>
              Retry
            </button>
          }
        />
      </main>
    );
  }

  const agents = data?.items ?? [];
  const [lead, ...rest] = agents;

  return (
    <main className="mx-auto max-w-page px-6 pb-32 pt-32 sm:px-10 sm:pt-44">
      <header className="mb-16 sm:mb-24">
        <FadeIn>
          <p className="eyebrow mb-6">
            {agents.length === 0
              ? 'Nothing running yet'
              : `${agents.length} agent${agents.length === 1 ? '' : 's'}`}
          </p>
        </FadeIn>
        <AnimatedText
          as="h1"
          text="Your agents"
          className="monument text-[16vw] leading-[0.84] sm:text-[10vw] lg:text-[7.5vw]"
        />
      </header>

      {agents.length === 0 ? (
        <FadeIn delay={0.2}>
          <EmptyState
            title="No agents yet."
            detail="An agent is an identity, a memory, a model, and a set of rules about what it may do. Start with one and connect it to nothing at all — the mock channel will let you watch it think."
            action={
              <Link to="/agents/new" className="btn-primary">
                <Plus className="h-4 w-4" aria-hidden />
                Create your first agent
              </Link>
            }
          />
        </FadeIn>
      ) : (
        <>
          {lead && <LeadAgent agent={lead} />}
          {rest.length > 0 && (
            <div className="mt-20 grid gap-5 sm:mt-28 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((agent, index) => (
                <FadeIn key={agent.id} delay={index * 0.06}>
                  <AgentCard agent={agent} />
                </FadeIn>
              ))}
            </div>
          )}
          <FadeIn delay={0.15}>
            <Link
              to="/agents/new"
              className="mt-10 flex items-center justify-center gap-2 rounded-xl border border-dashed border-ink-line px-6 py-10 text-bone-faint transition-colors hover:border-bone-faint hover:text-bone-dim"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="font-mono text-[11px] uppercase tracking-[0.2em]">Create agent</span>
            </Link>
          </FadeIn>
        </>
      )}
    </main>
  );
}

function LeadAgent({ agent }: { agent: AgentListItem }) {
  const channel = agent.accounts[0];
  return (
    <FadeIn>
      <Link
        to={`/agents/${agent.id}`}
        className="group block rounded-3xl border border-ink-line bg-ink-raised/40 p-8 transition-colors duration-500 hover:border-bone-faint/40 sm:p-14"
      >
        <div className="flex flex-col items-center gap-10 text-center sm:gap-12">
          <MagneticElement strength={10}>
            <AgentGlyph agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} size="xl" />
          </MagneticElement>

          <div className="w-full">
            <h2 className="text-4xl font-light tracking-tight text-bone sm:text-6xl">{agent.name}</h2>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              <StatusDot state={toneFor(agent.state)} label={humanStatus(agent.state)} />
              {channel && (
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
                  {channel.channel} @{channel.handle}
                </span>
              )}
            </div>
            {agent.description && (
              <p className="mx-auto mt-6 max-w-xl text-[15px] font-light leading-relaxed text-bone-dim">
                {agent.description}
              </p>
            )}
          </div>

          <dl className="grid w-full max-w-lg grid-cols-3 gap-px overflow-hidden rounded-xl border border-ink-line bg-ink-line">
            <Stat label="Memories" value={compactNumber(agent.stats.memories)} />
            <Stat label="Accounts" value={String(agent.stats.accounts)} />
            <Stat label="Last active" value={timeAgo(agent.stats.lastActivityAt)} />
          </dl>

          <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint transition-colors group-hover:text-bone">
            Open agent <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </div>
      </Link>
    </FadeIn>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink px-3 py-4 sm:px-4 sm:py-5">
      {/* Values like "22m ago" must not wrap into two lines on a phone. */}
      <dd className="truncate text-base font-light text-bone sm:text-xl">{value}</dd>
      <dt className="mt-1 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-bone-faint">{label}</dt>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentListItem }) {
  const channel = agent.accounts[0];
  const attention = agent.stats.jobsNeedingReview > 0;
  return (
    <Link
      to={`/agents/${agent.id}`}
      className="group flex h-full flex-col gap-6 rounded-2xl border border-ink-line bg-ink-raised/30 p-6 transition-colors duration-400 hover:border-bone-faint/40"
    >
      <div className="flex items-start justify-between gap-4">
        <AgentGlyph agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} size="md" />
        <StatusDot state={toneFor(agent.state)} />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-2xl font-light tracking-tight text-bone">{agent.name}</h3>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
          {humanStatus(agent.state)}
          {channel ? ` · ${channel.channel}` : ' · no channel'}
        </p>
      </div>
      <div className="flex items-center justify-between border-t border-ink-line pt-4 text-[11px] text-bone-faint">
        <span className="font-mono">{compactNumber(agent.stats.memories)} memories</span>
        {attention ? (
          <span className="font-mono text-signal-wait">{agent.stats.jobsNeedingReview} need review</span>
        ) : (
          <span className="font-mono">{timeAgo(agent.stats.lastActivityAt)}</span>
        )}
      </div>
    </Link>
  );
}
