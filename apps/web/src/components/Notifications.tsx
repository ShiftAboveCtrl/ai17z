import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, Check, Clock, Info } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import { Spinner } from '@app/components/ui';

type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

interface NotificationItem {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  actionLabel: string | null;
  actionHref: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface NotificationView {
  counts: { critical: number; warning: number; info: number };
  worst: Severity | null;
  total: number;
  items: NotificationItem[];
}

const TONE: Record<Severity, { dot: string; text: string; label: string }> = {
  CRITICAL: { dot: 'bg-signal-fail', text: 'text-signal-fail', label: 'Stopped' },
  WARNING: { dot: 'bg-signal-warn', text: 'text-signal-warn', label: 'Degraded' },
  INFO: { dot: 'bg-bone-faint', text: 'text-bone-faint', label: 'Note' },
};

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * What is wrong with the installation, in the bar on every page.
 *
 * Deliberately separate from the inbox. The inbox is work waiting for an
 * answer; this is the installation being unable to do work at all, and the two
 * fail in opposite directions -- an account locked out of X produces no job, so
 * the screen built out of jobs is exactly where that problem is invisible.
 *
 * The badge carries the worst severity rather than only a count, because "3"
 * reads the same whether it is three notes or an account nobody can post from.
 */
export function Notifications() {
  const view = useResource<NotificationView>('/api/notifications');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  usePolling(() => view.reload(), 30_000, true);

  // Closing on an outside click or Escape, because a panel that traps somebody
  // in it is worse than one they have to press twice.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const data = view.data;
  const worst = data?.worst ?? null;
  const total = data?.total ?? 0;

  const needs = total === 1 ? '1 thing needs you' : `${total} things need you`;

  const clear = async (id: string, mute: boolean) => {
    setBusy(id);
    setError(null);
    try {
      await post(`/api/notifications/${id}/acknowledge`, { mute });
      view.reload();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'That could not be cleared.');
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    setBusy('all');
    setError(null);
    try {
      await post('/api/notifications/acknowledge-all');
      view.reload();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Those could not be cleared.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label={total === 0 ? 'Nothing needs you' : needs}
        title={total === 0 ? 'Nothing needs you' : needs}
        className={`relative inline-flex items-center rounded-lg border px-2 py-1.5 transition-colors ${
          worst === 'CRITICAL'
            ? 'border-signal-fail/60 bg-signal-fail/[0.12] text-signal-fail'
            : worst === 'WARNING'
              ? 'border-signal-warn/50 text-signal-warn'
              : 'border-ink-line text-bone-faint hover:border-bone-faint hover:text-bone-dim'
        }`}
      >
        <Bell className="h-4 w-4" aria-hidden />
        {total > 0 && (
          <span className="ml-1.5 font-mono text-[10px] tabular-nums">{total > 99 ? '99+' : total}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-ink-line bg-ink-panel shadow-xl">
          <div className="flex items-center justify-between border-b border-ink-line px-4 py-3">
            <p className="eyebrow">Needs you</p>
            {total > 0 && (
              <button type="button" className="btn-quiet px-2 py-1 text-[11px]" onClick={() => void clearAll()} disabled={busy === 'all'}>
                {busy === 'all' && <Spinner />}
                Clear all
              </button>
            )}
          </div>

          {error && <p className="break-words px-4 py-2 text-[12px] text-signal-fail">{error}</p>}

          {total === 0 ? (
            <p className="px-4 py-6 text-[13px] leading-relaxed text-bone-faint">
              Nothing needs you. Mentions waiting for an answer are in the inbox.
            </p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-ink-line overflow-y-auto">
              {data?.items.map((item) => {
                const tone = TONE[item.severity];
                return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-[13px] font-medium leading-snug text-bone">{item.title}</p>
                        {item.body && (
                          <p className="mt-1 break-words text-[12px] leading-relaxed text-bone-faint">{item.body}</p>
                        )}
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-faint">
                          <span className={tone.text}>{tone.label}</span>
                          <span aria-hidden>·</span>
                          <span>{ago(item.lastSeenAt)}</span>
                          {/* How many times, because once and forty times are
                              different problems with the same words. */}
                          {item.occurrences > 1 && (
                            <>
                              <span aria-hidden>·</span>
                              <span>{item.occurrences} times</span>
                            </>
                          )}
                        </p>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {item.actionHref && (
                            <Link
                              to={item.actionHref}
                              onClick={() => setOpen(false)}
                              className="btn-ghost px-2.5 py-1 text-[11px]"
                            >
                              {item.actionLabel ?? 'Open'}
                            </Link>
                          )}
                          <button
                            type="button"
                            className="btn-quiet px-2 py-1 text-[11px]"
                            onClick={() => void clear(item.id, false)}
                            disabled={busy === item.id}
                            title="Clear it. If it happens again you will be told again."
                          >
                            {busy === item.id ? <Spinner /> : <Check className="h-3 w-3" aria-hidden />}
                            Clear
                          </button>
                          <button
                            type="button"
                            className="btn-quiet px-2 py-1 text-[11px]"
                            onClick={() => void clear(item.id, true)}
                            disabled={busy === item.id}
                            title="Clear it and stop telling me for four hours. There is no permanent silence."
                          >
                            <Clock className="h-3 w-3" aria-hidden />
                            Not now
                          </button>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="border-t border-ink-line px-4 py-2.5 text-[11px] leading-relaxed text-bone-faint">
            {worst === 'CRITICAL' ? (
              <span className="inline-flex items-center gap-1.5 text-signal-fail">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                Something here stops an agent working until you deal with it.
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Info className="h-3 w-3" aria-hidden />
                Problems that fix themselves clear on their own.
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
