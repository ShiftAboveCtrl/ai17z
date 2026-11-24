import { useState } from 'react';
import type { GoalAttemptState, GoalProposedEnd, GoalResume } from '@xbam/shared/contracts';
import { useResource } from '@app/lib/hooks';
import { ApiError, post } from '@app/lib/api';

/** The parts of a goal this view reads. The Mind screen sends them with every goal. */
export interface GoalWork {
  id: string;
  status: string;
  dailyStepBudget: number;
  dailyTimeBudgetMs: number;
  nextAttemptAt: string | null;
  proposedEnd: GoalProposedEnd | null;
  proposedEndReason: string;
  blockedReason: string | null;
  resume: GoalResume | null;
}

interface Attempt {
  id: string;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
  state: GoalAttemptState;
  steps: { capabilityId: string; outcome: string }[];
  summary: string;
}

interface AttemptsView {
  attempts: Attempt[];
  usage: { stepsUsed: number; msUsed: number; stepBudget: number; timeBudgetMs: number; windowStartedAt: string | null };
}

const states: Record<GoalAttemptState, string> = {
  RUNNING: 'Running', COMPLETED: 'Finished', PROPOSED: 'Proposed a step for you', STOPPED: 'Stopped',
  EXHAUSTED: 'Ran out of budget', INTERRUPTED: 'Interrupted',
};

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * What a goal has done over time and what it is waiting for you to decide.
 *
 * The ending is the agent's proposal and the decision is yours: nothing here
 * changes a goal until you press Accept.
 */
export function GoalAttempts({ agentId, goal, onChanged }: { agentId: string; goal: GoalWork; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/agents/${agentId}/mind/goals/${goal.id}`;
  const view = useResource<AttemptsView>(open ? `${base}/attempts` : null);

  const decide = async (action: 'accept-end' | 'dismiss-end' | 'unblock') => {
    setBusy(true);
    setError(null);
    try {
      await post(`${base}/${action}`);
      onChanged();
      view.reload();
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 409 ? failure.message : 'That could not be saved. Refresh and try again.');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const facts = goal.resume?.facts ?? [];
  return (
    <div className="mt-3 space-y-3">
      {goal.proposedEnd && goal.status === 'ACTIVE' && (
        <div role="status" className="rounded border border-bone/20 p-3 text-sm">
          <p className="font-medium">
            It proposes this goal is {goal.proposedEnd === 'DONE' ? 'done' : 'not worth continuing'}.
          </p>
          <p className="mt-1 break-words text-bone-dim">{goal.proposedEndReason}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-ghost min-h-12 text-[12px]" disabled={busy} onClick={() => decide('accept-end')}>
              {goal.proposedEnd === 'DONE' ? 'Accept: mark it completed' : 'Accept: mark it abandoned'}
            </button>
            <button type="button" className="btn-quiet min-h-12 text-[12px]" disabled={busy} onClick={() => decide('dismiss-end')}>
              Keep it going
            </button>
          </div>
        </div>
      )}
      {goal.blockedReason && goal.status === 'ACTIVE' && (
        <div role="status" className="rounded border border-bone/20 p-3 text-sm">
          <p className="font-medium">Paused until you check.</p>
          <p className="mt-1 break-words text-bone-dim">{goal.blockedReason}</p>
          <button type="button" className="btn-ghost mt-2 min-h-12 text-[12px]" disabled={busy} onClick={() => decide('unblock')}>
            I checked, let it continue
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-bone">{error}</p>}
      <button type="button" className="btn-quiet px-0 text-[12px]" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? 'Hide attempts' : 'Attempts, budget and what it remembers'}
      </button>
      {open && (
        <div className="space-y-3 text-sm" aria-live="polite">
          {view.loading && !view.data && <p className="text-bone-dim">Loading attempts</p>}
          {view.error && <p role="alert" className="text-bone">Attempts could not be loaded. Hide and show them to try again.</p>}
          {view.data && (
            <>
              <p className="text-bone-dim">
                Used in the last 24 hours: {view.data.usage.stepsUsed} of {view.data.usage.stepBudget} steps,{' '}
                {seconds(view.data.usage.msUsed)} of {seconds(view.data.usage.timeBudgetMs)}.
                {goal.nextAttemptAt && Date.parse(goal.nextAttemptAt) > Date.now()
                  ? ` Next attempt after ${new Date(goal.nextAttemptAt).toLocaleString()}.` : ''}
              </p>
              {facts.length > 0 && (
                <div>
                  <p className="text-bone-dim">What it carries forward (looked up earlier, may be stale)</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {facts.map(fact => (
                      <li key={`${fact.capabilityId}:${fact.atAttempt}:${fact.summary}`} className="break-words">
                        {fact.capabilityId}: {fact.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {view.data.attempts.length === 0 && <p className="text-bone-dim">No attempts yet.</p>}
              <ol className="space-y-2">
                {view.data.attempts.map(item => (
                  <li key={item.id} className="rounded border border-bone/10 p-3">
                    <p className="font-medium">Attempt {item.attemptNo}: {states[item.state]}</p>
                    <p className="mt-1 break-words text-bone-dim">
                      {item.steps.length === 0 ? `It looked and did nothing. ${item.summary}` : item.summary}
                    </p>
                    {item.steps.length > 0 && (
                      <ul className="mt-1 list-disc pl-5">
                        {item.steps.map((step, index) => (
                          <li key={`${item.id}:${index}`} className="break-words">
                            {step.capabilityId}: {step.outcome === 'PROPOSED'
                              ? 'waiting for your decision under Capability approvals' : step.outcome.toLowerCase().replace(/_/g, ' ')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}
