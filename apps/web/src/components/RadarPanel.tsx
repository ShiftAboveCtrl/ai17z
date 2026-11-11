import { useState } from 'react';
import { Plus, Radar, RotateCw, Trash2 } from 'lucide-react';
import { ApiError, del, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { RADAR_SOURCE_KINDS, effectiveXInterval, type RadarSourceKind } from '@xbam/shared/contracts';
import { ErrorPanel, Field, Modal, Spinner, StatusDot } from './ui';
import { SignalRadar, type SignalRadarData } from './SignalRadar';
import type { RadarSourceProvenance, SignalWatch } from '@xbam/shared/contracts';

export interface RadarSource {
  id: string;
  /** Where the source came from, decided by the API and never by the label. */
  provenance: RadarSourceProvenance;
  kind: string;
  target: string | null;
  label: string;
  enabled: boolean;
  status: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'FAILING' | 'DISABLED';
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastResultAt: string | null;
  lastError: string | null;
  /** Why it had nothing to show, when nothing was the honest answer. */
  idleReason: string | null;
  consecutiveFailures: number;
  nextPollAt: string | null;
  config: { intervalSeconds?: number; mayTrigger?: boolean; watches?: SignalWatch[] };
}

interface RadarData {
  supported: string[];
  sources: RadarSource[];
  signals?: SignalRadarData;
}

/** The owner's own market source. `find` on the kind alone would pick a Studio one and let the owner overwrite it. */
export function ownerSignalSource(sources: RadarSource[]): RadarSource | undefined {
  return sources.find((s) => s.kind === 'market_signal' && s.provenance === 'OWNER');
}

const KIND_NAMES: Record<string, string> = {
  notifications: 'Notifications',
  mention_search: 'Mention search',
  reply_search: 'Reply search',
  own_threads: 'Replies to own posts',
  tracked_account: 'Watched account',
  tracked_keyword: 'Watched topic',
  persona_discovery: 'Goes looking on its own',
  market_signal: 'Market and wallet signals',
};

const KIND_HINTS: Record<string, string> = {
  notifications: "The platform's own notifications. One source, not the truth.",
  mention_search: 'Searches for the handle, catching mentions notifications lost.',
  reply_search: 'Searches for replies addressed to this account.',
  own_threads: 'Reads replies underneath recent posts, which often produce no notification.',
  tracked_account: 'Watches an account for context. Watching is not permission to reply.',
  tracked_keyword: 'Watches a keyword, ticker, or custom search query.',
  persona_discovery:
    'Searches X for its own topics once per growth session, only posts people are already responding to, best few kept.',
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

  /** Makes a source due now, for somebody who has just fixed what broke it. */
  const retry = async (id: string) => {
    setBusy(true);
    try {
      await post(`/api/accounts/${accountId}/radar/${id}/retry`, {});
      // The worker picks it up on its next tick, a few seconds out.
      setTimeout(reload, 4_000);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'That could not be retried.');
    } finally {
      setBusy(false);
    }
  };

  const retryAll = async () => {
    setBusy(true);
    try {
      await post(`/api/accounts/${accountId}/radar/retry`, {});
      setTimeout(reload, 4_000);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Those could not be retried.');
    } finally {
      setBusy(false);
    }
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
            <RadarSourceItem key={source.id} source={source} busy={busy} onRetry={() => void retry(source.id)} onRemove={() => void remove(source.id)} />
          ))}
        </ul>
      )}

      {actionError && <p className="break-words text-sm text-signal-fail">{actionError}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-quiet px-0 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Watch an account or topic
        </button>
        {data.sources.some((source) => source.consecutiveFailures > 0) && (
          <button type="button" className="btn-quiet px-0 text-xs" onClick={() => void retryAll()} disabled={busy}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Try all of them again now
          </button>
        )}
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
      {/* The owner's pins are one source; Studio's are several others of the same kind and are not edited here. */}
      <SignalRadar
        key={ownerSignalSource(data.sources)?.id ?? 'new-signals'}
        accountId={accountId}
        source={ownerSignalSource(data.sources)}
        data={data.signals ?? { baselines: [], candidates: [] }}
        reload={reload}
      />
    </div>
  );
}

const STUDIO_FOLLOWS_SENTENCE =
  'This source follows your Studio risk watch link and turns itself back on at every sync. Change the watch in Studio, or switch Studio risk watches off for this agent under Accounts.';
const PLAYBOOK_FOLLOWS_SENTENCE =
  'This source follows the playbook linked to this agent and turns itself back on at every sync. Import a different playbook for the agent to change it.';

/** One monitor. Presentational, so every state can be rendered without a network. */
export function RadarSourceItem({
  source,
  busy,
  onRetry,
  onRemove,
}: {
  source: RadarSource;
  busy: boolean;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const fromStudio = source.provenance === 'STUDIO_RISK_WATCH';
  // Either kind is recreated by a sync, so offering to remove or switch it off would only look like it worked.
  const linked = source.provenance !== 'OWNER';
  return (
    <li className="py-3" data-provenance={source.provenance}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <StatusDot state={source.enabled ? TONE[source.status] ?? 'idle' : 'idle'} />
        <span className="min-w-0 break-words text-sm text-bone">
          {source.label || KIND_NAMES[source.kind] || source.kind}
          {source.target && !linked && <span className="ml-1.5 font-mono text-[11px] text-bone-dim">{source.target}</span>}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
          {source.enabled ? source.status.toLowerCase() : 'off'}
        </span>
        {source.consecutiveFailures > 0 && (
          <button
            type="button"
            className="btn-quiet p-1.5"
            aria-label={`Try ${KIND_NAMES[source.kind] ?? source.kind} again now`}
            title="Try again now"
            onClick={onRetry}
            disabled={busy}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        {!linked && (
          <button
            type="button"
            className="btn-quiet p-1.5 hover:text-signal-fail"
            aria-label={`Remove ${KIND_NAMES[source.kind] ?? source.kind}`}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      {linked && (
        <>
          {fromStudio && <p className="mt-1 text-xs text-signal-calm">From your Studio risk watch list.</p>}
          <p className="mt-1 break-words text-[11px] leading-relaxed text-bone-faint">
            {fromStudio ? STUDIO_FOLLOWS_SENTENCE : PLAYBOOK_FOLLOWS_SENTENCE}
          </p>
        </>
      )}

      <p className="mt-1 font-mono text-[10px] text-bone-faint">
        {/* Worked and found nothing is not the same as failed, so both
            are shown rather than one standing in for the other. */}
        last worked {timeAgo(source.lastSuccessAt)} · last found something {timeAgo(source.lastResultAt)}
        {source.consecutiveFailures > 0 && ` · ${source.consecutiveFailures} failures in a row`}
        {/* A backed-off source is not a stopped one, and saying when it
            tries again is the difference between the two. */}
        {source.consecutiveFailures > 0 && source.nextPollAt && ` · next try ${timeAgo(source.nextPollAt)}`}
      </p>
      <PaceLine kind={source.kind} configured={source.config.intervalSeconds} />
      {source.config.mayTrigger === false && (
        <p className="mt-1 text-[11px] text-bone-faint">Context only. This never creates a reply.</p>
      )}
      {source.lastError && (
        <p className="mt-1 break-words text-xs leading-relaxed text-signal-fail">{source.lastError}</p>
      )}
      {/*
        Why a healthy source has nothing to show.

        A source with no error and no results is ambiguous, and that
        ambiguity hid an eight-day outage behind a green light: the
        replies monitor spent every cycle on something else, reported
        success each time, and read no threads at all. "Checked and
        found nothing" and "there was nothing to check" are different
        facts about an account and only one of them is fine.
      */}
      {!source.lastError && source.idleReason && (
        <p className="mt-1 break-words text-xs leading-relaxed text-bone-dim">{source.idleReason}</p>
      )}
    </li>
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
  const [publishToStudio, setPublishToStudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = supported.filter(
    (k) => k === 'tracked_account' || k === 'tracked_keyword' || k === 'persona_discovery',
  );
  const needsTarget = kind !== 'persona_discovery';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/accounts/${accountId}/radar`, {
        kind,
        target: needsTarget ? target.trim() : null,
        label: '',
        config: { mayTrigger, publishToStudio: kind === 'tracked_keyword' && publishToStudio },
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
        {kind === 'tracked_keyword' && <label className="flex items-start gap-3 text-sm text-bone-dim">
          <input type="checkbox" checked={publishToStudio} onChange={e => setPublishToStudio(e.target.checked)} />
          <span>Share this ticker and source post on Studio. Only exact uppercase ticker pins such as $SOL qualify. The public activity tape and agent permission must also be on. Save this same watch again unchecked to keep future sources private; remove already shared rows with the Studio tape controls.</span>
        </label>}
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

        {needsTarget && (
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
        )}

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

/** A pace in the words an owner uses. */
function paceWords(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * How often this source really checks X.
 *
 * Shown because the platform may have raised it: every source has a fastest
 * pace X tolerates, and a setting below it is quietly not what runs. An owner
 * who set one minute and sees five deserves to be told why.
 */
function PaceLine({ kind, configured }: { kind: string; configured?: number }) {
  if (!(RADAR_SOURCE_KINDS as readonly string[]).includes(kind) || kind === 'persona_discovery' || kind === 'market_signal') return null;
  const pace = effectiveXInterval(kind as RadarSourceKind, configured);
  return (
    <p className="mt-1 text-[11px] text-bone-faint">
      Checks every {paceWords(pace.seconds)}
      {pace.raised && configured !== undefined
        ? ` (set to ${paceWords(configured)}, raised to the fastest pace X tolerates without refusing the account)`
        : ''}
      .
    </p>
  );
}
