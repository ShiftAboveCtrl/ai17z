import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolling, useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, ErrorPanel, Loading, StatusDot } from '@app/components/ui';
import { Explain } from '@app/components/Explain';
import { ReviewQueue } from '@app/components/ReviewQueue';

type Bucket = 'NEEDS_REVIEW' | 'QUESTIONS' | 'MENTIONS' | 'REPLIES' | 'OUTREACH' | 'ERRORS';

interface InboxItem {
  eventId: string;
  agentId: string | null;
  agentName: string | null;
  type: string;
  authorHandle: string | null;
  text: string;
  url: string | null;
  ingestedAt: string;
  state: string;
  jobId: string | null;
  errorClass: string | null;
  draftText: string | null;
  replyText: string | null;
  replyUrl: string | null;
  repliedAt: string | null;
  bucket: Bucket;
}

interface InboxView {
  counts: Record<Bucket, number>;
  items: InboxItem[];
}

/** In the order somebody would work through them: what needs doing, then what happened. */
const ORDER: Bucket[] = ['NEEDS_REVIEW', 'ERRORS', 'QUESTIONS', 'MENTIONS', 'REPLIES', 'OUTREACH'];

const WORDS: Record<Bucket, string> = {
  NEEDS_REVIEW: 'Needs you',
  ERRORS: 'Failed',
  QUESTIONS: 'Questions',
  MENTIONS: 'Mentions',
  REPLIES: 'Replies',
  OUTREACH: 'Outreach',
};

/** What each bucket is for, so the word above the list is not the only clue. */
const LEDE: Record<Bucket, string> = {
  NEEDS_REVIEW: 'Held for you to decide. Nothing moves until you do.',
  ERRORS: 'Tried and did not work. The reason is on each one.',
  QUESTIONS: 'Somebody asked something and has not been answered.',
  MENTIONS: 'Addressed to one of your agents.',
  REPLIES: 'Somebody answered your agent, in a conversation it is already in.',
  OUTREACH: 'Posts an agent went looking for rather than was sent.',
};

/**
 * One place to operate every agent an owner has.
 *
 * Deliberately not the Activity table with filters on it. Activity answers
 * "what occurred"; this answers "what do I need to do", and those are different
 * lists -- a reply that went out perfectly is the most interesting row in a log
 * and the least interesting thing here.
 *
 * Buckets are ordered by what somebody would work through, not by volume: the
 * two with actions in them come first even when they are empty, because an
 * empty "needs you" is information and a hidden one is not.
 */
export function InboxPage() {
  const view = useResource<InboxView>('/api/inbox');
  const [bucket, setBucket] = useState<Bucket>('NEEDS_REVIEW');
  usePolling(() => view.reload(), 20_000, true);

  if (view.loading && !view.data) return <Loading label="Loading your inbox" />;
  if (view.error) return <ErrorPanel title="The inbox could not be loaded." detail={view.error} />;

  const data = view.data;
  const items = (data?.items ?? []).filter((item) => item.bucket === bucket);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <p className="eyebrow">Inbox</p>
      <h1 className="mt-2 text-2xl font-light text-bone">What needs you</h1>
      <Explain label="this page" className="mt-3">
        <p>
          <strong>Messages your agents have seen, and what they did about each one.</strong>
        </p>
        <p>
          Anything under <strong>Needs you</strong> is a reply the agent has written and is holding until
          you say yes. You can read it here and decide without opening anything: J and K move, A sends, R
          discards.
        </p>
        <p>Everything else is a record. Nothing there is waiting on you.</p>
      </Explain>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
        Across every agent you have. This is not the activity log: it lists the things you might act on, and the two
        that need you come first even when they are empty.
      </p>

      <div className="mt-8 flex flex-wrap gap-2">
        {ORDER.map((key) => {
          const count = data?.counts[key] ?? 0;
          const active = key === bucket;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setBucket(key)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                active ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'
              }`}
            >
              {WORDS[key]}
              <span className="ml-2 font-mono text-[11px] text-bone-faint">{count}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-[13px] text-bone-faint">{LEDE[bucket]}</p>

      {/*
        Deciding, rather than a list of links to places where deciding happens.
        Only in the bucket that has a decision in it: the others are a record.
      */}
      {bucket === 'NEEDS_REVIEW' && items.length > 0 && (
        <div className="mt-6">
          <ReviewQueue items={items} onDecided={() => view.reload()} />
        </div>
      )}

      <div className="mt-6 space-y-2">
        {bucket === 'NEEDS_REVIEW' && items.length > 0 ? null : items.length === 0 ? (
          <EmptyState
            title={bucket === 'NEEDS_REVIEW' ? 'Nothing is waiting on you' : 'Nothing here'}
            detail={
              bucket === 'NEEDS_REVIEW'
                ? 'Your agents are deciding for themselves, within the policies you set.'
                : undefined
            }
          />
        ) : (
          items.map((item) => (
            <article key={item.eventId} className="rounded-lg border border-bone/10 bg-black/20 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[12px] text-bone-faint">
                  {/* Which agent, always. An owner with four cannot act on "somebody needs approval". */}
                  {item.agentName ? (
                    <Link to={`/agents/${item.agentId}`} className="text-bone hover:underline">
                      {item.agentName}
                    </Link>
                  ) : (
                    <span className="text-bone-dim">No agent picked this up</span>
                  )}
                  {item.authorHandle && <span> · from @{item.authorHandle}</span>}
                  <span> · {timeAgo(item.ingestedAt)}</span>
                </p>
                <StatusDot
                  state={item.state === 'FAILED' ? 'fail' : item.state === 'NEEDS_REVIEW' ? 'wait' : item.state === 'REPLIED' ? 'live' : 'idle'}
                  label={item.state.toLowerCase().replace(/_/g, ' ')}
                />
              </div>

              <p className="mt-2 break-words text-sm leading-relaxed text-bone">{item.text}</p>

              {item.errorClass && (
                <p className="mt-2 break-words text-[12px] text-amber-300">It stopped at: {item.errorClass}.</p>
              )}

              {item.replyText && (
                <p className="mt-2 break-words border-l-2 border-bone/20 pl-3 text-[13px] leading-relaxed text-bone-dim">
                  {item.replyText}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-3 text-[12px]">
                {/* Every row leads somewhere you can act, which is the difference
                    between this and a log. */}
                {item.jobId && (
                  <Link to={`/jobs/${item.jobId}`} className="text-bone hover:underline">
                    {item.bucket === 'NEEDS_REVIEW' ? 'Review it' : item.bucket === 'ERRORS' ? 'See what failed' : 'See what it did'}
                  </Link>
                )}
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer" className="text-bone-faint hover:underline">
                    The original
                  </a>
                )}
                {item.replyUrl && (
                  <a href={item.replyUrl} target="_blank" rel="noreferrer" className="text-bone-faint hover:underline">
                    The reply
                  </a>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
