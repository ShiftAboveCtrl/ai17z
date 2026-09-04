import { usePolling, useResource } from '@app/lib/hooks';
import { StatusDot } from '@app/components/ui';

type Activity =
  | 'LISTENING'
  | 'THINKING'
  | 'RESEARCHING'
  | 'WAITING_FOR_MODEL'
  | 'REPLYING'
  | 'POSTING'
  | 'PAUSED'
  | 'NEEDS_ATTENTION';

interface StatusView {
  status: { activity: Activity; detail: string };
}

/** What each activity is called, in the words somebody would use out loud. */
const WORDS: Record<Activity, string> = {
  LISTENING: 'Listening',
  THINKING: 'Thinking',
  RESEARCHING: 'Looking it up',
  WAITING_FOR_MODEL: 'Waiting for the model',
  REPLYING: 'Replying',
  POSTING: 'Posting',
  PAUSED: 'Paused',
  NEEDS_ATTENTION: 'Needs you',
};

/** Live is doing something, wait is holding, fail is stuck, idle is stopped. */
const TONE: Record<Activity, 'live' | 'wait' | 'fail' | 'idle'> = {
  LISTENING: 'live',
  THINKING: 'live',
  RESEARCHING: 'live',
  WAITING_FOR_MODEL: 'wait',
  REPLYING: 'live',
  POSTING: 'live',
  PAUSED: 'idle',
  NEEDS_ATTENTION: 'fail',
};

/**
 * What the agent is doing, rather than whether it is switched on.
 *
 * The header said RUNNING, and RUNNING was equally true of an agent answering
 * mentions, an agent waiting on a dead provider, an agent whose Chrome had
 * gone, and an agent holding twelve replies for review -- one word for four
 * situations, three of which needed somebody.
 *
 * Every state here is derived from work that exists: a job on a particular
 * step, a review queue with a length, a component that is failing. Nothing is
 * inferred from elapsed time, because a status that guesses is one people stop
 * reading.
 *
 * Falls back to the stored state rather than showing nothing while it loads:
 * an empty space where the status goes reads as broken.
 */
export function LiveStatus({ agentId, fallback }: { agentId: string; fallback: { tone: 'live' | 'wait' | 'fail' | 'idle'; label: string } }) {
  const view = useResource<StatusView>(`/api/agents/${agentId}/status`);
  // Often enough to feel live, rarely enough that it costs nothing: the reply
  // it is describing takes seconds, not milliseconds.
  usePolling(() => view.reload(), 5_000, true);

  const status = view.data?.status;
  if (!status) return <StatusDot state={fallback.tone} label={fallback.label} />;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusDot state={TONE[status.activity]} label={WORDS[status.activity] ?? status.activity} />
      {/* The sentence is the part that makes the word actionable. */}
      <span className="break-words text-[11px] leading-relaxed text-bone-faint">{status.detail}</span>
    </span>
  );
}
