import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { usePolling, useResource } from '@app/lib/hooks';
import type { AgentListItem } from '@app/lib/types';
import { EmptyState, RetryablePanel, Tabs, Working } from '@app/components/ui';
import { Explain } from '@app/components/Explain';
import { AnimatedText } from '@app/components/motion';
import type { DevUpdate, DevUpdateConnection, DevUpdateProject, RefusalRecord } from '@app/lib/devUpdates';

import { NewProject } from './devUpdates/NewProject';
import { Connect } from './devUpdates/Connect';
import { Rules } from './devUpdates/Rules';
import { Review } from './devUpdates/Review';
import { Log } from './devUpdates/Log';

type Tab = 'review' | 'log' | 'rules' | 'connect';

/**
 * Development updates, for an owner.
 *
 * A coding assistant hands over what it finished; this is where the owner
 * decides what of it reaches their account. Until now the only way in was a
 * CLI, so the people most likely to want it (somebody building in public with
 * Claude Code) were the least likely to find it.
 *
 * One screen over the routes that already exist. It holds no rules of its
 * own: every decision is the server's, made through the same guard the CLI and
 * the MCP server go through.
 */
export function DevUpdatesPage() {
  const [params, setParams] = useSearchParams();
  const projects = useResource<{ items: DevUpdateProject[] }>('/api/dev-updates/projects');
  const agents = useResource<{ items: AgentListItem[] }>('/api/agents');
  const connection = useResource<DevUpdateConnection>('/api/dev-updates/connection');
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>('review');
  // The token exists here, in memory, until the owner hides it or leaves the
  // page. Keyed by project so it is never shown under the wrong one.
  const [fresh, setFresh] = useState<{ projectId: string; token: string } | null>(null);
  const [waited, setWaited] = useState(0);

  const list = projects.data?.items ?? [];
  const selectedId = params.get('project');
  const project = list.find((p) => p.id === selectedId) ?? list[0] ?? null;

  const updates = useResource<{ items: DevUpdate[] }>(project ? `/api/dev-updates/updates?projectId=${project.id}&limit=200` : null);
  const audit = useResource<{ items: RefusalRecord[] }>(project ? '/api/audit?action=dev_updates.refused&limit=200' : null);
  usePolling(
    () => {
      updates.reload();
      audit.reload();
      projects.reload();
    },
    20_000,
    Boolean(project),
  );

  // How long the first load has taken, for Working.
  const firstLoad = projects.loading && !projects.data;
  useEffect(() => {
    if (!firstLoad) return;
    setWaited(0);
    const timer = window.setInterval(() => setWaited((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [firstLoad]);

  const agentList = agents.data?.items ?? [];
  const agent = project ? (agentList.find((a) => a.id === project.agentId) ?? null) : null;
  const handle = project ? (agentList.flatMap((a) => a.accounts).find((a) => a.accountId === project.accountId)?.handle ?? null) : null;

  const items = updates.data?.items ?? [];
  const pending = items.filter((u) => u.status === 'PENDING_REVIEW').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const refusals = useMemo(
    () => (audit.data?.items ?? []).filter((r) => project && r.entityId === project.id),
    [audit.data, project],
  );

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('project', id);
    setParams(next, { replace: true });
  };

  const header = (
    <div className="space-y-3">
      <p className="eyebrow text-bone-dim">
        Development updates
        {project && updates.data ? ` · ${pending.length} waiting for you` : ''}
      </p>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <AnimatedText as="h1" text="Post what you ship" className="monument text-[11vw] leading-[0.95] sm:text-[4.4vw] lg:text-[3.2rem]" />
        {list.length > 0 && (
          <button type="button" className="btn-ghost" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New project
          </button>
        )}
      </div>
      <Explain label="development updates">
        <p>
          <strong>Your coding assistant tells one of your agents what it just finished, and the agent posts about it.</strong>
        </p>
        <p>
          You connect Claude Code to a project with a token. When something is done, it sends what changed, why it matters
          and the evidence. Anything that looks like a secret, private, security related or unreleased is refused before it
          is stored.
        </p>
        <p>
          By default every draft waits here for you, and nothing is really posted until you turn rehearsal off. If you
          leave it alone, nothing reaches your account.
        </p>
      </Explain>
      <p className="max-w-2xl text-[13px] leading-relaxed text-bone-dim">
        Your coding assistant shares finished, public work. You read the post, and the agent publishes it within the limits
        you set.
      </p>
    </div>
  );

  const newProject = (
    <NewProject
      open={creating}
      agents={agentList}
      onClose={() => setCreating(false)}
      onCreated={(result) => {
        setCreating(false);
        setFresh({ projectId: result.project.id, token: result.senderToken });
        setTab('connect');
        projects.reload();
        select(result.project.id);
      }}
    />
  );

  if (firstLoad) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-8 px-5 pb-24 pt-32 sm:px-10 sm:pt-28">
        {header}
        <Working label="Reading your projects" seconds={waited} slowHint="The API is slow to answer. Nothing has failed yet." />
      </div>
    );
  }

  if (projects.error) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-8 px-5 pb-24 pt-32 sm:px-10 sm:pt-28">
        {header}
        <RetryablePanel title="Your projects could not be loaded." detail={projects.error} onRetry={projects.reload} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-8 px-5 pb-24 pt-32 sm:px-10 sm:pt-28">
        {header}
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            ['Connect', 'Create a project, choose the agent and the account it posts through, and paste one command into your terminal.'],
            ['Share', 'When Claude Code finishes something public, it sends what changed and why. Secrets and private work are refused.'],
            ['Decide', 'You read each post here and approve, edit or reject it. Nothing is published until you say so.'],
          ].map(([title, line], i) => (
            <li key={title} className="panel p-4 sm:p-5">
              <span className="font-mono text-[11px] text-signal-calm">0{i + 1}</span>
              <p className="mt-2 text-[15px] text-bone">{title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-bone-dim">{line}</p>
            </li>
          ))}
        </ol>
        <EmptyState
          title="No projects yet"
          detail={
            agents.data && agentList.length === 0
              ? 'You need an agent with an account it may post through first.'
              : 'Start with one project. It begins safe: drafts wait for you and nothing is posted until you turn rehearsal off.'
          }
          action={
            agents.data && agentList.length === 0 ? (
              <Link to="/agents/new" className="btn-primary">
                Create an agent
              </Link>
            ) : (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)} disabled={!agents.data}>
                <Plus className="h-4 w-4" aria-hidden /> Create a project
              </button>
            )
          }
        />
        {agents.error && <RetryablePanel title="Your agents could not be loaded." detail={agents.error} onRetry={agents.reload} />}
        {newProject}
      </div>
    );
  }

  const status = !project.enabled
    ? { tone: 'text-signal-wait', words: 'Paused' }
    : project.rehearse
      ? { tone: 'text-signal-calm', words: 'Rehearsing' }
      : { tone: 'text-signal-live', words: 'Posting for real' };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-5 pb-24 pt-32 sm:px-10 sm:pt-28">
      {header}

      {list.length > 1 && (
        <nav aria-label="Projects" className="scroll-x -mx-4 px-4 sm:mx-0 sm:px-0">
          <ul className="flex gap-2">
            {list.map((p) => (
              <li key={p.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={p.id === project.id ? 'true' : undefined}
                  onClick={() => select(p.id)}
                  className={`min-h-[44px] rounded-lg border px-3.5 py-2 text-left transition-colors ${
                    p.id === project.id ? 'border-signal-calm/60 bg-signal-calm/[0.07]' : 'border-ink-line hover:border-bone-faint'
                  }`}
                >
                  <span className="block max-w-[14rem] truncate text-sm text-bone">{p.displayName}</span>
                  <span className="block max-w-[14rem] truncate font-mono text-[10px] text-bone-dim">{p.projectKey}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <section aria-labelledby="project-name" className="space-y-6">
        <div className="panel p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h2 id="project-name" className="break-words text-xl font-light text-bone">
                {project.displayName}
              </h2>
              <p className="break-words text-[13px] text-bone-dim">
                <span className="font-mono text-bone-dim">{project.projectKey}</span> · posts as{' '}
                {agent ? (
                  <Link to={`/agents/${agent.id}`} className="text-bone underline decoration-bone-dim underline-offset-4 hover:decoration-bone">
                    {agent.name}
                  </Link>
                ) : (
                  'an agent you no longer have'
                )}{' '}
                through <span className="font-mono text-bone">{handle ? `@${handle}` : 'an account that is gone'}</span>
              </p>
            </div>
            <dl className="grid shrink-0 grid-cols-3 gap-x-5 gap-y-1 text-left sm:text-right">
              <div>
                <dt className="eyebrow text-bone-dim">State</dt>
                <dd className={`mt-1 text-sm ${status.tone}`}>{status.words}</dd>
              </div>
              <div>
                <dt className="eyebrow text-bone-dim">Decides</dt>
                <dd className="mt-1 text-sm text-bone">{project.mode === 'AUTO' ? 'On its own' : 'You'}</dd>
              </div>
              <div>
                <dt className="eyebrow text-bone-dim">Token</dt>
                <dd className={`mt-1 text-sm ${project.senderToken.active ? 'text-bone' : 'text-signal-wait'}`}>
                  {project.senderToken.active ? 'Active' : 'None'}
                </dd>
              </div>
            </dl>
          </div>
          {project.lastDispatchReason && (
            <p className="mt-4 break-words border-t border-ink-line pt-4 text-[13px] leading-relaxed text-bone-dim">
              <span className="text-bone-dim">Latest from the queue: </span>
              {project.lastDispatchReason}
            </p>
          )}
        </div>

        <Tabs<Tab>
          idBase="dev-updates"
          label="Project"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'review', label: 'Waiting for you', count: updates.data ? pending.length : undefined },
            { id: 'log', label: 'Log', count: updates.data ? items.length + refusals.length : undefined },
            { id: 'rules', label: 'Rules' },
            { id: 'connect', label: 'Connect' },
          ]}
        />

        <div role="tabpanel" id={`dev-updates-panel-${tab}`} aria-labelledby={`dev-updates-tab-${tab}`} tabIndex={0} className="focus-visible:outline-offset-8">
          {(tab === 'review' || tab === 'log') && updates.loading && !updates.data ? (
            <Working label="Reading this project's updates" seconds={0} />
          ) : (tab === 'review' || tab === 'log') && updates.error ? (
            <RetryablePanel title="This project's updates could not be loaded." detail={updates.error} onRetry={updates.reload} />
          ) : tab === 'review' ? (
            <Review
              updates={pending}
              agent={agent}
              handle={handle}
              rehearse={project.rehearse}
              onDecided={() => {
                updates.reload();
                projects.reload();
              }}
            />
          ) : tab === 'log' ? (
            <>
              {audit.error && (
                <div className="mb-4">
                  <RetryablePanel title="Refusals could not be read, so they are missing below." detail={audit.error} onRetry={audit.reload} />
                </div>
              )}
              <Log updates={items} refusals={refusals} />
            </>
          ) : tab === 'rules' ? (
            <Rules project={project} handle={handle} onChanged={projects.reload} />
          ) : (
            <Connect
              project={project}
              connection={connection.data}
              connectionError={connection.error}
              freshToken={fresh?.projectId === project.id ? fresh.token : null}
              onIssued={(token) => setFresh({ projectId: project.id, token })}
              onForget={() => setFresh(null)}
              onChanged={projects.reload}
            />
          )}
        </div>
      </section>

      {newProject}
    </div>
  );
}
