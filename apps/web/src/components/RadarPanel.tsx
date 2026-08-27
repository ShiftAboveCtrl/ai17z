import { useState } from 'react';
import { Plus, Radar, Trash2 } from 'lucide-react';
import { ApiError, del, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { ErrorPanel, Field, Modal, Spinner, StatusDot } from './ui';

interface RadarSource {
  id: string;
  kind: string;
  target: string | null;
  label: string;
  enabled: boolean;
  status: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'DISABLED';
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastResultAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  config: { intervalSeconds?: number; mayTrigger?: boolean };
}

interface RadarData {
  supported: string[];
  sources: RadarSource[];
}

const KIND_NAMES: Record<string, string> = {
  notifications: 'Notifications',
  mention_search: 'Mention search',
  reply_search: 'Reply search',
  own_threads: 'Replies to own posts',
  tracked_account: 'Watched account',
  tracked_keyword: 'Watched topic',
};

const KIND_HINTS: Record<string, string> = {
  notifications: "The platform's own notifications. One source, not the truth.",
  mention_search: 'Searches for the handle, catching mentions notifications lost.',
  reply_search: 'Searches for replies addressed to this account.',
  own_threads: 'Reads replies underneath recent posts, which often produce no notification.',
  tracked_account: 'Watches an account for context. Watching is not permission to reply.',
  tracked_keyword: 'Watches a keyword, ticker, or custom search query.',
};

const TONE: Record<string, 'live' | 'wait' | 'fail' | 'idle'> = {
  HEALTHY: 'live',
  DEGRADED: 'wait',
  FAILING: 'fail',
  UNKNOWN: 'idle',
  DISABLED: 'idle',
};

/**
 * Social Radar.
 *
 * Health is shown per source on purpose. The failure this replaced was an
 * account reporting healthy while the single surface it depended on had been
 * failing for an hour, and nobody could see it.
 */
export function RadarPanel({ accountId }: { accountId: string }) {
  const { data, error, loading, reload } = useResource<RadarData>(`/api/accounts/${accountId}/radar`);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorPanel title="The radar could not be loaded." detail={error} />;
  if (!data) return null;
  if (data.supported.length === 0) return null;

  const enableDefaults = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/api/accounts/${accountId}/radar/defaults`);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Those monitors could not be turned on.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await del(`/api/accounts/${accountId}/radar/${id}`).catch(() => undefined);
    reload();
  };

  return (
    <div className="space-y-4 rounded-lg border border-ink-line bg-ink-panel/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Social radar</p>
        <span className="font-mono text-[10px] text-bone-faint">
          {data.sources.filter((s) => s.enabled).length} of {data.sources.length} on
        </span>
      </div>

      {data.sources.length === 0 ? (
        <div className="rounded-lg border border-ink-line px-3.5 py-3">
          <p className="text-sm text-bone">This account is only watching notifications.</p>
          <p className="mt-1 text-xs leading-relaxed text-bone-faint">
            X notifications drop things. Adding a mention search, a reply search, and a walk of recent threads means
            a missed notification is no longer a missed mention.
          </p>
          <button type="button" className="btn-ghost mt-3" onClick={() => void enableDefaults()} disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Radar className="h-3.5 w-3.5" aria-hidden />}
            Turn on the standard monitors
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-ink-line border-y border-ink-line">
          {data.sources.map((source) => (
            <li key={source.id} className="py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <StatusDot state={source.enabled ? TONE[source.status] ?? 'idle' : 'idle'} />
                <span className="text-sm text-bone">
                  {source.label || KIND_NAMES[source.kind] || source.kind}
                  {source.target && <span className="ml-1.5 font-mono text-[11px] text-bone-dim">{source.target}</span>}
                </span>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
                  {source.enabled ? source.status.toLowerCase() : 'off'}
                </span>
                <button
                  type="button"
                  className="btn-quiet p-1.5 hover:text-signal-fail"
                  aria-label={`Remove ${KIND_NAMES[source.kind] ?? source.kind}`}
                  onClick={() => void remove(source.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>

              <p className="mt-1 font-mono text-[10px] text-bone-faint">
                {/* Worked and found nothing is not the same as failed, so both
                    are shown rather than one standing in for the other. */}
                last worked {timeAgo(source.lastSuccessAt)} · last found something {timeAgo(source.lastResultAt)}
                {source.consecutiveFailures > 0 && ` · ${source.consecutiveFailures} failures in a row`}
              </p>
              {source.config.mayTrigger === false && (
                <p className="mt-1 text-[11px] text-bone-faint">Context only — this never creates a reply.</p>
              )}
              {source.lastError && (
                <p className="mt-1 break-words text-xs leading-relaxed text-signal-fail">{source.lastError}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {actionError && <p className="break-words text-sm text-signal-fail">{actionError}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-quiet px-0 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Watch an account or topic
        </button>
        {data.sources.length > 0 && (
          <button type="button" className="btn-quiet px-0 text-xs" onClick={() => void enableDefaults()} disabled={busy}>
            Restore the standard monitors
          </button>
        )}
      </div>

      <AddWatchModal
        open={adding}
        supported={data.supported}
        accountId={accountId}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          reload();
        }}
      />
    </div>
  );
}

function AddWatchModal({
  open,
  supported,
  accountId,
  onClose,
  onSaved,
}: {
  open: boolean;
  supported: string[];
  accountId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState('tracked_account');
  const [target, setTarget] = useState('');
  const [mayTrigger, setMayTrigger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = supported.filter((k) => k === 'tracked_account' || k === 'tracked_keyword');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/accounts/${accountId}/radar`, {
        kind,
        target: target.trim(),
        label: '',
        config: { mayTrigger },
      });
      setTarget('');
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Watch something">
      <div className="space-y-5">
        <Field label="What kind">
          <div className="grid grid-cols-2 gap-2">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={`rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${
                  kind === option
                    ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                    : 'border-ink-line text-bone-dim hover:border-bone-faint'
                }`}
              >
                <span className="block">{KIND_NAMES[option]}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-bone-faint">{KIND_HINTS[option]}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field
          label={kind === 'tracked_account' ? 'Handle' : 'Keyword or query'}
          htmlFor="rtarget"
          hint={kind === 'tracked_account' ? 'Without the @.' : 'A word, a ticker, or a full X search query.'}
        >
          <input
            id="rtarget"
            className="field"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={kind === 'tracked_account' ? 'someone' : 'project name'}
          />
        </Field>

        <label className="flex items-start gap-3 rounded-lg border border-ink-line px-3.5 py-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={mayTrigger}
            onChange={(e) => setMayTrigger(e.target.checked)}
          />
          <span>
            <span className="block text-sm text-bone">Let this create replies</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-bone-faint">
              Off by default. Watching something is worth doing for context alone, and turning this on means the agent
              may act on anything it finds here.
            </span>
          </span>
        </label>

        {error && <p className="break-words text-sm text-signal-fail">{error}</p>}

        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => void save()}
          disabled={busy || !target.trim()}
        >
          {busy && <Spinner />}
          Watch it
        </button>
      </div>
    </Modal>
  );
}
