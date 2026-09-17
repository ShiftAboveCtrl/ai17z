import { useCallback, useEffect, useState } from 'react';
import { ApiError, get } from '@app/lib/api';
import { useElapsed } from '@app/lib/hooks';
import { Working } from '@app/components/ui';
import { Gaps, Panel } from '@app/routes/studio/shared';

/**
 * Why an agent said what it said, for one reply.
 *
 * ## Why this is a component rather than a screen
 *
 * It was written for the Response Lab and lived inside it, so the only answers
 * anybody could inspect were rehearsals. The explanation is assembled entirely
 * out of rows an ordinary reply already writes -- the job's own trace, the
 * memories it retrieved with their reasons, the action it took -- and
 * `explainRehearsal` takes any job id. Nothing about it was ever specific to a
 * rehearsal except where it was rendered.
 *
 * Meanwhile the page for a real job showed the raw trace: every event, every
 * model call, every row. That answers "what happened" for somebody who already
 * knows the pipeline, and it is the wrong shape for "why did it say that".
 * Both belong on that page, in that order.
 *
 * ## What it does not show
 *
 * No raw reasoning. Every stage here is a conclusion the pipeline recorded,
 * with its outcome and one sentence. A model's hidden tokens are neither
 * stored nor displayed, and nothing here is a transcript of thinking.
 */

export interface InspectorInput {
  key: string;
  name: string;
  present: boolean;
  why: string;
  value?: string | null;
}

export interface InspectorStage {
  key: string;
  name: string;
  outcome: 'RAN' | 'DECIDED_AGAINST' | 'SKIPPED' | 'FAILED' | 'WAITING';
  detail: string;
}

export interface ReplyExplanation {
  jobId: string;
  status: string;
  dryRun: boolean;
  finished: boolean;
  subject: { handle: string | null; text: string; url: string | null; at: string | null };
  draft: string | null;
  answer: string | null;
  silence: string | null;
  inputs: InspectorInput[];
  stages: InspectorStage[];
  gaps: string[];
}

/** How the outcome of a stage reads, and how it looks. */
const OUTCOME: Record<InspectorStage['outcome'], { label: string; tone: string }> = {
  RAN: { label: 'ran', tone: 'text-bone-dim' },
  DECIDED_AGAINST: { label: 'decided against', tone: 'text-bone-dim' },
  SKIPPED: { label: 'did not run', tone: 'text-bone-faint' },
  FAILED: { label: 'failed', tone: 'text-signal-fail' },
  WAITING: { label: 'waiting', tone: 'text-bone-faint' },
};

/** The waiting state, with the elapsed clock `Working` asks for. */
function Reading() {
  const seconds = useElapsed(true);
  return (
    <Working
      label="Reading what fed this answer"
      seconds={seconds}
      slowHint="It is assembled from the job's own trace, so it appears as the job records it."
    />
  );
}

export function ReplyInspector({
  agentId,
  jobId,
  published,
}: {
  agentId: string;
  jobId: string;
  /** A real reply that went out, rather than a rehearsal of one. */
  published?: boolean;
}) {
  const [data, setData] = useState<ReplyExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await get<ReplyExplanation>(`/api/agents/${agentId}/lab/${jobId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That answer could not be read back.');
    }
  }, [agentId, jobId]);

  const finished = data?.finished ?? false;
  useEffect(() => {
    void load();
    // A settled job does not change again, so the polling stops rather than
    // asking a finished question every second and a half for as long as the
    // tab is open.
    if (finished) return undefined;
    const timer = setInterval(() => {
      void load();
    }, 1_500);
    return () => clearInterval(timer);
  }, [load, finished]);

  if (error) return <p className="mt-8 break-words text-sm text-signal-fail">{error}</p>;
  if (!data) {
    return (
      <div className="mt-8">
        <Reading />
      </div>
    );
  }

  const said = published ? 'What it said' : 'What it would say';
  const lede = published
    ? 'This went out. Everything below is why.'
    : data.finished
      ? 'This was never sent. It is what would have gone out.'
      : 'Still working.';

  return (
    <>
      <Panel
        title={data.silence ? 'It decided not to answer' : said}
        lede={
          data.silence
            ? 'Silence is a decision here, not a failure, and it comes with its reasons.'
            : lede
        }
      >
        {data.silence ? (
          <p className="break-words rounded-xl border border-ink-line px-4 py-3.5 text-[15px] leading-relaxed text-bone-dim">
            {data.silence}
          </p>
        ) : (
          <>
            <p className="break-words rounded-xl border border-ink-line px-4 py-3.5 text-[15px] leading-relaxed text-bone">
              {data.answer ?? 'Nothing yet.'}
            </p>
            {data.draft && data.draft !== data.answer && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] text-bone-faint">
                  What the model wrote, before the voice pass
                </summary>
                <p className="mt-2 break-words rounded-lg border border-dashed border-ink-line px-3.5 py-3 text-[13px] leading-relaxed text-bone-faint">
                  {data.draft}
                </p>
              </details>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="What it could see"
        lede="The observable inputs this answer rests on. Anything absent is named rather than left blank."
      >
        <ul className="space-y-2">
          {data.inputs.map((input) => (
            <li key={input.key} className="rounded-xl border border-ink-line px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-[14px] font-light text-bone">{input.name}</h3>
                {!input.present && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">nothing</span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-bone-faint">{input.why}</p>
              {input.value && <p className="mt-2 break-words text-[13px] leading-relaxed text-bone-dim">{input.value}</p>}
            </li>
          ))}
        </ul>
        <Gaps items={data.gaps} label="Not known" />
      </Panel>

      <Panel
        title="How it got there"
        lede="Every stage of the pipeline, and what it decided. Read off the job’s own trace, so it is what happened rather than an account of it."
      >
        <ol className="space-y-2">
          {data.stages.map((stage) => (
            <li key={stage.key} className="rounded-xl border border-ink-line px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-[14px] font-light text-bone">{stage.name}</h3>
                <span
                  className={`ml-auto font-mono text-[10px] uppercase tracking-[0.2em] ${OUTCOME[stage.outcome].tone}`}
                >
                  {OUTCOME[stage.outcome].label}
                </span>
              </div>
              <p className="mt-1.5 break-words text-[12px] leading-relaxed text-bone-faint">{stage.detail}</p>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}
