import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleSlash, HelpCircle, MinusCircle } from 'lucide-react';
import { get } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import { EmptyState, RetryablePanel, Working } from '@app/components/ui';
import { useEffect, useState } from 'react';

type HealthState = 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'OFF' | 'UNKNOWN';

interface ComponentHealth {
  name: string;
  state: HealthState;
  detail: string;
  lastSucceededAt: string | null;
  failingForMinutes: number | null;
}

interface Diagnostics {
  agent: { state: string; canWork: boolean; reason: string | null };
  account: { connected: boolean; handle: string | null; status: string | null; lastPolledAt: string | null };
  worker: ComponentHealth;
  providers: ComponentHealth[];
  models: { role: string; configured: boolean; model: string | null }[];
  browser: ComponentHealth[];
  radar: ComponentHealth[];
  tools: ComponentHealth[];
  knowledge: ComponentHealth[];
  lastSuccess: { poll: string | null; generation: string | null; action: string | null };
  recentFailures: { reason: string; count: number; lastAt: string | null }[];
  collectedAt: string;
}

interface StatusResponse {
  status: { activity: string; detail: string };
  diagnostics: Diagnostics;
}

interface AgentRow {
  id: string;
  name: string;
}

const ICON: Record<HealthState, typeof CheckCircle2> = {
  HEALTHY: CheckCircle2,
  DEGRADED: AlertTriangle,
  FAILING: CircleSlash,
  OFF: MinusCircle,
  UNKNOWN: HelpCircle,
};

const COLOUR: Record<HealthState, string> = {
  HEALTHY: 'text-signal-calm',
  DEGRADED: 'text-signal-warn',
  FAILING: 'text-signal-fail',
  OFF: 'text-bone-faint',
  UNKNOWN: 'text-bone-faint',
};

/** The worst state in a group, because a group is as healthy as its worst part. */
function worstOf(components: ComponentHealth[]): HealthState {
  if (components.some((c) => c.state === 'FAILING')) return 'FAILING';
  if (components.some((c) => c.state === 'DEGRADED')) return 'DEGRADED';
  if (components.length === 0) return 'OFF';
  if (components.every((c) => c.state === 'OFF')) return 'OFF';
  if (components.some((c) => c.state === 'UNKNOWN')) return 'UNKNOWN';
  return 'HEALTHY';
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function Dot({ state, className = '' }: { state: HealthState; className?: string }) {
  const Glyph = ICON[state];
  return <Glyph className={`h-3.5 w-3.5 shrink-0 ${COLOUR[state]} ${className}`} aria-hidden />;
}

/**
 * One page answering "is this working, and if not, which part".
 *
 * Built entirely out of `/api/agents/:id/status`, which is the same collection
 * the agent reads when somebody asks it why it is not replying and the same one
 * the live status word comes from. There is deliberately no second health
 * system: two of them would disagree, and the one on the screen would be the
 * one somebody believed.
 *
 * A part is shown with when it last *succeeded*, not when it last ran. A poller
 * that has been failing every thirty seconds for two hours has run very
 * recently and worked two hours ago, and only the second number is the answer
 * to the question being asked.
 */
export function HealthPage() {
  const agents = useResource<{ items: AgentRow[] }>('/api/agents');
  const [reports, setReports] = useState<Record<string, StatusResponse>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Anything that can outlast a person's patience says how long it has been
  // going. One agent at a time over a slow browser session adds up.
  const [elapsed, setElapsed] = useState(0);

  const items = agents.data?.items ?? [];

  // Each agent is asked separately, because that is how the endpoint is scoped
  // and because one agent failing to report should not blank the page for the
  // rest. A failure shows as an unknown row rather than a missing one.
  useEffect(() => {
    if (!agents.data) return;
    let live = true;
    const load = async () => {
      const next: Record<string, StatusResponse> = {};
      for (const agent of agents.data!.items) {
        try {
          next[agent.id] = await get<StatusResponse>(`/api/agents/${agent.id}/status`);
        } catch {
          // Left out of `next`; rendered as "could not be read" below.
        }
      }
      if (!live) return;
      setReports(next);
      setLoading(false);
      setLoadError(agents.data!.items.length > 0 && Object.keys(next).length === 0 ? 'No agent could be read.' : null);
    };
    void load();
    return () => {
      live = false;
    };
  }, [agents.data]);

  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => setElapsed((was) => was + 1), 1_000);
    return () => clearInterval(timer);
  }, [loading]);

  usePolling(() => agents.reload(), 20_000, true);

  if (agents.error) {
    return (
      <div className="mx-auto max-w-page px-6 py-24 sm:px-10">
        <RetryablePanel
          title="This installation could not be read."
          detail="The API did not answer. Nothing here is a statement about whether your agents are working."
          onRetry={() => agents.reload()}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-page px-6 py-24 sm:px-10">
      <p className="eyebrow">Health</p>
      <h1 className="mt-3 text-4xl font-light tracking-tight text-bone sm:text-5xl">Is it working.</h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-bone-faint">
        Every part each agent depends on, and when it last succeeded rather than when it last ran. A poller failing
        every thirty seconds for two hours ran a moment ago and worked two hours ago, and only the second number
        answers the question.
      </p>

      {loading && items.length > 0 && (
        <div className="mt-10">
          <Working label="Reading the health of each agent" seconds={elapsed} />
        </div>
      )}

      {loadError && <p className="mt-6 break-words text-sm text-signal-fail">{loadError}</p>}

      {!loading && items.length === 0 && (
        <div className="mt-10">
          <EmptyState title="No agents yet." detail="Create one and this page will say whether it is working." />
        </div>
      )}

      <div className="mt-10 space-y-8">
        {items.map((agent) => {
          const report = reports[agent.id];
          if (!report) {
            return (
              <section key={agent.id} className="rounded-xl border border-ink-line p-5">
                <div className="flex items-center gap-2">
                  <Dot state="UNKNOWN" />
                  <h2 className="text-lg font-light text-bone">{agent.name}</h2>
                </div>
                <p className="mt-2 text-[13px] text-bone-faint">
                  {loading ? 'Reading.' : 'Its health could not be read just now.'}
                </p>
              </section>
            );
          }
          return <AgentHealth key={agent.id} agent={agent} report={report} />;
        })}
      </div>
    </div>
  );
}

function AgentHealth({ agent, report }: { agent: AgentRow; report: StatusResponse }) {
  const d = report.diagnostics;

  // Grouped the way somebody debugging would look: what runs it, what it needs
  // to think, what it needs to see, and what it reads.
  const groups: { label: string; state: HealthState; parts: ComponentHealth[]; note?: string }[] = [
    { label: 'Worker', state: d.worker.state, parts: [d.worker] },
    { label: 'Providers', state: worstOf(d.providers), parts: d.providers },
    { label: 'Browser tabs', state: worstOf(d.browser), parts: d.browser },
    { label: 'Radar', state: worstOf(d.radar), parts: d.radar },
    { label: 'Tools', state: worstOf(d.tools), parts: d.tools },
    { label: 'Documentation', state: worstOf(d.knowledge), parts: d.knowledge },
  ];

  const missingRoles = d.models.filter((role) => !role.configured).map((role) => role.role);

  return (
    <section className="rounded-xl border border-ink-line p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Dot state={d.agent.canWork ? 'HEALTHY' : 'FAILING'} />
          <h2 className="text-lg font-light text-bone">
            <Link to={`/agents/${agent.id}`} className="hover:text-bone-dim">
              {agent.name}
            </Link>
          </h2>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
          {report.status.activity.replace(/_/g, ' ')}
        </p>
      </div>

      <p className="mt-2 break-words text-[13px] leading-relaxed text-bone-dim">{report.status.detail}</p>
      {d.agent.reason && <p className="mt-1 break-words text-[13px] text-signal-warn">{d.agent.reason}</p>}

      {/* The three timestamps that answer "is it actually doing anything", side
          by side, because the interesting thing is usually which one is old. */}
      <dl className="mt-5 grid grid-cols-3 gap-3 border-y border-ink-line py-4">
        {(
          [
            ['Last read', d.lastSuccess.poll],
            ['Last wrote', d.lastSuccess.generation],
            ['Last sent', d.lastSuccess.action],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">{label}</dt>
            <dd className="mt-1 text-[13px] tabular-nums text-bone">{when(value)}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
              <Dot state={group.state} />
              {group.label}
            </p>
            {group.parts.length === 0 ? (
              <p className="mt-1 text-[12px] text-bone-faint">Nothing configured.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {group.parts.map((part) => (
                  <li key={part.name} className="flex items-start gap-2 text-[12px] leading-relaxed">
                    <Dot state={part.state} className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="text-bone-dim">{part.name}</span>
                      <span className="ml-1.5 break-words text-bone-faint">{part.detail}</span>
                      {part.state !== 'HEALTHY' && part.lastSucceededAt && (
                        <span className="ml-1.5 text-bone-faint">Last worked {when(part.lastSucceededAt)}.</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {missingRoles.length > 0 && (
        <p className="mt-4 break-words text-[12px] leading-relaxed text-bone-faint">
          No model is set for: {missingRoles.join(', ')}. A role nothing can answer is a capability this agent does not
          have.
        </p>
      )}

      {d.recentFailures.length > 0 && (
        <div className="mt-5 border-t border-ink-line pt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">What has been failing</p>
          <ul className="mt-2 space-y-1">
            {d.recentFailures.map((failure) => (
              <li key={failure.reason} className="flex items-baseline gap-2 text-[12px]">
                {/* The classification and the count, never the message: a raw
                    error can contain the request it came from. */}
                <span className="break-words font-mono text-bone-dim">{failure.reason}</span>
                <span className="tabular-nums text-bone-faint">
                  {failure.count}
                  {failure.lastAt ? `, last ${when(failure.lastAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
        Read {when(d.collectedAt)}
      </p>
    </section>
  );
}
