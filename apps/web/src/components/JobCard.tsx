import { Link } from 'react-router-dom';
import type { ActionType } from '@xbam/shared/contracts';
import type { JobSummary } from '@app/lib/types';
import { humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { StatusDot } from './ui';

/**
 * What the agent produced, called what it actually is.
 *
 * This said "Reply" for everything. An agent also says things nobody asked it
 * to: an original post arrives on a SCHEDULED_TRIGGER event with actionType
 * POST, and the card labelled it a reply to @unknown, which is two wrong
 * statements about one row. The record has carried `actionType` all along.
 */
const PRODUCED: Record<ActionType, string> = {
  REPLY: 'Reply',
  POST: 'Post',
  DIRECT_MESSAGE: 'Message',
  LIKE: 'Like',
  REPOST: 'Repost',
  REACT: 'Reaction',
  CALL_TOOL: 'Tool call',
  CALL_API: 'API call',
  NONE: 'Output',
};

/** One event and what the agent did about it. Used in both activity views. */
export function JobCard({ job, showAgent = false }: { job: JobSummary; showAgent?: boolean }) {
  const output = job.validatedOutput ?? job.generatedOutput;
  const needsPerson = job.status === 'WAITING_FOR_APPROVAL' || job.status === 'REVIEW_REQUIRED';
  const produced = PRODUCED[job.actionType];
  /*
    Nobody wrote to the agent here, so there is nobody to name.

    A self-originated post has no author on its event, and "@unknown" reads as a
    person whose handle could not be read rather than as the absence of one.
  */
  const selfStarted = job.actionType === 'POST';

  return (
    <Link
      to={`/jobs/${job.id}`}
      className="block rounded-2xl border border-ink-line bg-ink-raised/70 p-6 backdrop-blur-sm transition-colors hover:border-bone-faint/40 sm:p-8"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">{job.channel}</span>
        {showAgent && <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">{job.agentName}</span>}
        {job.dryRun && <span className="chip">dry run</span>}
        <span className="ml-auto flex items-center gap-4">
          <StatusDot state={toneFor(job.status)} label={humanStatus(job.status)} />
          <span className="font-mono text-[10px] text-bone-faint">{timeAgo(job.createdAt)}</span>
        </span>
      </div>

      <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-bone-faint">
        {job.authorHandle ? `@${job.authorHandle}` : selfStarted ? 'its own idea' : '@unknown'}
      </p>
      <p className="mt-2 line-clamp-3 text-lg font-light leading-snug text-bone">{job.incomingText || '(no text)'}</p>

      {output && (
        <div className="mt-5 border-l-2 border-signal-calm/40 pl-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{produced}</p>
          <p className="mt-1.5 line-clamp-3 text-[15px] leading-relaxed text-bone-dim">{output}</p>
        </div>
      )}

      {job.lastError && (
        <p className="mt-4 line-clamp-2 text-sm text-signal-fail/90">{job.lastError}</p>
      )}

      {needsPerson && (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-signal-wait">Waiting for you</p>
      )}
    </Link>
  );
}
