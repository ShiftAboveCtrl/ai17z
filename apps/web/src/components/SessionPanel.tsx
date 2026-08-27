import { useCallback, useEffect, useState } from 'react';
import { Camera, LogIn, Power, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, artifactObjectUrl, get, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import type { AccountRow, BrowserTask, DiagnosticRow } from '@app/lib/types';
import { humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { ErrorPanel, Field, SavedTick, Spinner, StatusDot } from './ui';

interface SessionData {
  account: AccountRow;
  session: {
    mode: 'MANAGED' | 'CDP';
    channel: 'chrome' | 'msedge' | 'chromium';
    status: string;
    cdpUrl: string | null;
    lastCheckedAt: string | null;
    lastError: string | null;
  } | null;
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
 * AI17Z knows about the session, not the session itself.
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

      {browserBacked && <BrowserConfig accountId={accountId} session={data.session} onSaved={reload} />}

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

const CHANNELS = [
  { value: 'chrome', label: 'Real Chrome', hint: 'Drives the Chrome installed on the machine running the worker.' },
  { value: 'msedge', label: 'Real Edge', hint: 'Drives the installed Microsoft Edge.' },
  { value: 'chromium', label: 'Bundled Chromium', hint: 'The build Playwright ships. This is what the container has.' },
] as const;

/**
 * Browser configuration for an account.
 *
 * Managed mode owns a persistent profile: you sign in once through Open sign-in
 * and the session lives in that profile. CDP mode attaches to a browser you
 * started yourself, which is the route when the session must be one you already
 * have open.
 */
function BrowserConfig({
  accountId,
  session,
  onSaved,
}: {
  accountId: string;
  session: SessionData['session'];
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<'MANAGED' | 'CDP'>(session?.mode ?? 'MANAGED');
  const [channel, setChannel] = useState<string>(session?.channel ?? 'chromium');
  const [cdpUrl, setCdpUrl] = useState(session?.cdpUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(session?.mode ?? 'MANAGED');
    setChannel(session?.channel ?? 'chromium');
    setCdpUrl(session?.cdpUrl ?? '');
  }, [session?.mode, session?.channel, session?.cdpUrl]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/accounts/${accountId}`, { browser: { mode, channel, cdpUrl } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That configuration could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-ink-line bg-ink-panel/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Browser</p>
        <span className="font-mono text-[10px] text-bone-faint">{session?.status ?? 'unknown'}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(['MANAGED', 'CDP'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
              mode === option ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'
            }`}
          >
            <span className="block">{option === 'MANAGED' ? 'Managed profile' : 'Attach over CDP'}</span>
            <span className="mt-0.5 block text-[11px] leading-snug text-bone-faint">
              {option === 'MANAGED' ? 'AI17Z launches and owns the browser' : 'AI17Z attaches to one you started'}
            </span>
          </button>
        ))}
      </div>

      {mode === 'MANAGED' ? (
        <Field label="Browser build" htmlFor="bchannel" hint={CHANNELS.find((c) => c.value === channel)?.hint}>
          <select id="bchannel" className="field" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field
          label="CDP URL"
          htmlFor="bcdp"
          hint="Start the browser yourself with --remote-debugging-port, then point AI17Z at it. It must be reachable from wherever the worker runs."
        >
          <input
            id="bcdp"
            className="field font-mono text-[13px]"
            value={cdpUrl}
            onChange={(e) => setCdpUrl(e.target.value)}
            placeholder="http://127.0.0.1:9222"
          />
        </Field>
      )}

      {error && <p className="text-sm text-signal-fail">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="button" className="btn-ghost" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Save browser settings
        </button>
        <SavedTick visible={saved} />
      </div>
    </div>
  );
}
