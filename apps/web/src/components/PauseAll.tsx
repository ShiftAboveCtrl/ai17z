import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ApiError, put } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';

interface PauseView {
  paused: boolean;
  since: string | null;
  by: string | null;
  reason: string;
}

/**
 * Stopping everything, from wherever somebody is.
 *
 * In the top bar rather than on a settings page, because the moment anybody
 * wants this they want it now and are not going to go looking. The state is
 * polled rather than assumed: another window, or another person, may have
 * thrown it, and a button that says "pause" while everything is already paused
 * is worse than no button.
 *
 * The switch itself is enforced in the runtime immediately before an action
 * executes. This is the handle, not the mechanism.
 */
export function PauseAll() {
  const view = useResource<PauseView>('/api/runtime/pause');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePolling(() => view.reload(), 15_000, true);

  const paused = view.data?.paused ?? false;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await put('/api/runtime/pause', { paused: !paused });
      view.reload();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        title={
          paused
            ? 'Nothing is being sent. Agents keep reading, so nothing is missed.'
            : 'Stop every agent from sending anything, immediately.'
        }
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors ${
          paused
            ? 'border-signal-fail/60 bg-signal-fail/[0.12] text-signal-fail'
            : 'border-ink-line text-bone-faint hover:border-bone-faint hover:text-bone-dim'
        } disabled:opacity-50`}
      >
        {paused && <AlertTriangle className="h-3 w-3" aria-hidden />}
        {paused ? 'All paused' : 'Pause all'}
      </button>
      {/* Unmissable while it is on: the commonest way this goes wrong is
          somebody forgetting they pressed it and wondering why nothing works. */}
      {paused && (
        <span className="hidden text-[11px] text-signal-fail sm:inline">
          Nothing is being sent{view.data?.by ? ` — paused by ${view.data.by}` : ''}.
        </span>
      )}
      {error && <span className="text-[11px] text-signal-fail">{error}</span>}
    </div>
  );
}
