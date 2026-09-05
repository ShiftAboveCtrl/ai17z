import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { ErrorPanel, Modal, Spinner } from '@app/components/ui';

export interface ReviewItem {
  eventId: string;
  jobId: string | null;
  agentName: string | null;
  authorHandle: string | null;
  text: string;
  draftText: string | null;
}

/**
 * Deciding on a queue of held replies without opening forty pages.
 *
 * The complaint this answers: with a lot held for review, every one costs a
 * page visit. Reading the draft takes a second and getting to it takes ten, so
 * the navigation *is* the work.
 *
 * Three things make that go away, in order of how much they help:
 *
 *   1. **The draft is in the row.** Nothing to open. This alone removes most
 *      of the cost, because most decisions are obvious once you can see the
 *      text next to what it is answering.
 *   2. **The keyboard.** J and K move, A approves, R rejects, Enter opens the
 *      full job. Triaging forty things with one hand is what mail clients
 *      worked out decades ago.
 *   3. **Selection, for the obvious ones.** Tick several, decide once.
 *
 * ## What is deliberately not made faster
 *
 * Bulk approve shows every draft it is about to send, in full, and names the
 * count in the button. Not a summary and not a number on its own: approving
 * forty messages you have not read is the mistake this screen would otherwise
 * make easy, and it posts them to a real account under somebody's real name.
 *
 * Rejecting has no such confirmation. Nothing is published, and the friction
 * should sit on the side where a mistake is expensive.
 *
 * The server does not trust any of this either -- every job is re-validated
 * against its own policy on the way through, one at a time, exactly as a single
 * approval is.
 */
export function ReviewQueue({ items, onDecided }: { items: ReviewItem[]; onDecided: () => void }) {
  const reviewable = useMemo(() => items.filter((i) => i.jobId), [items]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failures, setFailures] = useState<{ jobId: string; error: string | null }[]>([]);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);

  // A selection that outlives the rows it referred to would approve whatever
  // took their place after a refresh.
  useEffect(() => {
    const alive = new Set(reviewable.map((i) => i.jobId!));
    setSelected((current) => new Set([...current].filter((id) => alive.has(id))));
    setCursor((c) => Math.min(c, Math.max(0, reviewable.length - 1)));
  }, [reviewable]);

  const decide = async (jobIds: string[], decision: 'approve' | 'reject') => {
    if (jobIds.length === 0) return;
    setBusy(true);
    setError(null);
    setFailures([]);
    try {
      const result = await post<{ decided: number; failed: { jobId: string; error: string | null }[] }>(
        '/api/jobs/decide-many',
        { decision, jobIds },
      );
      // Partial success is normal and is reported. "38 of 40" said as a plain
      // success would be a lie about the two.
      if (result.failed.length > 0) setFailures(result.failed);
      setSelected(new Set());
      setConfirming(false);
      onDecided();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Those could not be decided.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (jobId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });

  // Keyboard triage. Ignored while typing, so an edit box does not approve
  // something because it contains the letter A.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (reviewable.length === 0) return;

      const current = reviewable[cursor];
      switch (event.key.toLowerCase()) {
        case 'j':
          setCursor((c) => Math.min(c + 1, reviewable.length - 1));
          break;
        case 'k':
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case 'a':
          if (current?.jobId) void decide([current.jobId], 'approve');
          break;
        case 'r':
          if (current?.jobId) void decide([current.jobId], 'reject');
          break;
        case 'x':
          if (current?.jobId) toggle(current.jobId);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviewable, cursor]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (reviewable.length === 0) return null;

  const chosen = reviewable.filter((i) => selected.has(i.jobId!));
  const allSelected = selected.size === reviewable.length;

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-ink-line bg-ink-raised/40 px-3 py-2">
        <button
          type="button"
          className="btn-quiet"
          onClick={() => setSelected(allSelected ? new Set() : new Set(reviewable.map((i) => i.jobId!)))}
        >
          {allSelected ? 'Clear selection' : `Select all ${reviewable.length}`}
        </button>

        {selected.size > 0 && (
          <>
            <span className="font-mono text-[11px] text-bone-faint">{selected.size} selected</span>
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => setConfirming(true)}>
              <Check className="h-3.5 w-3.5" aria-hidden />
              Approve
            </button>
            <button
              type="button"
              className="btn-quiet hover:text-signal-fail"
              disabled={busy}
              onClick={() => void decide([...selected], 'reject')}
            >
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" aria-hidden />}
              Reject
            </button>
          </>
        )}

        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
          J K move · A approve · R reject · X select
        </span>
      </div>

      {failures.length > 0 && (
        <div className="mt-3 rounded-lg border border-signal-wait/40 bg-signal-wait/[0.06] p-3">
          <p className="text-sm text-bone">{failures.length} could not be decided.</p>
          <ul className="mt-1.5 space-y-1 text-[12px] leading-relaxed text-bone-dim">
            {failures.map((f) => (
              <li key={f.jobId}>{f.error ?? 'No reason given.'}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <ErrorPanel title="That did not work." detail={error} />}

      <ul className="mt-3 space-y-2">
        {reviewable.map((item, index) => (
          <li
            key={item.eventId}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            className={`rounded-lg border px-3 py-2.5 transition-colors ${
              index === cursor ? 'border-signal-calm/50 bg-signal-calm/[0.04]' : 'border-ink-line bg-black/20'
            }`}
          >
            <div className="flex flex-wrap items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-3.5 w-3.5 shrink-0 accent-current"
                checked={selected.has(item.jobId!)}
                onChange={() => toggle(item.jobId!)}
                aria-label={`Select the reply to ${item.authorHandle ? '@' + item.authorHandle : 'this message'}`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[11px] text-bone-faint">
                  {item.agentName ?? 'No agent'}
                  {item.authorHandle && ` · to @${item.authorHandle}`}
                </p>
                <p className="mt-1 break-words text-[13px] leading-relaxed text-bone-dim">{item.text}</p>
                {item.draftText ? (
                  <p className="mt-2 break-words border-l-2 border-signal-calm/40 pl-3 text-sm leading-relaxed text-bone">
                    {item.draftText}
                  </p>
                ) : (
                  <p className="mt-2 text-[12px] text-bone-faint">
                    No draft yet — open it to see where it stopped.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className="btn-quiet"
                  disabled={busy || !item.draftText}
                  onClick={() => void decide([item.jobId!], 'approve')}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  Send
                </button>
                <button
                  type="button"
                  className="btn-quiet hover:text-signal-fail"
                  disabled={busy}
                  onClick={() => void decide([item.jobId!], 'reject')}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/*
        Everything about to be sent, in full. A count on its own would make
        "approve forty messages I have not read" a single click, and these are
        posted publicly under somebody's own name.
      */}
      <Modal open={confirming} onClose={() => setConfirming(false)} title={`Send ${chosen.length} ${chosen.length === 1 ? 'reply' : 'replies'}?`} wide>
        <div className="space-y-4">
          <p className="text-sm text-bone-dim">
            These go out publicly, from the account each agent is connected to. Read them before you send.
          </p>
          <ul className="max-h-[45vh] space-y-2 overflow-y-auto">
            {chosen.map((item) => (
              <li key={item.eventId} className="rounded-lg border border-ink-line p-3">
                <p className="font-mono text-[11px] text-bone-faint">
                  {item.agentName}
                  {item.authorHandle && ` · to @${item.authorHandle}`}
                </p>
                <p className="mt-1.5 break-words text-sm leading-relaxed text-bone">{item.draftText}</p>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={busy}
              onClick={() => void decide([...selected], 'approve')}
            >
              {busy && <Spinner />}
              Send {chosen.length}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
