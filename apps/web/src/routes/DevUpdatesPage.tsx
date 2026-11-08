import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import type { AgentDetail, AgentListItem } from '@app/lib/types';
import { EmptyState, RetryablePanel, Tabs, Working } from '@app/components/ui';
import { Explain } from '@app/components/Explain';
import { AnimatedText } from '@app/components/motion';
import {
  LOG_LIMIT,
  REFUSAL_LIMIT,
  agentPublishingFor,
  logTruncation,
  publishingState,
} from '@app/lib/devUpdates';
import type { AgentPublishing, DevUpdate, DevUpdateConnection, DevUpdateProject, RefusalRecord } from '@app/lib/devUpdates';
import { NewProject } from './devUpdates/NewProject';
import { Connect } from './devUpdates/Connect';
import { Rules } from './devUpdates/Rules';
import { Review } from './devUpdates/Review';
import { Log } from './devUpdates/Log';

type Tab = 'review' | 'log' | 'rules' | 'connect';
const TABS: readonly Tab[] = ['review', 'log', 'rules', 'connect'];

const PAGE = 'mx-auto w-full max-w-5xl space-y-8 px-5 pb-24 pt-32 sm:px-10 sm:pt-28';
const SLOW = 'The API is slow to answer. Nothing has failed yet; you can leave this page and come back.';

/**
 * Development updates, for an owner.
 *
 * A coding assistant hands over what it finished; this is where the owner
 * decides what of it reaches their account. Until now the only way in was a
 * CLI, so the people most likely to want it (somebody building in public with
 * a coding assistant) were the least likely to find it.
 *
 * One screen over the routes that already exist. It holds no rules of its
 * own: every decision is the server's, made through the same guard the CLI and
 * the MCP server go through.
 *
 * The page knows which projects exist. Everything about one project lives in
 * `ProjectWorkspace`, mounted afresh for each project (`key={project.id}`), so
 * switching project cannot leave the last one's drafts on screen under the new
 * one's account, with buttons that would still decide the old ones.
 */
export function DevUpdatesPage() {
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const navigate = useNavigate();
  const projects = useResource<{ items: DevUpdateProject[] }>('/api/dev-updates/projects');
  const agents = useResource<{ items: AgentListItem[] }>('/api/agents');
  const connection = useResource<DevUpdateConnection>('/api/dev-updates/connection');
  const [creating, setCreating] = useState(false);

  const firstLoad = projects.loading && !projects.data;
  const waited = useElapsed(firstLoad);

  const list = projects.data?.items ?? [];
  const selectedId = params.get('project');
  const project = list.find((p) => p.id === selectedId) ?? list[0] ?? null;
  const agentList = agents.data?.items ?? [];

  /** Chooses a project, on a given tab or on its first. */
  const select = (id: string, tab?: Tab) => {
    const next = new URLSearchParams(paramsRef.current);
    next.set('project', id);
    if (tab) next.set('tab', tab);
    else next.delete('tab');
    setParams(next, { replace: true });
  };

  const header = (
    <div className="space-y-3">
      <p className="eyebrow text-bone-dim">Development updates</p>
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
          You connect your coding assistant to a project with a token. When something is done, it sends what changed, why
          it matters and the evidence. Anything that looks like a secret, private, security related or unreleased is
          refused before it is stored.
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
      connection={connection.data}
      connectionError={connection.error}
      onClose={() => setCreating(false)}
      onCreated={(created, current) => {
        projects.reload();
        // A project whose answer came after the dialog closed is listed, but
        // the page does not jump to it under the owner's feet.
        if (current) select(created.id);
      }}
      onOpenConnect={(id) => {
        projects.reload();
        select(id, 'connect');
      }}
    />
  );

  /*
    One return, with the dialog outside every branch.

    Each state used to return its own tree, with the dialog inside it. Creating
    the first project moves the page from the empty state to the project view,
    and React, finding the dialog somewhere else in the tree, mounted a new
    one: the token it had just been handed went with the old one. Here the
    branches change only `body`, and the dialog keeps its place for the life
    of the page.
  */
  let body: ReactNode;
  if (firstLoad) {
    body = <Working label="Reading your projects" seconds={waited} slowHint={SLOW} onCancel={() => navigate('/')} cancelLabel="Leave this page" />;
  } else if (projects.error && !projects.data) {
    body = <RetryablePanel title="Your projects could not be loaded." detail={projects.error} onRetry={projects.reload} />;
  } else if (!project) {
    body = (
      <>
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            ['Connect', 'Create a project, choose the agent and the account it posts through, and paste one command into your terminal.'],
            ['Share', 'When your coding assistant finishes something public, it sends what changed and why. Secrets and private work are refused.'],
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
      </>
    );
  } else {
    body = (
      <>
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

      <ProjectWorkspace
        key={project.id}
        project={project}
        agents={agentList}
        connection={connection.data}
        connectionError={connection.error}
        onProjectChanged={projects.reload}
      />
      </>
    );
  }

  return (
    <>
      <div className={PAGE}>
        {header}
        {projects.error && projects.data && (
          <RetryablePanel title="Showing the last loaded projects. They could not be refreshed." detail={projects.error} onRetry={projects.reload} />
        )}
        {body}
      </div>
      {newProject}
    </>
  );
}

/**
 * One project: its header, drafts, log, rules and token.
 *
 * Mounted with `key={project.id}`. Every resource and every piece of state in
 * here (a draft half edited, a reason half typed, a freshly issued token) is
 * thrown away when the owner switches project, rather than carried across and
 * shown beside the wrong account until the next request lands.
 */
function ProjectWorkspace({
  project,
  agents,
  connection,
  connectionError,
  onProjectChanged,
}: {
  project: DevUpdateProject;
  agents: AgentListItem[];
  connection: DevUpdateConnection | null;
  connectionError: string | null;
  onProjectChanged: () => void;
}) {
  const navigate = useNavigate();
  // In the address rather than in state, so "open its Connect tab" reaches a
  // workspace that is already on screen, and a reload stays where it was.
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: Tab = TABS.includes(asked as Tab) ? (asked as Tab) : 'review';
  const setTab = (next: Tab) => {
    const updated = new URLSearchParams(params);
    if (next === 'review') updated.delete('tab');
    else updated.set('tab', next);
    setParams(updated, { replace: true });
  };
  const base = `/api/dev-updates/updates?projectId=${project.id}`;
  const updates = useResource<{ items: DevUpdate[] }>(`${base}&limit=${LOG_LIMIT}`);
  // Asked for on their own, with the status filter, so a draft is never missing
  // from the queue because two hundred newer updates pushed it off the log.
  const pendingResource = useResource<{ items: DevUpdate[] }>(`${base}&status=PENDING_REVIEW&limit=${LOG_LIMIT}`);
  const audit = useResource<{ items: RefusalRecord[] }>(`/api/audit?action=dev_updates.refused&limit=${REFUSAL_LIMIT}`);
  const agentDetail = useResource<AgentDetail>(`/api/agents/${project.agentId}`);

  usePolling(
    () => {
      updates.reload();
      pendingResource.reload();
      audit.reload();
      agentDetail.reload();
      onProjectChanged();
    },
    20_000,
    true,
  );

  const forTab = tab === 'review' ? pendingResource : updates;
  const waiting = (tab === 'review' || tab === 'log') && forTab.loading && !forTab.data;
  const waited = useElapsed(waiting);

  const agent = agents.find((a) => a.id === project.agentId) ?? null;
  const handle = agents.flatMap((a) => a.accounts).find((a) => a.accountId === project.accountId)?.handle ?? null;
  // Only the agent this project maps to now. After a rewiring the detail on
  // screen can still be the previous agent's, and its switches are not these.
  const agentPublishing: AgentPublishing | null = agentPublishingFor(agentDetail.data, project.agentId);
  const publishing = publishingState(project, agentPublishing, agentPublishing ? null : agentDetail.error);
  // An owner decision bypasses the automatic approval gate, but still obeys
  // pauses, rehearsal and the agent's publishing switches.
  const approvalPublishing = publishingState({ ...project, mode: 'DRAFT' }, agentPublishing, agentPublishing ? null : agentDetail.error);
  const rehearsing = publishing.heldBy === 'PROJECT_REHEARSES' || publishing.heldBy === 'AGENT_DRY_RUN';
  const heldByAgent = publishing.heldBy === 'AGENT_DRY_RUN' || publishing.heldBy === 'AGENT_AUTOMATION' || publishing.heldBy === 'AGENT_GATE';

  const items = updates.data?.items ?? [];
  const pending = (pendingResource.data?.items ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const auditRows = useMemo(() => audit.data?.items ?? [], [audit.data]);
  const refusals = useMemo(() => auditRows.filter((r) => r.entityId === project.id), [auditRows, project.id]);
  const truncated = logTruncation(items.length, auditRows.length);

  const tone =
    publishing.tone === 'live'
      ? 'text-signal-live'
      : publishing.tone === 'wait'
        ? 'text-signal-wait'
        : publishing.tone === 'calm'
          ? 'text-signal-calm'
          : 'text-bone-dim';

  return (
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
              <dd className={`mt-1 text-sm ${tone}`}>{publishing.words}</dd>
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
        <div className="mt-4 space-y-2 border-t border-ink-line pt-4 text-[13px] leading-relaxed text-bone-dim">
          <p className="break-words">
            {publishing.sentence}{' '}
            {heldByAgent && (
              <Link to={`/agents/${project.agentId}#policies`} className="text-bone underline decoration-bone-dim underline-offset-4 hover:decoration-bone">
                Open {agent?.name ?? 'the agent'}'s policies
              </Link>
            )}
          </p>
          {agentDetail.error && agentPublishing && (
            <p className="break-words text-signal-wait">The agent's settings could not be read again just now: {agentDetail.error}</p>
          )}
          {project.lastDispatchReason && (
            <p className="break-words">
              <span className="text-bone-dim">Latest from the queue: </span>
              {project.lastDispatchReason}
            </p>
          )}
        </div>
      </div>

      <Tabs<Tab>
        idBase="dev-updates"
        label="Project"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'review', label: 'Waiting for you', count: pendingResource.data ? pending.length : undefined },
          { id: 'log', label: 'Log', count: updates.data ? items.length + refusals.length : undefined },
          { id: 'rules', label: 'Rules' },
          { id: 'connect', label: 'Connect' },
        ]}
      />

      <div role="tabpanel" id={`dev-updates-panel-${tab}`} aria-labelledby={`dev-updates-tab-${tab}`} tabIndex={0} className="focus-visible:outline-offset-8">
        {(tab === 'review' || tab === 'log') && forTab.error && forTab.data && (
          <div className="mb-4">
            <RetryablePanel title={tab === 'review' ? 'Showing the last loaded drafts. They could not be refreshed.' : 'Showing the last loaded updates. They could not be refreshed.'} detail={forTab.error} onRetry={forTab.reload} />
          </div>
        )}
        {waiting ? (
          <Working
            label={tab === 'review' ? 'Reading the drafts waiting for you' : "Reading this project's updates"}
            seconds={waited}
            slowHint={SLOW}
            onCancel={() => navigate('/')}
            cancelLabel="Leave this page"
          />
        ) : (tab === 'review' || tab === 'log') && forTab.error && !forTab.data ? (
          <RetryablePanel
            title={tab === 'review' ? 'The drafts waiting for you could not be loaded.' : "This project's updates could not be loaded."}
            detail={forTab.error}
            onRetry={forTab.reload}
          />
        ) : tab === 'review' ? (
          <Review
            updates={pending}
            agent={agent}
            handle={handle}
            rehearse={rehearsing}
            publishing={approvalPublishing}
            onDecided={() => {
              pendingResource.reload();
              updates.reload();
              onProjectChanged();
            }}
          />
        ) : tab === 'log' ? (
          <>
            {audit.error && (
              <div className="mb-4">
                <RetryablePanel title={audit.data ? 'Showing the last loaded refusals. They could not be refreshed.' : 'Refusals could not be read, so they are missing below.'} detail={audit.error} onRetry={audit.reload} />
              </div>
            )}
            <Log updates={items} refusals={refusals} />
            {truncated && <p className="mt-4 break-words text-xs leading-relaxed text-bone-dim">{truncated}</p>}
          </>
        ) : tab === 'rules' ? (
          <Rules project={project} handle={handle} agentPublishing={agentPublishing} onChanged={onProjectChanged} />
        ) : (
          <Connect project={project} connection={connection} connectionError={connectionError} onChanged={onProjectChanged} />
        )}
      </div>
    </section>
  );
}
