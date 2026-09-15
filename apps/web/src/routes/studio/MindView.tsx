import { useState } from 'react';
import { useElapsed, useResource } from '@app/lib/hooks';
import { del, post, put } from '@app/lib/api';
import { EmptyState, RetryablePanel, Spinner, Working } from '@app/components/ui';
import { Card, Gaps, Panel, Reasons } from './shared';

/**
 * What the agent has been thinking about.
 *
 * An agent that develops interests, sets itself goals and decides things are
 * worth saying is only acceptable if its owner can see all three and change
 * them. This is that screen, and it is deliberately arranged the way somebody
 * would ask the questions: what is it thinking about, what is it trying to do,
 * what has it been doing, and how much is it allowed to do on its own.
 *
 * **It shows conclusions, never reasoning.** Nothing behind this screen stores
 * model reasoning and nothing here would have anywhere to put it. Each item is
 * what the agent concluded, what that rests on, and how sure it is.
 *
 * The word "mind" appears nowhere an owner can read it. This is persistent
 * deliberation -- bounded, inspectable, and switched off by default -- and
 * calling it anything grander would be a claim the implementation does not
 * support.
 */

interface Factor {
  name: string;
  detail: string;
  points: number;
}

interface Evidence {
  kind: string;
  ref: string;
  note: string;
  at: string | null;
}

interface MindItem {
  id: string;
  kind: string;
  summary: string;
  detail: string;
  salience: number;
  confidence: number;
  factors: Factor[];
  evidence: Evidence[];
  reinforcements: number;
  firstObservedAt: string;
  lastReinforcedAt: string;
  origin: string;
}

interface Goal {
  id: string;
  summary: string;
  reason: string;
  origin: string;
  pinned: boolean;
  priority: number;
  status: string;
  progress: number;
  resolution: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface Reflection {
  id: string;
  kind: string;
  considered: number;
  produced: number;
  retired: number;
  summary: string;
  model: string | null;
  why: string | null;
  createdAt: string;
}

interface Wake {
  enabled: boolean;
  autonomy: string;
  intervalSeconds: number;
  deepIntervalSeconds: number;
  nextWakeAt: string;
  lastWakeAt: string | null;
  lastReason: string;
  quietWakes: number;
}

interface MindView {
  wake: Wake | null;
  onItsMind: MindItem[];
  goals: Goal[];
  reflections: Reflection[];
}

interface RepoSource {
  id: string;
  repo: string;
  kinds: string[];
  enabled: boolean;
  status: string;
  hasToken: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface RepoEvent {
  id: string;
  repo: string;
  kind: string;
  title: string;
  url: string;
  state: string | null;
  occurredAt: string | null;
}

/** What each kind is, in the words somebody would use for it. */
const KINDS: Record<string, string> = {
  INTEREST: 'Following',
  CURIOSITY: 'Wants to find out',
  CONCERN: 'Uneasy about',
  HYPOTHESIS: 'Suspects',
  QUESTION: 'Open question',
  LESSON: 'Worked out',
  NARRATIVE: 'Watching',
  IDEA: 'Might say',
};

/**
 * The ladder, in an owner's words rather than the enum's.
 *
 * Four rungs rather than a switch because "autonomous" is four separate
 * decisions somebody makes at different times, and one control forces the most
 * cautious of them onto all four.
 */
const AUTONOMY: { value: string; label: string; detail: string }[] = [
  { value: 'OBSERVE', label: 'Watch', detail: 'Notices what happens and scores it. Changes nothing, says nothing.' },
  { value: 'THINK', label: 'Think', detail: 'Also reflects and keeps track of what it is interested in.' },
  { value: 'SUGGEST', label: 'Suggest', detail: 'Also puts ideas in the backlog for you to look at.' },
  {
    value: 'ACT',
    label: 'Act',
    detail: 'Also lets those ideas reach the same policy, cadence and approval gates everything else passes.',
  },
];

function when(iso: string | null): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toLocaleString();
}

function Bar({ value }: { value: number }) {
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div className="h-full bg-bone-faint" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function MindView({ agentId }: { agentId: string }) {
  const view = useResource<MindView>(`/api/agents/${agentId}/mind`);
  const repos = useResource<{ sources: RepoSource[]; events: RepoEvent[] }>(`/api/agents/${agentId}/mind/repos`);
  const [repo, setRepo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const elapsed = useElapsed(busy);

  const wake = view.data?.wake ?? null;
  const items = view.data?.onItsMind ?? [];
  const goals = view.data?.goals ?? [];
  const active = goals.filter((entry) => entry.status === 'ACTIVE');
  const finished = goals.filter((entry) => entry.status !== 'ACTIVE');

  const settings = async (patch: Record<string, unknown>) => {
    setFailed(null);
    try {
      await put(`/api/agents/${agentId}/mind/wake`, patch);
      view.reload();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That could not be saved.');
    }
  };

  const thinkNow = async () => {
    setFailed(null);
    setBusy(true);
    try {
      await post(`/api/agents/${agentId}/mind/wake`, {});
      view.reload();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That did not finish.');
    } finally {
      setBusy(false);
    }
  };

  const addGoal = async (event: React.FormEvent) => {
    event.preventDefault();
    const summary = goal.trim();
    if (summary.length < 6) return;
    setGoal('');
    try {
      await post(`/api/agents/${agentId}/mind/goals`, { summary });
      view.reload();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That could not be added.');
    }
  };

  const watch = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = repo.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
      setFailed('Give a repository as owner/name.');
      return;
    }
    setRepo('');
    try {
      await post(`/api/agents/${agentId}/mind/repos`, { repo: name });
      repos.reload();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That could not be watched.');
    }
  };

  const retire = async (id: string) => {
    try {
      await del(`/api/agents/${agentId}/mind/items/${id}`);
      view.reload();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'That could not be removed.');
    }
  };

  if (view.loading) return <Spinner />;

  return (
    <>
      <Panel
        title="How much it does on its own"
        lede="Deliberation is off until you turn it on. Each rung adds one thing, and the last one still passes everything through the same policy, cadence and approval gates as anything else."
      >
        {failed && (
          <div className="mb-4">
            <RetryablePanel title="That did not work" detail={failed} onRetry={() => view.reload()} />
          </div>
        )}

        <div className="space-y-3">
          <label className="flex items-center gap-3 text-[13px] text-bone-dim">
            <input
              type="checkbox"
              checked={wake?.enabled ?? false}
              onChange={(event) => void settings({ enabled: event.target.checked })}
            />
            Let this agent think between the things it is asked
          </label>

          <div className="grid gap-2 sm:grid-cols-2">
            {AUTONOMY.map((rung) => {
              const chosen = (wake?.autonomy ?? 'OBSERVE') === rung.value;
              return (
                <button
                  key={rung.value}
                  type="button"
                  disabled={!wake?.enabled}
                  aria-pressed={chosen}
                  onClick={() => void settings({ autonomy: rung.value })}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-40 ${
                    chosen ? 'border-bone-faint bg-white/[0.05]' : 'border-ink-line hover:bg-white/[0.02]'
                  }`}
                >
                  <p className="text-[14px] font-light text-bone">{rung.label}</p>
                  <p className="mt-1 break-words text-[12px] leading-relaxed text-bone-faint">{rung.detail}</p>
                </button>
              );
            })}
          </div>

          {wake && (
            <p className="break-words text-[12px] leading-relaxed text-bone-faint">
              Last looked {when(wake.lastWakeAt)}
              {wake.lastReason ? ` — ${wake.lastReason}` : ''}. Next around {when(wake.nextWakeAt)}.
              {wake.quietWakes > 0
                ? ` It has found nothing ${wake.quietWakes} time${wake.quietWakes === 1 ? '' : 's'} in a row, so it is checking less often.`
                : ''}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-ghost text-[12px]" onClick={() => void thinkNow()} disabled={busy || !wake?.enabled}>
              Think now
            </button>
            {busy && (
              <span className="text-[12px] text-bone-faint">
                <Working label="Looking at what has happened" seconds={elapsed} slowAfter={15} />
              </span>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="Currently on its mind"
        lede="What it has been paying attention to, strongest first, with what made each one matter. Nothing here is a transcript of its reasoning — each is a conclusion and what it rests on."
      >
        {items.length === 0 && (
          <EmptyState
            title="Nothing yet"
            detail={
              wake?.enabled
                ? 'It has not found anything worth keeping. That is the usual answer, and the screen would rather say so than invent something.'
                : 'Deliberation is switched off, so it has not been looking.'
            }
          />
        )}

        <div className="space-y-3">
          {items.map((item) => {
            const expanded = open === item.id;
            return (
              <Card
                key={item.id}
                title={
                  <button type="button" className="text-left hover:text-bone-dim" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.id)}>
                    {KINDS[item.kind] ?? item.kind}: {item.summary}
                  </button>
                }
                score={`${item.salience}`}
                meta={[
                  item.reinforcements > 1 ? `seen ${item.reinforcements} times` : 'seen once',
                  `${Math.round(item.confidence * 100)}% sure`,
                  `since ${when(item.firstObservedAt)}`,
                ].join(' · ')}
                action={
                  <button type="button" className="btn-quiet px-0 text-[12px]" onClick={() => void retire(item.id)}>
                    Take this off its mind
                  </button>
                }
              >
                {expanded && (
                  <>
                    {item.detail && <p className="mb-3 break-words text-[12px] leading-relaxed text-bone-dim">{item.detail}</p>}
                    <Reasons items={item.factors} />
                    <Gaps
                      items={item.evidence.map((entry) => `${entry.kind}: ${entry.note || entry.ref}`)}
                      label="What it rests on"
                    />
                  </>
                )}
              </Card>
            );
          })}
        </div>
      </Panel>

      <Panel title="What it is trying to do" lede="Goals you set are pinned — it can work on them and cannot decide they stopped mattering.">
        <form className="mb-4 flex flex-wrap items-center gap-2" onSubmit={addGoal}>
          <input
            className="field min-w-0 flex-1 text-[13px]"
            placeholder="Something you would like it to work on"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <button type="submit" className="btn-ghost text-[12px]" disabled={goal.trim().length < 6}>
            Add goal
          </button>
        </form>

        {active.length === 0 && finished.length === 0 && (
          <EmptyState title="No goals" detail="Give it something to work on, or let it pick something up as it goes." />
        )}

        <div className="space-y-3">
          {[...active, ...finished].map((entry) => (
            <Card
              key={entry.id}
              title={entry.summary}
              score={entry.status === 'ACTIVE' ? `${entry.progress}%` : entry.status.toLowerCase()}
              meta={[
                entry.origin === 'OWNER' ? 'you set this' : 'it set this itself',
                entry.pinned ? 'pinned' : '',
                entry.reason,
                entry.resolution,
              ]
                .filter(Boolean)
                .join(' · ')}
              action={
                <button
                  type="button"
                  className="btn-quiet px-0 text-[12px]"
                  onClick={async () => {
                    await del(`/api/agents/${agentId}/mind/goals/${entry.id}`).catch(() => undefined);
                    view.reload();
                  }}
                >
                  Remove
                </button>
              }
            >
              {entry.status === 'ACTIVE' && <Bar value={entry.progress} />}
            </Card>
          ))}
        </div>
      </Panel>

      <Panel
        title="Projects it follows"
        lede="Public repositories are read without any credential. What a project did becomes evidence with a link anybody can check — and most of what a repository does in a day is mechanical and never reaches the agent at all."
      >
        <form className="mb-4 flex flex-wrap items-center gap-2" onSubmit={watch}>
          <input
            className="field min-w-0 flex-1 text-[13px]"
            placeholder="owner/name"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="btn-ghost text-[12px]" disabled={repo.trim() === ''}>
            Watch this repository
          </button>
        </form>

        {(repos.data?.sources ?? []).length === 0 && (
          <EmptyState title="Not following anything" detail="Point it at a repository and it will know what shipped." />
        )}

        <div className="space-y-3">
          {(repos.data?.sources ?? []).map((source) => (
            <Card
              key={source.id}
              title={source.repo}
              score={source.status.toLowerCase()}
              meta={[
                source.kinds.join(', ').toLowerCase(),
                source.hasToken ? 'private, with a read-only token' : 'public',
                source.lastSuccessAt ? `last read ${when(source.lastSuccessAt)}` : 'not read yet',
                source.lastError ?? '',
              ]
                .filter(Boolean)
                .join(' · ')}
              action={
                <button
                  type="button"
                  className="btn-quiet px-0 text-[12px]"
                  onClick={async () => {
                    await del(`/api/agents/${agentId}/mind/repos/${source.id}`).catch(() => undefined);
                    repos.reload();
                  }}
                >
                  Stop watching
                </button>
              }
            />
          ))}
        </div>

        {(repos.data?.events ?? []).length > 0 && (
          <div className="mt-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">What they did</p>
            <ul className="mt-2 space-y-1.5">
              {(repos.data?.events ?? []).slice(0, 12).map((entry) => (
                <li key={entry.id} className="flex flex-wrap gap-2 text-[12px] leading-relaxed">
                  <span className="font-mono text-[10px] uppercase text-bone-faint">{entry.kind.toLowerCase()}</span>
                  <a
                    className="min-w-0 break-words text-bone-dim hover:text-bone"
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {entry.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <Panel
        title="What it has been doing"
        lede="Every time it looked, including the times it found nothing. A screen that listed only the productive ones would make a correctly quiet agent look broken."
      >
        {(view.data?.reflections ?? []).length === 0 && <EmptyState title="It has not looked yet" />}
        <ul className="space-y-2">
          {(view.data?.reflections ?? []).map((entry) => (
            <li key={entry.id} className="rounded-lg border border-ink-line px-3 py-2">
              <p className="break-words text-[12px] leading-relaxed text-bone-dim">{entry.summary}</p>
              <p className="mt-1 text-[11px] text-bone-faint">
                {when(entry.createdAt)} · {entry.kind.toLowerCase()} · looked at {entry.considered}
                {entry.model ? ` · ${entry.model}` : ' · no model needed'}
              </p>
              {/*
                Why it produced nothing, when there was a reason beyond there
                being nothing to say. Without this a reflection that failed and
                one that correctly found nothing are the same line on the
                screen, which is how a broken feature hides behind a working
                one.
              */}
              {entry.why && (
                <p className="mt-1 break-words text-[11px] text-bone-faint">Did not get that far: {entry.why}</p>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
