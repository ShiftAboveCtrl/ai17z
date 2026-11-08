import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ExternalLink, ShieldAlert } from 'lucide-react';
import { clockTime, timeAgo } from '@app/lib/format';
import { EmptyState, StatusDot } from '@app/components/ui';
import {
  ACTOR_WORDS,
  KIND_WORDS,
  STATUS_WORDS,
  refusalSentences,
  statusTone,
  type DevUpdate,
  type DevUpdateStatus,
  type RefusalRecord,
} from '@app/lib/devUpdates';

type Entry = { type: 'update'; at: string; update: DevUpdate } | { type: 'refusal'; at: string; refusal: RefusalRecord };

type Filter = 'ALL' | 'OUT' | 'MOVING' | 'STOPPED';

const FILTERS: { id: Filter; label: string; statuses: DevUpdateStatus[] | null; refusals: boolean }[] = [
  { id: 'ALL', label: 'Everything', statuses: null, refusals: true },
  { id: 'OUT', label: 'Posted or rehearsed', statuses: ['PUBLISHED', 'REHEARSED'], refusals: false },
  { id: 'MOVING', label: 'Still moving', statuses: ['PENDING_REVIEW', 'APPROVED', 'DISPATCHED'], refusals: false },
  { id: 'STOPPED', label: 'Refused or stopped', statuses: ['REJECTED', 'FAILED', 'CANCELLED', 'SKIPPED'], refusals: true },
];

/**
 * Everything this project was sent and what became of it, newest first.
 *
 * Refusals are here too, from the audit log, because "I shared something and
 * nothing happened" is the question this screen most needs to answer. A
 * refusal keeps only its reasons: the words that were refused were never
 * stored, and this is not the place that starts.
 */
export function Log({ updates, refusals }: { updates: DevUpdate[]; refusals: RefusalRecord[] }) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const active = FILTERS.find((f) => f.id === filter)!;
  const entries: Entry[] = [
    ...updates
      .filter((u) => !active.statuses || active.statuses.includes(u.status))
      .map((update) => ({ type: 'update' as const, at: update.createdAt, update })),
    ...(active.refusals ? refusals.map((refusal) => ({ type: 'refusal' as const, at: refusal.at, refusal })) : []),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={f.id === filter}
            onClick={() => setFilter(f.id)}
            className={`min-h-[36px] rounded-full border px-3.5 py-1.5 text-[12px] transition-colors ${
              f.id === filter ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint hover:text-bone'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={filter === 'ALL' ? 'Nothing has been sent yet' : 'Nothing here'}
          detail={
            filter === 'ALL'
              ? 'Every update your coding assistant sends is listed here with where it is and why, including the ones AI17Z refused.'
              : 'Nothing in this project matches. Choose Everything to see the whole history.'
          }
        />
      ) : (
        <ol className="space-y-2.5">
          {entries.map((entry) =>
            entry.type === 'update' ? (
              <li key={entry.update.id}>
                <UpdateRow update={entry.update} />
              </li>
            ) : (
              <li key={`refusal-${entry.refusal.id}`}>
                <RefusalRow refusal={entry.refusal} />
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function UpdateRow({ update }: { update: DevUpdate }) {
  const scrubbed = update.title === '';
  return (
    <details className="group panel overflow-hidden">
      <summary className="flex cursor-pointer list-none flex-col gap-2 p-4 hover:bg-white/[0.015] sm:flex-row sm:items-start sm:justify-between sm:gap-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusDot state={statusTone(update.status)} label={STATUS_WORDS[update.status]} />
            <span className="font-mono text-[11px] text-bone-dim">
              {KIND_WORDS[update.kind] ?? update.kind} · {timeAgo(update.createdAt)}
            </span>
          </span>
          <span className={`block break-words text-[15px] ${scrubbed ? 'italic text-bone-dim' : 'text-bone'}`}>
            {scrubbed ? 'Words deleted when it was rejected' : update.title}
          </span>
          {update.reason && <span className="block break-words text-[13px] leading-relaxed text-bone-dim">{update.reason}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[12px]">
          {update.url && (
            <a
              href={update.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex min-h-[32px] items-center gap-1.5 text-bone underline-offset-4 hover:underline"
            >
              See the post <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          <span className="inline-flex min-h-[32px] items-center gap-1 text-bone-dim">
            <span className="group-open:hidden">Details</span>
            <span className="hidden group-open:inline">Hide</span>
            <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 ease-stage group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
          </span>
        </span>
      </summary>

      <div className="space-y-4 border-t border-ink-line px-4 pb-4 pt-4">
        {!scrubbed && update.post && (
          <div>
            <p className="eyebrow text-bone-dim">{update.edited ? 'The post, as you edited it' : 'The post'}</p>
            <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-ink-line bg-ink px-3.5 py-3 text-sm leading-relaxed text-bone">
              {update.post}
            </p>
          </div>
        )}
        <div>
          <p className="eyebrow text-bone-dim">What happened</p>
          <ol className="mt-2 space-y-0">
            {update.history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="relative flex gap-3 pb-3 last:pb-0">
                <span className="relative flex w-3 shrink-0 justify-center" aria-hidden>
                  <span className={`mt-1.5 h-2 w-2 rounded-full ${i === update.history.length - 1 ? 'bg-signal-calm' : 'bg-bone-faint'}`} />
                  {i < update.history.length - 1 && <span className="absolute top-4 h-[calc(100%-0.5rem)] w-px bg-ink-line" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] text-bone-dim">
                    <span className="text-bone-dim">{ACTOR_WORDS[h.actor]}</span> · {STATUS_WORDS[h.status]} ·{' '}
                    <time dateTime={h.at}>{clockTime(h.at)}</time>
                  </span>
                  <span className="block break-words text-[13px] leading-relaxed text-bone-dim">{h.reason}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        {update.jobId && (
          <Link to={`/jobs/${update.jobId}`} className="inline-block text-[12px] text-bone underline-offset-4 hover:underline">
            See what the agent did with it
          </Link>
        )}
      </div>
    </details>
  );
}

function RefusalRow({ refusal }: { refusal: RefusalRecord }) {
  const said = refusalSentences(refusal);
  return (
    <div className="flex gap-3 rounded-xl border border-dashed border-signal-fail/30 bg-signal-fail/[0.03] p-4">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-signal-fail" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-3 text-[15px] text-bone">
          Refused, nothing was kept
          <span className="font-mono text-[11px] text-bone-dim">{timeAgo(refusal.at)}</span>
        </p>
        <ul className="space-y-0.5 text-[13px] leading-relaxed text-bone-dim">
          {said.reasons.map((r) => (
            <li key={r} className="break-words">
              {r}
            </li>
          ))}
        </ul>
        {said.where && <p className="text-xs text-bone-dim">{said.where} Your assistant was told which rule, so it can rewrite and send again.</p>}
      </div>
    </div>
  );
}
