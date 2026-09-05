import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Copy, ExternalLink, Package, Pencil, Play, Square, Trash2 } from 'lucide-react';
import { ApiError, del, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { AgentDetail } from '@app/lib/types';
import { humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { ErrorPanel, Field, Loading, Modal, Spinner, StatusDot } from '@app/components/ui';
import { AgentPackagePanel } from '@app/components/AgentPackagePanel';
import { NeedsYou } from '@app/components/NeedsYou';
import { LiveStatus } from '@app/components/LiveStatus';
import { FadeIn } from '@app/components/motion';
import { IdentitySection } from './sections/IdentitySection';
import { AccountsSection } from './sections/AccountsSection';
import { IntelligenceSection } from './sections/IntelligenceSection';
import { MemorySection } from './sections/MemorySection';
import { KnowledgeSection } from './sections/KnowledgeSection';
import { ContentSection } from './sections/ContentSection';
import { LearnedSection } from './sections/LearnedSection';
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

/**
 * Five places, not fifteen sections.
 *
 * Everything an agent has was on one page, in a flat list of fifteen headings
 * with a fifteen-item nav above it. That is a filing cabinet with the drawers
 * removed: every setting equally prominent, nothing grouped by what you came to
 * do, and no way to look at an agent without also looking at its pipeline.
 *
 * So the page has areas now. You land on what the agent is doing, and go
 * somewhere specific when you want to change something. Each area is small
 * enough to read, and named for the question it answers rather than for the
 * subsystem behind it -- "Reach" rather than "Accounts, Intelligence, Tools".
 *
 * Old links still work: `#policies` selects the area holding that section and
 * scrolls to it, so nothing anybody bookmarked or linked breaks.
 */
const AREAS = [
  { id: 'overview', label: 'Overview', blurb: 'How it is doing, and anything that needs you.', sections: ['activity'] },
  { id: 'character', label: 'Character', blurb: 'Who it is, and how it writes.', sections: ['identity', 'voice', 'beliefs'] },
  { id: 'reach', label: 'Reach', blurb: 'Where it speaks, what it thinks with, what it can use.', sections: ['accounts', 'intelligence', 'tools'] },
  { id: 'memory', label: 'Memory', blurb: 'What it knows, and who it knows.', sections: ['memory', 'knowledge', 'relationships', 'learned'] },
  { id: 'behaviour', label: 'Behaviour', blurb: 'What it does on its own, and what it is allowed to do.', sections: ['content', 'behaviour', 'policies', 'pipeline'] },
] as const;

type AreaId = (typeof AREAS)[number]['id'];

/** Which area holds a section, so an old `#anchor` still lands somewhere. */
const AREA_OF_SECTION: Record<string, AreaId> = Object.fromEntries(
  AREAS.flatMap((area) => area.sections.map((section) => [section, area.id])),
) as Record<string, AreaId>;

export function AgentPage() {
  const { agentId = '' } = useParams();
  const { data, error, loading, reload } = useResource<AgentDetail>(agentId ? `/api/agents/${agentId}` : null);
  const [area, setArea] = useState<AreaId>(() => {
    const hash = window.location.hash.replace('#', '');
    return AREA_OF_SECTION[hash] ?? 'overview';
  });
  const [mode] = useViewMode();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [packaging, setPackaging] = useState(false);

  const rename = async () => {
    const name = (renaming ?? '').trim();
    if (!name) {
      setRenameError('An agent needs a name.');
      return;
    }
    setRenameError(null);
    try {
      await patch(`/api/agents/${agentId}`, { name });
      setRenaming(null);
      reload();
    } catch (e) {
      setRenameError(e instanceof ApiError ? e.message : 'That name could not be saved.');
    }
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<{ what: string; fix: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Highlights whichever section currently owns the viewport.
  // An old link like `#policies` names a section, not an area. Select the area
  // that holds it, then let the browser scroll to it once it has rendered.
  useEffect(() => {
    const jump = () => {
      const id = window.location.hash.replace('#', '');
      const next = AREA_OF_SECTION[id];
      if (!next) return;
      setArea(next);
      window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 60);
    };
    window.addEventListener('hashchange', jump);
    return () => window.removeEventListener('hashchange', jump);
  }, []);

  // The same thing on a cold load. Opening a bookmarked `#policies` directly
  // means the browser tries to scroll to an element React has not rendered yet,
  // finds nothing, and leaves you at the top of an area you did not ask for.
  useEffect(() => {
    if (!data) return;
    const id = window.location.hash.replace('#', '');
    if (!id || !AREA_OF_SECTION[id]) return;
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 120);
    return () => window.clearTimeout(timer);
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
          mode === 'easy' ? 'pb-10 pt-28 sm:pt-32' : 'pb-10 pt-28 sm:pt-32'
        }`}
      >
        <FadeIn>
          <Suspense fallback={<AgentGlyph agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl} size="xl" />}>
            <div
              className={`overflow-hidden rounded-3xl border border-ink-line ${
                mode === 'easy' ? 'h-28 w-28 sm:h-32 sm:w-32' : 'h-32 w-32 sm:h-40 sm:w-40'
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
                : 'mt-5 text-[11vw] leading-[1] sm:text-[3.8vw]'
            }`}
          >
            {agent.name}
          </h1>
        </FadeIn>

        <FadeIn delay={0.2}>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <LiveStatus agentId={agent.id} fallback={{ tone: toneFor(agent.state), label: humanStatus(agent.state) }} />
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
            {/*
              Renaming is a display change and stays one: the agent id is the
              identity, accounts hang off it, and a browser profile is derived
              from the account rather than from any name. Not an advanced
              operation, so it is here in both views.
            */}
            <button type="button" className="btn-quiet" onClick={() => setRenaming(data.agent.name)} disabled={busy}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Rename
            </button>
            {mode === 'advanced' && (
              <button type="button" className="btn-quiet" onClick={() => void duplicate()} disabled={busy}>
                <Copy className="h-3.5 w-3.5" aria-hidden />
                Duplicate
              </button>
            )}
            {/*
              Offered in both views. Moving an agent to a new machine is not an
              advanced operation, and neither is being handed one -- an agent
              made in Easy Mode is exactly the kind somebody wants to send.
            */}
            <button type="button" className="btn-quiet" onClick={() => setPackaging(true)}>
              <Package className="h-3.5 w-3.5" aria-hidden />
              Export
            </button>
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

      </section>

      <Modal open={packaging} onClose={() => setPackaging(false)} title="Move this agent" wide>
        <AgentPackagePanel agentId={agent.id} onImported={() => setPackaging(false)} />
      </Modal>

      <Modal open={renaming !== null} onClose={() => setRenaming(null)} title="Rename this agent">
        <div className="space-y-5">
          <Field
            label="Name"
            htmlFor="agent-name"
            hint="What you call it. Not what it calls itself to other people, which is the display name on its identity."
          >
            <input
              id="agent-name"
              className="field"
              value={renaming ?? ''}
              maxLength={120}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
              }}
            />
          </Field>
          <p className="text-[12px] text-bone-faint">
            {(renaming ?? '').length} / 120. Nothing else changes: its history, accounts and memory all belong to the
            agent rather than to its name.
          </p>
          {renameError && <p className="text-sm text-signal-fail">{renameError}</p>}
          <div className="flex items-center gap-3">
            <button type="button" className="btn-primary" onClick={() => void rename()} disabled={!(renaming ?? '').trim()}>
              Save
            </button>
            <button type="button" className="btn-ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      {mode === 'easy' && (
        <div className="mx-auto max-w-3xl px-6 pb-8 sm:px-10">
          <EasyAgentView agent={data} onChanged={reload} />
        </div>
      )}

      {mode === 'advanced' && (
      <>
      <nav className="sticky top-[3.75rem] z-30 border-y border-ink-line bg-ink/90 backdrop-blur-md sm:top-[3.5rem]">
        <div className="scroll-x mx-auto max-w-page px-6 sm:px-10">
          <ul className="flex gap-0.5 py-2 sm:gap-1">
            {AREAS.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    setArea(entry.id);
                    // Back to the top of the area rather than wherever the last
                    // one left the page. Landing halfway down a screen you have
                    // never seen is disorienting.
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  aria-current={area === entry.id ? 'page' : undefined}
                  // Sized so all five fit a 375px phone without a scroller.
                  // A tab you have to swipe sideways to discover is a tab most
                  // people never find.
                  className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] transition-colors sm:px-3 sm:text-[13px] ${
                    area === entry.id
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
        {/* What this area is for, in the words somebody would use to ask. */}
        <p className="pt-6 text-[13px] text-bone-faint">{AREAS.find((a) => a.id === area)?.blurb}</p>

        {area === 'overview' && (
          <>
            <NeedsYou
              agent={agent}
              accounts={accounts}
              models={models}
              stats={stats}
              onGo={(next) => {
                setArea(next as AreaId);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
            <ActivitySection index={1} agentId={agent.id} />
          </>
        )}

        {area === 'character' && (
          <>
            <IdentitySection
              index={1}
              agentId={agent.id}
              agentName={agent.name}
              avatarUrl={agent.avatarUrl}
              persona={persona}
              onSaved={reload}
            />
            <VoiceSection index={2} agentId={agent.id} />
            <BeliefsSection index={3} agentId={agent.id} />
          </>
        )}

        {area === 'reach' && (
          <>
            <AccountsSection index={1} agentId={agent.id} accounts={accounts} onChanged={reload} />
            <IntelligenceSection index={2} agentId={agent.id} models={models} onChanged={reload} />
            <ToolsSection
              index={3}
              agentId={agent.id}
              tools={tools}
              allowedKeys={policy?.config.tools.allowed ?? []}
              policy={policy?.config ?? null}
              onChanged={reload}
            />
          </>
        )}

        {area === 'memory' && (
          <>
            <MemorySection index={1} agentId={agent.id} counts={memoryCounts} />
            <KnowledgeSection index={2} agentId={agent.id} />
            <RelationshipsSection index={3} agentId={agent.id} />
            <LearnedSection index={4} agentId={agent.id} />
          </>
        )}

        {area === 'behaviour' && (
          <>
            <ContentSection index={1} agentId={agent.id} />
            <BehaviourSection index={2} agentId={agent.id} />
            <PoliciesSection
              index={3}
              agentId={agent.id}
              policy={policy?.config ?? null}
              version={policy?.version ?? 1}
              onSaved={reload}
            />
            <PipelineSection
              index={4}
              pipeline={pipeline}
              triggerLabel={channel ? `When someone mentions ${agent.name}.` : `When ${agent.name} receives an event.`}
            />
          </>
        )}
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
