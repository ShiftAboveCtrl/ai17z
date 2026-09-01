import { Link } from 'react-router-dom';
import type { MentionRow, MentionState } from '@app/lib/types';
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
};

/** Which monitor saw it, in words rather than column names. */
const MONITOR: Record<string, string> = {
  notifications: 'notifications',
  mention_search: 'mention search',
  reply_search: 'reply search',
  own_threads: 'own thread',
  tracked_account: 'watched account',
  tracked_keyword: 'keyword',
};

export function MentionCard({ mention }: { mention: MentionRow }) {
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
