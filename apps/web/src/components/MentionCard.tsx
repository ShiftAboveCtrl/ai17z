import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MentionRow, MentionState } from '@app/lib/types';
import { ApiError, post } from '@app/lib/api';
import { timeAgo } from '@app/lib/format';
import { StatusDot } from './ui';

/**
 * How each outcome reads and what colour it carries.
 *
 * The job status behind these is the machine's vocabulary -- eighteen values,
 * several of which only differ by which step is running. Somebody looking at an
 * inbox is asking one question: did this person get an answer.
 */
const STATE: Record<MentionState, { label: string; tone: 'live' | 'wait' | 'fail' | 'idle' }> = {
  REPLIED: { label: 'Replied', tone: 'live' },
  WORKING: { label: 'Working on it', tone: 'live' },
  NEEDS_REVIEW: { label: 'Waiting for you', tone: 'wait' },
  DECLINED: { label: 'Left alone', tone: 'idle' },
  FAILED: { label: 'Failed', tone: 'fail' },
  DRY_RUN: { label: 'Rehearsed', tone: 'idle' },
  NOT_ACTIONED: { label: 'Not picked up', tone: 'idle' },
  FILTERED: { label: 'Filtered as spam', tone: 'idle' },
};

/** Which monitor saw it, in words rather than column names. */
const MONITOR: Record<string, string> = {
  notifications: 'notifications',
  mention_search: 'mention search',
  reply_search: 'reply search',
  own_threads: 'own thread',
  tracked_account: 'watched account',
  tracked_keyword: 'keyword',
  persona_discovery: 'its own search',
};

/**
 * Spam or not, for this one post, and whether to keep its author out of the
 * agent's attention. Marking spam applies to this post only; it never blocks
 * anybody the post mentioned.
 */
function SpamControls({ mention, onChanged }: { mention: MentionRow; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const act = (run: () => Promise<unknown>, done: string) => async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setBusy(true);
    setNote(null);
    try {
      await run();
      setNote(done);
      onChanged?.();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  const isSpam = mention.state === 'FILTERED' || mention.spamVerdict === 'SPAM';
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
      {isSpam ? (
        <button
          type="button"
          className="btn-quiet px-0"
          disabled={busy}
          onClick={act(() => post(`/api/events/${mention.eventId}/spam`, { label: 'NOT_SPAM' }), 'Marked not spam, and offered to the agent.')}
        >
          Not spam
        </button>
      ) : (
        <button
          type="button"
          className="btn-quiet px-0"
          disabled={busy}
          onClick={act(() => post(`/api/events/${mention.eventId}/spam`, { label: 'SPAM' }), 'Marked as spam. Only this post.')}
        >
          Mark as spam
        </button>
      )}
      {mention.accountId && mention.authorHandle && (
        <button
          type="button"
          className="btn-quiet px-0"
          disabled={busy}
          onClick={act(
            () => post(`/api/accounts/${mention.accountId}/spam-actors`, { handle: mention.authorHandle, muted: true }),
            `@${mention.authorHandle} is muted from the agent's attention.`,
          )}
        >
          Mute @{mention.authorHandle}
        </button>
      )}
      {note && <span className="text-bone-faint">{note}</span>}
    </div>
  );
}

export function MentionCard({ mention, showAgent = false, onChanged }: { mention: MentionRow; showAgent?: boolean; onChanged?: () => void }) {
  const state = STATE[mention.state];
  // Somebody continuing a conversation and somebody arriving for the first time
  // need completely different reading, and the difference is not in the text.
  const ongoing = mention.ourTurns > 0;
  const newcomer = mention.priorFromPerson === 0;

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone">
          @{mention.authorHandle ?? 'unknown'}
        </span>
        {/*
          Which agent this is. Only when the list spans more than one, because
          on a single-agent list it is noise.

          Two agents can legitimately each hold their own event for the same X
          post, since `events` is unique on (channel, account, remote id). Two
          rows for one post is correct and reads as a glitch without this.
        */}
        {showAgent && mention.agentName && (
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">
            {mention.agentName}
          </span>
        )}
        {ongoing ? (
          <span className="chip">
            in conversation · {mention.ourTurns} {mention.ourTurns === 1 ? 'reply' : 'replies'} from you
          </span>
        ) : newcomer ? (
          <span className="chip">first time</span>
        ) : (
          <span className="chip">seen {mention.priorFromPerson}× before</span>
        )}
        <span className="ml-auto flex items-center gap-4">
          <StatusDot state={state.tone} label={state.label} />
          <span className="font-mono text-[10px] text-bone-faint">{timeAgo(mention.ingestedAt)}</span>
        </span>
      </div>

      {/*
        Only where there is something to decide. A settled row needs no
        advice, and a priority chip on everything would teach an owner to
        ignore it.
      */}
      {mention.triage && (mention.triage.suggestion === 'ANSWER' || mention.triage.suggestion === 'REVIEW') && (
        <p className="mt-3 break-words text-sm text-bone-dim" title={mention.triage.factors.map((f) => f.reason).join(' ')}>
          {mention.triage.priority === 'HIGH' && <span className="chip mr-2">priority</span>}
          {mention.triage.summary}
        </p>
      )}

      <p className="mt-4 line-clamp-4 break-words text-lg font-light leading-snug text-bone">
        {mention.text || '(no text)'}
      </p>

      {mention.replyText && (
        <div className="mt-5 border-l-2 border-signal-calm/40 pl-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">You said</p>
          <p className="mt-1.5 line-clamp-3 break-words text-[15px] leading-relaxed text-bone-dim">
            {mention.replyText}
          </p>
        </div>
      )}

      {/*
        The reasons, not the score. "Reply value 18" tells nobody whether the
        decision was right; "nothing to do with what this agent follows" does.
      */}
      {mention.state === 'DECLINED' && mention.decision && (
        <p className="mt-4 break-words text-sm text-bone-faint">{mention.decision.reason}</p>
      )}

      {mention.state === 'FILTERED' && (
        <p className="mt-4 break-words text-sm text-bone-faint">
          Kept out of the agent's attention: {(mention.spamReasons ?? []).join(' ') || 'it looked like spam.'} No thread was read and
          no model was asked.
        </p>
      )}

      {mention.state === 'NOT_ACTIONED' && (
        <p className="mt-4 break-words text-sm text-bone-faint">
          Recorded, but nothing was queued for it. Usually the agent is monitor-only, or the account link is not
          triggered by a {mention.type.toLowerCase()}.
        </p>
      )}

      <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
        {mention.foundBy.length > 0
          ? `found by ${mention.foundBy.map((k) => MONITOR[k] ?? k).join(', ')}`
          : 'no monitor recorded'}
      </p>
      <SpamControls mention={mention} onChanged={onChanged} />
    </>
  );

  const shell =
    'block rounded-2xl border border-ink-line bg-ink-raised/70 p-6 backdrop-blur-sm transition-colors sm:p-8';

  return mention.jobId ? (
    <Link to={`/jobs/${mention.jobId}`} className={`${shell} hover:border-bone-faint/40`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
