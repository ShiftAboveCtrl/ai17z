import { useState } from 'react';
import { ApiError, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { RetryablePanel, Spinner, Toggle } from './ui';

export interface StudioRiskWatchStatus {
  binding: {
    accountId: string;
    enabled: boolean;
    mayTrigger: boolean;
    syncedAt: string | null;
    expiresAt: string | null;
    lastError: string | null;
  } | null;
  pendingObservations: number;
}

export const WATCH_SENTENCE =
  'Watch the tokens on your Studio risk list. This account then checks each one on its own and tells you when a limit is crossed. It reads market data only and never touches X for this.';
export const POST_SENTENCE =
  'Let a crossed limit become a post idea. Off, you are told and nothing is offered for posting. On, the idea still goes through every posting rule, and it states what was measured, never what to buy or sell.';

/** What an owner has chosen for this account. Another account holding the binding counts as off here. */
export function choiceFor(status: StudioRiskWatchStatus | null, accountId: string): { enabled: boolean; mayTrigger: boolean; elsewhere: boolean } {
  const binding = status?.binding;
  if (!binding?.enabled) return { enabled: false, mayTrigger: false, elsewhere: false };
  if (binding.accountId !== accountId) return { enabled: false, mayTrigger: false, elsewhere: true };
  return { enabled: true, mayTrigger: binding.mayTrigger, elsewhere: false };
}

/** Presentational, so each state renders without a network. */
export function StudioRiskWatchesView({
  status,
  loading,
  error,
  saving,
  problem,
  accountId,
  onRetry,
  onChange,
}: {
  status: StudioRiskWatchStatus | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  problem: string | null;
  accountId: string;
  onRetry: () => void;
  onChange: (next: { enabled: boolean; mayTrigger: boolean }) => void;
}) {
  const choice = choiceFor(status, accountId);
  const binding = status?.binding;
  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-ink-line bg-ink-panel p-4" aria-label="Studio risk watches">
      <h3 className="text-sm font-medium text-bone">Studio risk watches</h3>
      {loading && !status ? (
        <p role="status" className="flex items-center gap-2 text-sm text-bone-dim">
          <Spinner className="h-3.5 w-3.5" /> Loading your Studio risk watch settings
        </p>
      ) : error && !status ? (
        <RetryablePanel title="The Studio risk watch settings could not be loaded." detail={error} onRetry={onRetry} />
      ) : (
        <>
          <Toggle
            checked={choice.enabled}
            disabled={saving}
            label="Watch my Studio risk list"
            description={WATCH_SENTENCE}
            onChange={(enabled) => onChange({ enabled, mayTrigger: enabled ? choice.mayTrigger : false })}
          />
          <Toggle
            checked={choice.mayTrigger}
            disabled={saving || !choice.enabled}
            label="Offer crossings as post ideas"
            description={POST_SENTENCE}
            onChange={(mayTrigger) => onChange({ enabled: true, mayTrigger })}
          />
          {saving && (
            <p role="status" className="flex items-center gap-2 text-xs text-bone-dim">
              <Spinner className="h-3.5 w-3.5" /> Saving
            </p>
          )}
          {choice.elsewhere && (
            <p className="break-words text-xs leading-relaxed text-bone-dim">
              This agent is watching your Studio list through another account. Turning it on here moves it to this one.
            </p>
          )}
          {choice.enabled && binding?.lastError && (
            <p className="break-words text-xs leading-relaxed text-signal-fail">{binding.lastError}</p>
          )}
          {choice.enabled && !binding?.lastError && (
            <p className="break-words text-xs leading-relaxed text-bone-faint">
              {binding?.syncedAt ? 'Your Studio list is in sync.' : 'Waiting for the first sync with Studio.'}
              {status && status.pendingObservations > 0 ? ` ${status.pendingObservations} reading(s) waiting to be sent to Studio.` : ''}
            </p>
          )}
          {error && status && <RetryablePanel title="The latest settings could not be refreshed." detail={error} onRetry={onRetry} />}
          {problem && (
            <p role="alert" className="break-words text-sm text-signal-fail">
              {problem}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function StudioRiskWatchesPanel({ agentId, accountId }: { agentId: string; accountId: string }) {
  const path = `/api/agents/${agentId}/studio-risk-watches`;
  const resource = useResource<StudioRiskWatchStatus>(path);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (next: { enabled: boolean; mayTrigger: boolean }) => {
    setSaving(true);
    setProblem(null);
    try {
      await put(path, { accountId, ...next });
      resource.reload();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <StudioRiskWatchesView
      status={resource.data}
      loading={resource.loading}
      error={resource.error}
      saving={saving}
      problem={problem}
      accountId={accountId}
      onRetry={resource.reload}
      onChange={(next) => void save(next)}
    />
  );
}
