import { useCallback, useEffect, useState } from 'react';
import { Camera, LogIn, Power, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, artifactObjectUrl, get, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { AccountRow, BrowserTask, DiagnosticRow } from '@app/lib/types';
import { humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { ErrorPanel, Spinner, StatusDot } from './ui';

interface SessionData {
  account: AccountRow;
  session: { mode: 'MANAGED' | 'CDP'; status: string; cdpUrl: string | null; lastCheckedAt: string | null; lastError: string | null } | null;
  recentTasks: BrowserTask[];
  diagnostics: DiagnosticRow[];
}

const ACTIONS = [
  { kind: 'CONNECT', label: 'Connect', icon: Power },
  { kind: 'HEALTH_CHECK', label: 'Test session', icon: RefreshCw },
  { kind: 'OPEN_AUTH', label: 'Open sign-in', icon: LogIn },
  { kind: 'SCREENSHOT', label: 'Capture', icon: Camera },
  { kind: 'CLEAR', label: 'Clear session', icon: Trash2 },
] as const;

/**
 * Session control. Cookies and tokens are never displayed: the panel shows what
 * XBAM knows about the session, not the session itself.
 */
export function SessionPanel({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useResource<SessionData>(`/api/accounts/${accountId}/session`);
  const [pending, setPending] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const run = async (kind: string) => {
    setPending(kind);
    setActionError(null);
    try {
      const task = await post<BrowserTask>(`/api/accounts/${accountId}/session/tasks`, { kind });
      setTaskId(task.id);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'That action could not be started.');
      setPending(null);
    }
  };

  // Browser work runs in the worker, so the panel follows the task to completion.
  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    const poll = async () => {
      try {
        const current = await get<BrowserTask>(`/api/browser-tasks/${taskId}`);
        if (stop) return;
        if (current.status === 'COMPLETED' || current.status === 'FAILED') {
          setPending(null);
          setTaskId(null);
          if (current.status === 'FAILED') setActionError(current.error ?? 'The browser task failed.');
          reload();
          onChanged();
          return;
        }
        setTimeout(poll, 1200);
      } catch {
        if (!stop) setTimeout(poll, 2000);
      }
    };
    const timer = setTimeout(poll, 900);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [taskId, reload, onChanged]);

  const openShot = useCallback(async (artifactId: string) => {
    try {
      setShot(await artifactObjectUrl(artifactId));
    } catch {
      setActionError('That screenshot is no longer on disk.');
    }
  }, []);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorPanel title="Session details could not be loaded." detail={error} />;
  if (!data) return null;

  const browserBacked = data.account.channel === 'x';

  return (
    <div className="space-y-7">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">{data.account.channel}</p>
        <p className="mt-1 text-2xl font-light text-bone">@{data.account.handle}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <StatusDot state={toneFor(data.account.status)} label={humanStatus(data.account.status)} />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
            checked {timeAgo(data.account.lastHealthCheckAt)}
          </span>
        </div>
        {data.account.lastHealthStatus && (
          <p className="mt-3 text-sm leading-relaxed text-bone-dim">{data.account.lastHealthStatus}</p>
        )}
      </div>

      {browserBacked && data.session && (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ink-line bg-ink-line text-sm">
          <div className="bg-ink px-3.5 py-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-bone-faint">Mode</dt>
            <dd className="mt-1 text-bone">{data.session.mode === 'CDP' ? 'Attached over CDP' : 'Managed profile'}</dd>
          </div>
          <div className="bg-ink px-3.5 py-3">
            <dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-bone-faint">Browser</dt>
            <dd className="mt-1 text-bone">{data.session.status}</dd>
          </div>
        </dl>
      )}

      {browserBacked ? (
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map(({ kind, label, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              className={kind === 'CLEAR' ? 'btn-danger' : 'btn-ghost'}
              disabled={Boolean(pending)}
              onClick={() => void run(kind)}
            >
              {pending === kind ? <Spinner className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" aria-hidden />}
              {label}
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-ink-line bg-ink-panel px-4 py-3 text-sm text-bone-dim">
          The mock channel needs no session. Events are injected from the activity view.
        </p>
      )}

      {actionError && <ErrorPanel title="That did not work." detail={actionError} />}

      {data.diagnostics.length > 0 && (
        <div>
          <p className="eyebrow mb-3">Recent diagnostics</p>
          <ul className="space-y-2">
            {data.diagnostics.map((diagnostic) => (
              <li key={diagnostic.id} className="rounded-lg border border-ink-line px-3.5 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{diagnostic.kind}</span>
                  <span className="font-mono text-[10px] text-bone-faint">{timeAgo(diagnostic.createdAt)}</span>
                </div>
                <p className="mt-1.5 text-bone-dim">{diagnostic.message}</p>
                {diagnostic.artifactId && (
                  <button type="button" className="btn-quiet mt-2 px-0 text-xs" onClick={() => void openShot(diagnostic.artifactId!)}>
                    View screenshot
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {shot && (
        <div>
          <img src={shot} alt="Captured browser screenshot" className="w-full rounded-lg border border-ink-line" />
          <button type="button" className="btn-quiet mt-2 px-0 text-xs" onClick={() => setShot(null)}>
            Hide
          </button>
        </div>
      )}
    </div>
  );
}
