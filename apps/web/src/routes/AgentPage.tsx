import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronDown, Copy, Pause, Play, Trash2 } from 'lucide-react';
import { ApiError, del, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { AgentDetail } from '@app/lib/types';
import { humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { ErrorPanel, Loading, Modal, Spinner, StatusDot } from '@app/components/ui';
import { FadeIn } from '@app/components/motion';
import { IdentitySection } from './sections/IdentitySection';
import { AccountsSection } from './sections/AccountsSection';
import { IntelligenceSection } from './sections/IntelligenceSection';
import { MemorySection } from './sections/MemorySection';
import { PipelineSection } from './sections/PipelineSection';
import { ToolsSection } from './sections/ToolsSection';
import { PoliciesSection } from './sections/PoliciesSection';
import { ActivitySection } from './sections/ActivitySection';

// Three.js loads only once an agent page is actually open.
const AgentPortrait = lazy(() => import('@app/components/AgentPortrait').then((m) => ({ default: m.AgentPortrait })));

const SECTIONS = [
  ['identity', 'Identity'],
  ['accounts', 'Accounts'],
  ['intelligence', 'Intelligence'],
  ['memory', 'Memory'],
  ['pipeline', 'Pipeline'],
  ['tools', 'Tools'],
  ['policies', 'Policies'],
  ['activity', 'Activity'],
] as const;

export function AgentPage() {
  const { agentId = '' } = useParams();
  const { data, error, loading, reload } = useResource<AgentDetail>(agentId ? `/api/agents/${agentId}` : null);
  const [active, setActive] = useState<string>('identity');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Highlights whichever section currently owns the viewport.
  useEffect(() => {
    if (!data) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: '-18% 0px -72% 0px', threshold: [0, 0.25, 0.6] },
    );
    for (const [id] of SECTIONS) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [data]);

  if (loading && !data) return <Loading label="Loading agent" />;
  if (error) {
    return (
      <main className="mx-auto max-w-page px-6 pt-40 sm:px-10">
        <ErrorPanel
          title="That agent could not be loaded."
          detail={error}
          actions={
            <>
              <button type="button" className="btn-ghost" onClick={reload}>
                Retry
              </button>
              <Link to="/" className="btn-quiet">
                Back to agents
              </Link>
            </>
          }
        />
      </main>
    );
  }
  if (!data) return null;

  const { agent, persona, policy, pipeline, models, accounts, stats, memoryCounts, tools } = data;
  const paused = agent.state === 'PAUSED';
  const channel = accounts[0];

  const togglePause = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await patch(`/api/agents/${agent.id}`, { state: paused ? 'ACTIVE' : 'PAUSED' });
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      const copy = await post<{ id: string }>(`/api/agents/${agent.id}/duplicate`, {});
      window.location.href = `/agents/${copy.id}`;
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'The agent could not be duplicated.');
      setBusy(false);
    }
  };

  const destroy = async () => {
    await del(`/api/agents/${agent.id}`).catch(() => undefined);
    window.location.href = '/';
  };

  return (
    <main className="pb-32">
      <section className="relative mx-auto flex min-h-[86vh] max-w-page flex-col items-center justify-center px-6 pt-32 text-center sm:px-10">
        <FadeIn>
          <Suspense fallback={<AgentGlyph agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} size="xl" />}>
            <div className="h-56 w-56 overflow-hidden rounded-3xl border border-ink-line sm:h-72 sm:w-72">
              <AgentPortrait agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} className="h-full w-full" />
            </div>
          </Suspense>
        </FadeIn>

        <FadeIn delay={0.1}>
          <h1 className="mt-10 text-[15vw] font-light leading-[0.86] tracking-monument text-bone sm:text-[7vw]">
            {agent.name}
          </h1>
        </FadeIn>

        <FadeIn delay={0.2}>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
            <StatusDot state={toneFor(agent.state)} label={humanStatus(agent.state)} />
            {channel && (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">
                {channel.channel} @{channel.handle}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">
              last active {timeAgo(stats.lastActivityAt)}
            </span>
          </div>
        </FadeIn>

        <FadeIn delay={0.3}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
            <button type="button" className="btn-ghost" onClick={() => void togglePause()} disabled={busy}>
              {busy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : paused ? (
                <Play className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Pause className="h-3.5 w-3.5" aria-hidden />
              )}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => void duplicate()} disabled={busy}>
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Duplicate
            </button>
            <button type="button" className="btn-quiet hover:text-signal-fail" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </button>
          </div>
        </FadeIn>

        {actionError && (
          <div className="mt-6 w-full max-w-md">
            <ErrorPanel title="That did not work." detail={actionError} />
          </div>
        )}

        {paused && (
          <p className="mt-8 max-w-md rounded-lg border border-signal-wait/30 bg-signal-wait/[0.06] px-4 py-3 text-sm text-signal-wait">
            This agent is paused. New events are still recorded, but no jobs are created for it.
          </p>
        )}

        <ChevronDown className="mt-16 h-5 w-5 animate-bounce text-bone-faint/60" aria-hidden />
      </section>

      <nav className="sticky top-[3.75rem] z-30 border-y border-ink-line bg-ink/90 backdrop-blur-md sm:top-[3.5rem]">
        <div className="scroll-x mx-auto max-w-page px-6 sm:px-10">
          <ul className="flex gap-6 py-3">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className={`whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${
                    active === id ? 'text-bone' : 'text-bone-faint hover:text-bone-dim'
                  }`}
                  aria-current={active === id ? 'true' : undefined}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="mx-auto max-w-page px-6 sm:px-10">
        <IdentitySection index={1} agentId={agent.id} agentName={agent.name} persona={persona} onSaved={reload} />
        <AccountsSection index={2} agentId={agent.id} accounts={accounts} onChanged={reload} />
        <IntelligenceSection index={3} agentId={agent.id} models={models} onChanged={reload} />
        <MemorySection index={4} agentId={agent.id} counts={memoryCounts} />
        <PipelineSection
          index={5}
          pipeline={pipeline}
          triggerLabel={channel ? `When someone mentions ${agent.name}.` : `When ${agent.name} receives an event.`}
        />
        <ToolsSection
          index={6}
          agentId={agent.id}
          tools={tools}
          allowedKeys={policy?.config.tools.allowed ?? []}
          onChanged={reload}
        />
        <PoliciesSection
          index={7}
          agentId={agent.id}
          policy={policy?.config ?? null}
          version={policy?.version ?? 1}
          onSaved={reload}
        />
        <ActivitySection index={8} agentId={agent.id} />
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${agent.name}?`}>
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-bone-dim">
            This removes the agent, its persona and policy history, its memories, and every job and trace belonging to
            it. Connected accounts survive and can be attached to another agent.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-danger flex-1" onClick={() => void destroy()}>
              Delete permanently
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        </div>
      </Modal>
    </main>
  );
}
