import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Link2, MessageSquare } from 'lucide-react';
import { ApiError, get, post } from '@app/lib/api';
import { useElapsed, useResource } from '@app/lib/hooks';
import { ChoiceGroup, ChoiceOption, EmptyState, Field, Spinner, Working } from '@app/components/ui';
import { Panel } from './shared';
import { ReplyInspector } from '@app/components/ReplyInspector';

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
 * what decides a real reply, meaning who wrote it, what is above it and when
 * it happened, is exactly what a typed approximation leaves out.
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

interface TaskRow {
  id: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
}


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

      {jobId && <ReplyInspector agentId={agentId} jobId={jobId} />}

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
/**
 * What fed the answer, and what happened to it.
 *
 * Three questions in the order somebody asks them: what did it say, what could
 * it see, and what did each stage decide. The stages come last deliberately.
 * an owner who is happy with the draft never has to read them, and one who is
 * not goes straight to the row that explains it.
 */
