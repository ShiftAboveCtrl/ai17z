import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronDown, Copy, ExternalLink, Play, Square, Trash2 } from 'lucide-react';
import { ApiError, del, post } from '@app/lib/api';
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
import { KnowledgeSection } from './sections/KnowledgeSection';
import { RelationshipsSection } from './sections/RelationshipsSection';
import { BeliefsSection } from './sections/BeliefsSection';
import { VoiceSection } from './sections/VoiceSection';
import { BehaviourSection } from './sections/BehaviourSection';
import { PipelineSection } from './sections/PipelineSection';
import { ToolsSection } from './sections/ToolsSection';
import { PoliciesSection } from './sections/PoliciesSection';
import { ActivitySection } from './sections/ActivitySection';
import { useViewMode } from '@app/lib/viewMode';
import { EasyAgentView } from './EasyAgentView';

// Three.js loads only once an agent page is actually open.
const AgentPortrait = lazy(() => import('@app/components/AgentPortrait').then((m) => ({ default: m.AgentPortrait })));

const SECTIONS = [
  ['identity', 'Identity'],
  ['voice', 'Voice'],
  ['accounts', 'Accounts'],
  ['intelligence', 'Intelligence'],
  ['relationships', 'Relationships'],
  ['beliefs', 'Beliefs'],
  ['memory', 'Memory'],
  ['knowledge', 'Knowledge'],
  ['pipeline', 'Pipeline'],
  ['tools', 'Tools'],
  ['policies', 'Policies'],
  ['behaviour', 'Behaviour'],
  ['activity', 'Activity'],
] as const;

export function AgentPage() {
  const { agentId = '' } = useParams();
  const { data, error, loading, reload } = useResource<AgentDetail>(agentId ? `/api/agents/${agentId}` : null);
  const [active, setActive] = useState<string>('identity');
  const [mode] = useViewMode();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<{ what: string; fix: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Highlights whichever section currently owns the viewport.
  useEffect(() => {
    if (!data || mode !== 'advanced') return;
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
  }, [data, mode]);

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
  const running = agent.state === 'ACTIVE';
  const channel = accounts[0];

  /**
   * Stop means stop: the state changes and the browser closes with it.
   *
   * Start runs the preflight first, so an agent that cannot work says why
   * instead of going ACTIVE and failing on its first job.
   */
  const toggleRunning = async () => {
    setBusy(true);
    setActionError(null);
    setBlockers([]);
    try {
      if (running) {
        const result = await post<{ closing: { handle: string; detail: string }[] }>(`/api/agents/${agent.id}/stop`, {});
        setNotice(
          result.closing.length > 0
            ? `Stopped. ${result.closing.map((c) => `@${c.handle}: ${c.detail}`).join(' ')}`
            : 'Stopped.',
        );
      } else {
        const result = await post<{ started: boolean; blockers: { what: string; fix: string }[] }>(
          `/api/agents/${agent.id}/start`,
          {},
        );
        if (!result.started) setBlockers(result.blockers);
        else setNotice('Running. It opens a browser when it next has something to read.');
      }
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

  /**
   * Removes the agent, and says so if it did not.
   *
   * This used to swallow the error and navigate home regardless, so a delete
   * that failed for any reason looked exactly like one that worked -- until the
   * agent turned up again in the list. Sending somebody to a page that
   * contradicts what just happened is worse than telling them it did not work.
   */
  const destroy = async () => {
    setBusy(true);
    try {
      await del(`/api/agents/${agent.id}`);
      window.location.href = '/';
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'The agent could not be deleted.');
      setConfirmDelete(false);
      setBusy(false);
    }
  };

  return (
    <main className="pb-32">
      {/*
        Advanced keeps the full-height opening: it is a page you scroll through.
        Easy is a page you read, so the hero shrinks to a header and the four
        things somebody actually came for are on screen without scrolling.
      */}
      <section
        className={`relative mx-auto flex max-w-page flex-col items-center px-6 text-center sm:px-10 ${
          mode === 'easy' ? 'pb-10 pt-28 sm:pt-32' : 'min-h-[86vh] justify-center pt-32'
        }`}
      >
        <FadeIn>
          <Suspense fallback={<AgentGlyph agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} size="xl" />}>
            <div
              className={`overflow-hidden rounded-3xl border border-ink-line ${
                mode === 'easy' ? 'h-28 w-28 sm:h-32 sm:w-32' : 'h-56 w-56 sm:h-72 sm:w-72'
              }`}
            >
              <AgentPortrait agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} className="h-full w-full" />
            </div>
          </Suspense>
        </FadeIn>

        <FadeIn delay={0.1}>
          <h1
            className={`font-display font-light tracking-monument text-bone ${
              mode === 'easy'
                ? 'mt-5 text-[10vw] leading-[1] sm:text-[3.4vw]'
                : 'mt-10 text-[15vw] leading-[0.86] sm:text-[7vw]'
            }`}
          >
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
          <div className={`flex flex-wrap items-center justify-center gap-2 ${mode === 'easy' ? 'mt-6' : 'mt-10'}`}>
            <button
              type="button"
              className={running ? 'btn-ghost' : 'btn-primary'}
              onClick={() => void toggleRunning()}
              disabled={busy}
            >
              {busy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : running ? (
                <Square className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              {running ? 'Stop' : 'Start'}
            </button>
            {channel?.channel === 'x' && channel.handle && (
              <a
                className="btn-quiet"
                href={`https://x.com/${channel.handle}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Open X
              </a>
            )}
            <Link className="btn-quiet" to="/activity">
              Activity
            </Link>
            {mode === 'advanced' && (
              <button type="button" className="btn-quiet" onClick={() => void duplicate()} disabled={busy}>
                <Copy className="h-3.5 w-3.5" aria-hidden />
                Duplicate
              </button>
            )}
            {/*
              Delete is not an advanced operation.
              
              It sat behind the Advanced switch with Duplicate, which meant an
              agent created in Easy Mode -- the way most of them are created,
              and the way half-finished drafts pile up -- could not be removed
              from any screen at all. Making one is offered in Easy; removing
              one has to be too.
            */}
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

        {blockers.length > 0 && (
          <div className="mt-6 w-full max-w-md space-y-2 rounded-lg border border-signal-wait/40 bg-signal-wait/[0.06] p-4 text-left">
            <p className="text-sm text-bone">It cannot start yet:</p>
            <ul className="space-y-1.5">
              {blockers.map((blocker) => (
                <li key={blocker.what} className="text-[13px] leading-relaxed text-bone-dim">
                  {blocker.what} <span className="text-bone-faint">{blocker.fix}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {notice && (
          <p className="mt-6 max-w-md break-words rounded-lg border border-ink-line px-4 py-3 text-[13px] leading-relaxed text-bone-dim">
            {notice}
          </p>
        )}

        {!running && blockers.length === 0 && !notice && (
          <p className="mt-8 max-w-md rounded-lg border border-signal-wait/30 bg-signal-wait/[0.06] px-4 py-3 text-sm text-signal-wait">
            This agent is stopped. Nothing is read and no browser is open for it.
          </p>
        )}

        {mode === 'advanced' && <ChevronDown className="mt-16 h-5 w-5 animate-bounce text-bone-faint/60" aria-hidden />}
      </section>

      {mode === 'easy' && (
        <div className="mx-auto max-w-3xl px-6 pb-8 sm:px-10">
          <EasyAgentView agent={data} onChanged={reload} />
        </div>
      )}

      {mode === 'advanced' && (
      <>
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
        <VoiceSection index={2} agentId={agent.id} />
        <AccountsSection index={3} agentId={agent.id} accounts={accounts} onChanged={reload} />
        <IntelligenceSection index={4} agentId={agent.id} models={models} onChanged={reload} />
        <RelationshipsSection index={5} agentId={agent.id} />
        <BeliefsSection index={6} agentId={agent.id} />
        <MemorySection index={7} agentId={agent.id} counts={memoryCounts} />
        <KnowledgeSection index={8} agentId={agent.id} />
        <PipelineSection
          index={9}
          pipeline={pipeline}
          triggerLabel={channel ? `When someone mentions ${agent.name}.` : `When ${agent.name} receives an event.`}
        />
        <ToolsSection
          index={10}
          agentId={agent.id}
          tools={tools}
          allowedKeys={policy?.config.tools.allowed ?? []}
          onChanged={reload}
        />
        <PoliciesSection
          index={11}
          agentId={agent.id}
          policy={policy?.config ?? null}
          version={policy?.version ?? 1}
          onSaved={reload}
        />
        <BehaviourSection index={12} agentId={agent.id} />
        <ActivitySection index={13} agentId={agent.id} />
      </div>
      </>
      )}

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
