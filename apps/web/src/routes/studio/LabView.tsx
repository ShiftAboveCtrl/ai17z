import { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, Link2, MessageSquare } from 'lucide-react';
import { ApiError, get, post } from '@app/lib/api';
import { useElapsed, useResource } from '@app/lib/hooks';
import { ChoiceGroup, ChoiceOption, EmptyState, Field, Spinner, Working } from '@app/components/ui';
import { Gaps, Panel } from './shared';

/**
 * The Response Lab.
 *
 * The question an owner asks before they will let an agent near their account
 * is not "does it work" but "what would it say to *this*, and why that". Both
 * halves are here, and the second half is the one that makes the screen worth
 * opening twice: a draft on its own is a thing to like or dislike, and a draft
 * with the evidence beside it is a thing to correct.
 *
 * ## Two ways in, one path underneath
 *
 * A typed message runs on the mock channel and needs nothing connected, which
 * is what an owner wants while they are still editing a persona. A real post is
 * read from X through the signed-in browser the worker holds, because most of
 * what decides a real reply -- who wrote it, what is above it, when it happened
 * -- is exactly what a typed approximation leaves out.
 *
 * Both end in the same rehearsal, which is the ordinary pipeline running as a
 * dry run. So what this screen shows is what would really have happened, not a
 * simulation of it.
 *
 * ## Nothing here publishes
 *
 * There is no toggle for it and there must never be. The dry run is set by the
 * route, the job row is checked, and every remote call in the execute step is
 * behind that flag.
 */

interface LabInput {
  key: string;
  name: string;
  why: string;
  value: string | null;
  present: boolean;
}

interface LabStage {
  key: string;
  name: string;
  outcome: 'RAN' | 'DECIDED_AGAINST' | 'SKIPPED' | 'FAILED' | 'WAITING';
  detail: string;
  at: string | null;
}

interface LabExplanation {
  jobId: string;
  status: string;
  dryRun: boolean;
  finished: boolean;
  subject: { handle: string | null; text: string; url: string | null; at: string | null };
  draft: string | null;
  answer: string | null;
  silence: string | null;
  inputs: LabInput[];
  stages: LabStage[];
  gaps: string[];
}

interface TaskRow {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** How the outcome of a stage reads, and how it looks. */
const OUTCOME: Record<LabStage['outcome'], { label: string; tone: string }> = {
  RAN: { label: 'ran', tone: 'text-bone-dim' },
  DECIDED_AGAINST: { label: 'decided against', tone: 'text-bone-dim' },
  SKIPPED: { label: 'did not run', tone: 'text-bone-faint' },
  FAILED: { label: 'failed', tone: 'text-signal-fail' },
  WAITING: { label: 'waiting', tone: 'text-bone-faint' },
};

export function LabView({ agentId }: { agentId: string }) {
  const [mode, setMode] = useState<'typed' | 'post'>('typed');
  const [text, setText] = useState('');
  const [handle, setHandle] = useState('');
  const [parent, setParent] = useState('');
  const [postRef, setPostRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  const accounts = useResource<{ items: { id: string; channel: string; enabled: boolean }[] }>('/api/accounts');
  const hasX = (accounts.data?.items ?? []).some((account) => account.channel === 'x' && account.enabled);

  const run = async () => {
    setBusy(true);
    setError(null);
    setJobId(null);
    setTaskId(null);
    setReading(null);
    try {
      if (mode === 'typed') {
        const result = await post<{ jobId: string }>(`/api/agents/${agentId}/lab/typed`, {
          text: text.trim(),
          fromHandle: handle.trim() || undefined,
          parentText: parent.trim() || undefined,
        });
        setJobId(result.jobId);
      } else {
        const result = await post<{ taskId: string }>(`/api/agents/${agentId}/lab/post`, { post: postRef.trim() });
        setTaskId(result.taskId);
        setReading('Reading the post through the signed-in browser.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be rehearsed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Panel
        title="Try it against something"
        lede="Runs the real pipeline and stops before anything leaves this machine. Nothing is published, and there is no setting that changes that."
      >
        <ChoiceGroup label="What to try it against">
          <ChoiceOption selected={mode === 'typed'} onSelect={() => setMode('typed')}>
            <MessageSquare className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            Something I type
          </ChoiceOption>
          <ChoiceOption selected={mode === 'post'} onSelect={() => setMode('post')}>
            <Link2 className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            A real post on X
          </ChoiceOption>
        </ChoiceGroup>

        <div className="mt-5 max-w-2xl space-y-4">
          {mode === 'typed' ? (
            <>
              <Field label="What they said" htmlFor="lab-text">
                <textarea
                  id="lab-text"
                  rows={4}
                  className="field resize-y"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="What do you actually think about the fee change?"
                />
              </Field>
              <Field label="From" htmlFor="lab-handle" hint="Who said it. Leave blank for a stranger.">
                <input id="lab-handle" className="field" value={handle} onChange={(e) => setHandle(e.target.value)} />
              </Field>
              <Field
                label="The post above it"
                htmlFor="lab-parent"
                hint="Optional. A reply on its own often means nothing, and this is what the agent would be answering about."
              >
                <textarea
                  id="lab-parent"
                  rows={2}
                  className="field resize-y"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <Field
                label="Post"
                htmlFor="lab-post"
                hint="Paste the address of a post, or its numeric id. It is read through the browser your account is signed in to."
              >
                <input
                  id="lab-post"
                  className="field"
                  value={postRef}
                  onChange={(e) => setPostRef(e.target.value)}
                  placeholder="https://x.com/someone/status/1234567890123456789"
                />
              </Field>
              {!hasX && (
                <p className="text-[12px] leading-relaxed text-bone-faint">
                  AI17Z reads X through a signed-in browser, so this needs one of your X accounts connected. You can
                  still try the agent against a message you type.
                </p>
              )}
            </>
          )}

          {error && <p className="break-words text-sm text-signal-fail">{error}</p>}

          <button
            type="button"
            className="btn-primary"
            onClick={() => void run()}
            disabled={busy || (mode === 'typed' ? !text.trim() : !postRef.trim() || !hasX)}
          >
            {busy && <Spinner />}
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            Rehearse
          </button>
        </div>
      </Panel>

      {taskId && !jobId && (
        <ReadingThePost taskId={taskId} detail={reading} onJob={setJobId} onFailed={setError} />
      )}

      {jobId && <Explanation agentId={agentId} jobId={jobId} />}

      {!jobId && !taskId && !busy && (
        <div className="mt-8">
          <EmptyState
            title="Nothing rehearsed yet."
            detail="Give it something to answer and you will see the draft, what fed it, and every stage that produced it."
          />
        </div>
      )}
    </div>
  );
}

/**
 * Waiting on the worker to read the post.
 *
 * The read is a browser task because the API owns no browsers, so this is a
 * genuinely long operation with nothing to show for several seconds. `Working`
 * is the one place that decision is made: what it is doing, how long it has
 * been doing it, and how to stop.
 */
function ReadingThePost({
  taskId,
  detail,
  onJob,
  onFailed,
}: {
  taskId: string;
  detail: string | null;
  onJob: (jobId: string) => void;
  onFailed: (message: string) => void;
}) {
  const [stopped, setStopped] = useState(false);
  const settled = useRef(false);

  useEffect(() => {
    if (stopped) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const task = await get<TaskRow>(`/api/browser-tasks/${taskId}`);
        if (!alive || settled.current) return;
        if (task.status === 'COMPLETED') {
          settled.current = true;
          const result = task.result ?? {};
          const jobId = typeof result.jobId === 'string' ? result.jobId : null;
          if (jobId) onJob(jobId);
          else onFailed(typeof result.detail === 'string' ? result.detail : 'That post could not be read.');
        } else if (task.status === 'FAILED') {
          settled.current = true;
          onFailed(task.error ?? 'That post could not be read.');
        }
      } catch {
        // A poll that fails is not the operation failing. The next one may work,
        // and the elapsed time on screen is what tells somebody it has not.
      }
    };
    const timer = setInterval(() => void tick(), 1_500);
    void tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId, stopped, onJob, onFailed]);

  const seconds = useElapsed(!stopped);
  return (
    <div className="mt-8">
      <Working
        label={detail ?? 'Reading the post'}
        seconds={seconds}
        slowHint="X is being read through the browser your account is signed in to, which is slower than a screen refresh and is meant to be."
        onCancel={() => setStopped(true)}
        cancelLabel="Stop waiting"
      />
    </div>
  );
}

/** The wait while the pipeline runs, with the elapsed time the rule asks for. */
function Thinking() {
  const seconds = useElapsed(true);
  return (
    <Working
      label="Thinking"
      seconds={seconds}
      slowHint="It is running the same steps a real reply runs, including anything it decided to look up."
    />
  );
}

/**
 * What fed the answer, and what happened to it.
 *
 * Three questions in the order somebody asks them: what did it say, what could
 * it see, and what did each stage decide. The stages come last deliberately --
 * an owner who is happy with the draft never has to read them, and one who is
 * not goes straight to the row that explains it.
 */
function Explanation({ agentId, jobId }: { agentId: string; jobId: string }) {
  const [data, setData] = useState<LabExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await get<LabExplanation>(`/api/agents/${agentId}/lab/${jobId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That rehearsal could not be read back.');
    }
  }, [agentId, jobId]);

  const finished = data?.finished ?? false;
  useEffect(() => {
    void load();
    // A settled rehearsal does not change again, so the polling stops rather
    // than asking a finished question every second and a half for as long as
    // the tab is open.
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
        <Thinking />
      </div>
    );
  }

  return (
    <>
      <Panel
        title={data.silence ? 'It decided not to answer' : 'What it would say'}
        lede={
          data.finished
            ? data.silence
              ? 'Silence is a decision here, not a failure, and it comes with its reasons.'
              : 'This was never sent. It is what would have gone out.'
            : 'Still working.'
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

      <Panel title="What it could see" lede="The observable inputs this answer rests on. Anything absent is named rather than left blank.">
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
              {input.value && (
                <p className="mt-2 break-words text-[13px] leading-relaxed text-bone-dim">{input.value}</p>
              )}
            </li>
          ))}
        </ul>
        <Gaps items={data.gaps} label="Not known" />
      </Panel>

      <Panel title="How it got there" lede="Every stage of the pipeline, and what it decided. Read off the job’s own trace, so it is what happened rather than an account of it.">
        <ol className="space-y-2">
          {data.stages.map((stage) => (
            <li key={stage.key} className="rounded-xl border border-ink-line px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-[14px] font-light text-bone">{stage.name}</h3>
                <span className={`ml-auto font-mono text-[10px] uppercase tracking-[0.2em] ${OUTCOME[stage.outcome].tone}`}>
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
