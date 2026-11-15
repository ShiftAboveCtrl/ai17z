import { useState } from 'react';
import { ApiError, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { RetryablePanel, Spinner, Toggle } from './ui';

export interface StudioCoinAlertStatus {
  binding: {
    accountId: string;
    enabled: boolean;
    confirmedAt: string | null;
    lastError: string | null;
    watching: number;
    skipped: Array<{ index: number; reason: string }>;
  } | null;
}

export const COIN_ALERTS_SENTENCE =
  'Watch the coins on your own Studio coin alerts. This account searches X for one of those coins every few minutes, inside its usual X reading budget, so a longer list never means more reads. Only the coin addresses come from Studio, and nothing is sent back. What it finds is noticed, never answered on its own.';

/** What an owner has chosen for this account. Another account holding the binding counts as off here. */
export function coinAlertChoiceFor(status: StudioCoinAlertStatus | null, accountId: string): { enabled: boolean; elsewhere: boolean } {
  const binding = status?.binding;
  if (!binding?.enabled) return { enabled: false, elsewhere: false };
  if (binding.accountId !== accountId) return { enabled: false, elsewhere: true };
  return { enabled: true, elsewhere: false };
}

/** Presentational, so each state renders without a network. */
export function StudioCoinAlertsView({
  status,
  loading,
  error,
  saving,
  problem,
  accountId,
  onRetry,
  onChange,
}: {
  status: StudioCoinAlertStatus | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  problem: string | null;
  accountId: string;
  onRetry: () => void;
  onChange: (enabled: boolean) => void;
}) {
  const choice = coinAlertChoiceFor(status, accountId);
  const binding = status?.binding;
  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-ink-line bg-ink-panel p-4" aria-label="Studio coin alerts">
      <h3 className="text-sm font-medium text-bone">Studio coin alerts</h3>
      {loading && !status ? (
        <p role="status" className="flex items-center gap-2 text-sm text-bone-dim">
          <Spinner className="h-3.5 w-3.5" /> Loading your Studio coin alert settings
        </p>
      ) : error && !status ? (
        <RetryablePanel title="The Studio coin alert settings could not be loaded." detail={error} onRetry={onRetry} />
      ) : (
        <>
          <Toggle
            checked={choice.enabled}
            disabled={saving}
            label="Watch my Studio coin alerts"
            description={COIN_ALERTS_SENTENCE}
            onChange={onChange}
          />
          {saving && (
            <p role="status" className="flex items-center gap-2 text-xs text-bone-dim">
              <Spinner className="h-3.5 w-3.5" /> Saving
            </p>
          )}
          {choice.elsewhere && (
            <p className="break-words text-xs leading-relaxed text-bone-dim">
              This agent is watching your Studio coin alerts through another account. Turning it on here moves it to this one.
            </p>
          )}
          {choice.enabled && binding?.lastError && (
            <p className="break-words text-xs leading-relaxed text-signal-fail">{binding.lastError}</p>
          )}
          {choice.enabled && !binding?.lastError && (
            <p className="break-words text-xs leading-relaxed text-bone-faint">
              {binding?.confirmedAt ? `Watching ${binding.watching} coin(s) from your Studio alerts.` : 'Waiting for the first sync with Studio.'}
              {binding && binding.skipped.length > 0 ? ` ${binding.skipped.length} alert(s) were skipped.` : ''}
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

export function StudioCoinAlertsPanel({ agentId, accountId }: { agentId: string; accountId: string }) {
  const path = `/api/agents/${agentId}/studio-coin-alerts`;
  const resource = useResource<StudioCoinAlertStatus>(path);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (enabled: boolean) => {
    setSaving(true);
    setProblem(null);
    try {
      await put(path, { accountId, enabled });
      resource.reload();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <StudioCoinAlertsView
      status={resource.data}
      loading={resource.loading}
      error={resource.error}
      saving={saving}
      problem={problem}
      accountId={accountId}
      onRetry={resource.reload}
      onChange={(enabled) => void save(enabled)}
    />
  );
}
