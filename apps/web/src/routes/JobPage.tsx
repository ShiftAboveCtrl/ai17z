import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, RefreshCw, Square, X } from 'lucide-react';
import { ApiError, artifactObjectUrl, post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import type { JobDetail } from '@app/lib/types';
import { clockTime, humanStatus, timeAgo, toneFor } from '@app/lib/format';
import { ErrorPanel, Loading, Spinner, StatusDot } from '@app/components/ui';
import { ConversationView } from '@app/components/ConversationView';
import { FadeIn } from '@app/components/motion';

const LEVEL_TONE: Record<string, string> = {
  error: 'text-signal-fail',
  warn: 'text-signal-wait',
  info: 'text-bone-dim',
  debug: 'text-bone-faint',
};

/**
 * The complete answer to "why did it do that": every trace event, every memory
 * with its reason, every prompt layer, every model attempt, and the action.
 */
export function JobPage() {
  const { jobId = '' } = useParams();
  const { data, error, loading, reload } = useResource<JobDetail>(jobId ? `/api/jobs/${jobId}` : null);
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openLayer, setOpenLayer] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const settled = ['EXECUTED', 'DRY_RUN_COMPLETED', 'PERMANENT_FAILURE', 'CANCELLED', 'WAITING_FOR_APPROVAL', 'REVIEW_REQUIRED'];
  usePolling(() => reload(), 2000, Boolean(data && !settled.includes(data.job.status)));

  if (loading && !data) return <Loading label="Loading trace" />;
  if (error) {
    return (
      <main className="mx-auto max-w-page px-6 pt-40 sm:px-10">
        <ErrorPanel title="That job could not be loaded." detail={error} />
      </main>
    );
  }
  if (!data) return null;

  const { job, event, trace, modelCalls, retrievals, actions, approval, attempts, diagnostics } = data;
  const output = edited ?? job.validatedOutput ?? job.generatedOutput ?? '';
  const decidable = job.status === 'WAITING_FOR_APPROVAL' || job.status === 'REVIEW_REQUIRED';
  const retryable = ['REVIEW_REQUIRED', 'PERMANENT_FAILURE', 'RETRYABLE_FAILURE', 'CANCELLED'].includes(job.status);
  // Anything that has not finished can be stopped. The route already existed;
  // nothing in the interface ever called it, so a job on its way to saying
  // something could only be watched.
  const stoppable = !['EXECUTED', 'DRY_RUN_COMPLETED', 'CANCELLED', 'PERMANENT_FAILURE'].includes(job.status);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/api/jobs/${job.id}/${path}`, body);
      setEdited(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const lastModelCall = modelCalls[modelCalls.length - 1];

  return (
    <main className="mx-auto max-w-4xl px-6 pb-32 pt-32 sm:px-10 sm:pt-40">
      <Link to="/activity" className="btn-quiet mb-8 -ml-2">
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Activity
      </Link>

      <FadeIn>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <StatusDot state={toneFor(job.status)} label={humanStatus(job.status)} />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{job.channel}</span>
          {job.dryRun && <span className="chip">dry run</span>}
          <span className="font-mono text-[10px] text-bone-faint">{timeAgo(job.createdAt)}</span>
        </div>
        <h1 className="mt-6 text-3xl font-light leading-tight tracking-tight text-bone sm:text-5xl">
          {event?.text || '(no incoming text)'}
        </h1>
        <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-bone-faint">
          from @{event?.remoteAuthorHandle ?? 'unknown'}
        </p>
      </FadeIn>

      {stoppable && (
        <div className="mt-8 flex items-center gap-4">
          <button type="button" className="btn-ghost hover:text-signal-fail" onClick={() => void act('cancel')} disabled={busy}>
            <Square className="h-3.5 w-3.5" aria-hidden />
            Stop this job
          </button>
          <p className="text-xs text-bone-faint">
            Stops between steps, so nothing is sent half-finished.
          </p>
        </div>
      )}

      {job.lastError && (
        <div className="mt-8">
          <ErrorPanel
            title={job.errorClass === 'PERMANENT' ? 'This job stopped permanently.' : 'This job needs attention.'}
            detail={job.lastError}
            actions={
              retryable ? (
                <button type="button" className="btn-ghost" onClick={() => void act('retry')} disabled={busy}>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Try again
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {output && (
        <section className="mt-10">
          <p className="eyebrow mb-3">Generated reply</p>
          {decidable ? (
            <textarea
              className="field min-h-[7rem] resize-y text-base leading-relaxed"
              value={output}
              onChange={(e) => setEdited(e.target.value)}
              aria-label="Reply text"
            />
          ) : (
            <p className="whitespace-pre-wrap rounded-xl border border-ink-line bg-ink-raised px-5 py-4 text-[15px] leading-relaxed text-bone">
              {output}
            </p>
          )}
          <p className="mt-2 font-mono text-[10px] text-bone-faint">{output.length} characters</p>

          {decidable && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => void act('approve', edited ? { editedOutput: edited } : {})} disabled={busy}>
                {busy ? <Spinner /> : <Check className="h-4 w-4" aria-hidden />}
                {edited ? 'Approve with edits' : 'Approve'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => void act('reject', {})} disabled={busy}>
                <X className="h-4 w-4" aria-hidden />
                Reject
              </button>
            </div>
          )}
          {actionError && <p className="mt-3 text-sm text-signal-fail">{actionError}</p>}
        </section>
      )}

      {/* The chain first, because "did it understand where it was" is the
          question a nested mention makes hard to answer, and the panels below
          are the detail behind it. */}
      <div className="mt-14">
        <ConversationView
          context={job.resolvedContext as never}
          retrievals={retrievals as never}
          reply={job.validatedOutput ?? job.generatedOutput ?? null}
        />
      </div>

      <ContextPanel job={job} retrievals={retrievals} />

      <WhyPanel trace={trace} />

      <section className="mt-14">
        <p className="eyebrow mb-4">Lifecycle</p>
        <ol className="relative space-y-0 border-l border-ink-line pl-6">
          {trace.map((entry) => (
            <li key={entry.id} className="relative pb-5">
              <span className="absolute -left-[1.6rem] top-1.5 h-1.5 w-1.5 rounded-full bg-ink-line" aria-hidden />
              <div className="flex flex-wrap items-baseline gap-x-4">
                <span className="font-mono text-[10px] text-bone-faint">{clockTime(entry.at)}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">
                  {entry.type.replace(/_/g, ' ').toLowerCase()}
                </span>
              </div>
              <p className={`mt-1 text-sm leading-relaxed ${LEVEL_TONE[entry.level] ?? 'text-bone-dim'}`}>{entry.message}</p>
            </li>
          ))}
          {trace.length === 0 && <li className="pb-5 text-sm text-bone-faint">No trace events recorded yet.</li>}
        </ol>
      </section>

      <section className="mt-14">
        <p className="eyebrow mb-4">Retrieved memories ({retrievals.length})</p>
        {retrievals.length === 0 ? (
          <p className="text-sm text-bone-faint">
            Nothing was retrieved for this job. The trace above records which scopes were searched.
          </p>
        ) : (
          <ol className="divide-y divide-ink-line border-y border-ink-line">
            {retrievals.map((memory) => (
              <li key={memory.memoryId} className="flex items-start gap-4 py-4">
                <span className="mt-0.5 font-mono text-[11px] text-bone-faint">{memory.rank}.</span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-bone-faint">{memory.scope}</p>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-bone-dim">{memory.content}</p>
                  <p className="mt-1.5 text-xs text-signal-calm/80">why: {memory.reason}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {lastModelCall?.promptLayers && (
        <section className="mt-14">
          <p className="eyebrow mb-4">Prompt layers ({lastModelCall.promptLayers.length})</p>
          <div className="divide-y divide-ink-line border-y border-ink-line">
            {lastModelCall.promptLayers.map((layer) => (
              <div key={layer.key}>
                <button
                  type="button"
                  className="flex w-full items-baseline justify-between gap-4 py-3.5 text-left"
                  onClick={() => setOpenLayer(openLayer === layer.key ? null : layer.key)}
                  aria-expanded={openLayer === layer.key}
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">{layer.title}</span>
                  <span className="font-mono text-[10px] text-bone-faint">{layer.source}</span>
                </button>
                {openLayer === layer.key && (
                  <pre className="scroll-x mb-4 whitespace-pre-wrap rounded-lg border border-ink-line bg-ink-panel p-4 font-mono text-[12px] leading-relaxed text-bone-dim">
                    {layer.content}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-14">
        <p className="eyebrow mb-4">Model calls</p>
        {modelCalls.length === 0 ? (
          <p className="text-sm text-bone-faint">No model call has been made for this job yet.</p>
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[38rem] border-y border-ink-line text-sm">
              <thead>
                <tr className="text-left font-mono text-[9px] uppercase tracking-[0.16em] text-bone-faint">
                  <th className="py-3 pr-4 font-normal">Role</th>
                  <th className="py-3 pr-4 font-normal">Provider</th>
                  <th className="py-3 pr-4 font-normal">Model</th>
                  <th className="py-3 pr-4 font-normal">Status</th>
                  <th className="py-3 pr-4 font-normal">Latency</th>
                  <th className="py-3 font-normal">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {modelCalls.map((call) => (
                  <tr key={call.id} className="text-bone-dim">
                    <td className="py-3 pr-4 font-mono text-xs">{call.modelRole ?? '-'}</td>
                    <td className="py-3 pr-4">{call.provider}</td>
                    <td className="py-3 pr-4 font-mono text-xs">{call.model}</td>
                    <td className={`py-3 pr-4 ${call.status === 'FAILED' ? 'text-signal-fail' : ''}`}>
                      {call.status.toLowerCase()}
                      {call.error && <span className="block text-xs text-signal-fail/80">{call.error}</span>}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">{call.latencyMs != null ? `${call.latencyMs}ms` : '-'}</td>
                    <td className="py-3 font-mono text-xs">
                      {call.promptTokens != null ? `${call.promptTokens}/${call.completionTokens ?? 0}` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {actions.length > 0 && (
        <section className="mt-14">
          <p className="eyebrow mb-4">Action</p>
          <div className="divide-y divide-ink-line border-y border-ink-line">
            {actions.map((action) => (
              <div key={action.id} className="py-4">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">{action.type}</span>
                  <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${action.status === 'FAILED' ? 'text-signal-fail' : 'text-bone-faint'}`}>
                    {action.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                  {action.remoteActionUrl && (
                    <span className="font-mono text-[11px] text-bone-faint">{action.remoteActionUrl}</span>
                  )}
                </div>
                {action.targetRef && (
                  <p className="mt-2 break-all font-mono text-[11px] text-bone-faint">target: {action.targetRef}</p>
                )}
                {typeof action.verification?.detail === 'string' && (
                  <p className="mt-2 text-sm text-bone-dim">{action.verification.detail}</p>
                )}
                {action.lastError && <p className="mt-2 text-sm text-signal-fail">{action.lastError}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {attempts.length > 0 && (
        <section className="mt-14">
          <p className="eyebrow mb-4">Attempts</p>
          <ol className="divide-y divide-ink-line border-y border-ink-line text-sm">
            {attempts.map((attempt) => (
              <li key={`${attempt.attempt}-${attempt.step}`} className="flex flex-wrap items-baseline gap-x-4 py-3">
                <span className="font-mono text-[11px] text-bone-faint">#{attempt.attempt}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">{attempt.step}</span>
                <span className={`font-mono text-[10px] uppercase tracking-[0.16em] ${attempt.outcome === 'OK' ? 'text-signal-live' : 'text-signal-wait'}`}>
                  {attempt.outcome ?? 'running'}
                </span>
                {attempt.error && <span className="w-full text-xs text-signal-fail/85">{attempt.error}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {diagnostics.length > 0 && (
        <section className="mt-14">
          <p className="eyebrow mb-4">Diagnostics</p>
          <ul className="space-y-3">
            {diagnostics.map((diagnostic) => (
              <li key={diagnostic.id} className="rounded-lg border border-ink-line px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{diagnostic.kind}</span>
                  <span className="font-mono text-[10px] text-bone-faint">{timeAgo(diagnostic.createdAt)}</span>
                </div>
                <p className="mt-2 text-sm text-bone-dim">{diagnostic.message}</p>
                {diagnostic.url && <p className="mt-1 break-all font-mono text-[11px] text-bone-faint">{diagnostic.url}</p>}
                {diagnostic.artifactId && (
                  <button
                    type="button"
                    className="btn-quiet mt-2 px-0 text-xs"
                    onClick={() =>
                      void artifactObjectUrl(diagnostic.artifactId!)
                        .then(setShot)
                        .catch(() => setActionError('That screenshot is no longer on disk.'))
                    }
                  >
                    View screenshot
                  </button>
                )}
              </li>
            ))}
          </ul>
          {shot && (
            <div className="mt-4">
              <img src={shot} alt="Browser screenshot captured at the time of failure" className="w-full rounded-lg border border-ink-line" />
            </div>
          )}
        </section>
      )}

      <section className="mt-14 border-t border-ink-line pt-8">
        <p className="eyebrow mb-4">Configuration this job ran under</p>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <Row label="Job id" value={job.id} mono />
          <Row label="Idempotency key" value={job.idempotencyKey} mono />
          <Row label="Persona version" value={job.personaVersionId ?? 'none'} mono />
          <Row label="Policy version" value={job.policyVersionId ?? 'none'} mono />
          <Row label="Attempts" value={`${job.attemptCount} of ${job.maxAttempts}`} />
          <Row label="Approval" value={approval ? `${approval.status.toLowerCase()} ${timeAgo(approval.decidedAt)}` : 'not required'} />
        </dl>
      </section>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[9px] uppercase tracking-[0.18em] text-bone-faint">{label}</dt>
      <dd className={`mt-1 truncate text-bone-dim ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

interface TraceEntry {
  id: string;
  type: string;
  message: string;
  level: string;
  at: string;
  data?: Record<string, unknown> | null;
}

/**
 * Why this reply, or why no reply.
 *
 * The lifecycle below records everything that happened. This answers the two
 * questions people actually arrive with, and it deliberately sits above the
 * timeline rather than inside it: "reply value 18" buried in a list of twenty
 * events is not an answer.
 */
function WhyPanel({ trace }: { trace: TraceEntry[] }) {
  const find = (type: string) => trace.find((entry) => entry.type === type);

  const engagement = find('ENGAGEMENT_DECIDED');
  const intent = find('INTENT_SELECTED');
  const relationship = find('RELATIONSHIP_LOADED');
  const stance = find('STANCE_SELECTED');
  const conflict = find('STANCE_CONFLICT');
  const media = find('MEDIA_RESOLVED');

  if (!engagement && !intent && !relationship) return null;

  const decision = (engagement?.data as { decision?: string; value?: number; factors?: { label: string; delta: number }[] } | undefined) ?? {};
  const ignored = decision.decision === 'IGNORE';

  return (
    <section className="mt-12 rounded-xl border border-ink-line bg-ink-panel/60 p-5">
      <p className="eyebrow mb-4">{ignored ? 'Why no reply?' : 'Why this reply?'}</p>

      <dl className="space-y-3.5">
        {engagement && (
          <WhyRow
            term={ignored ? 'Stayed silent' : 'Decided to answer'}
            detail={engagement.message}
            tone={ignored ? 'text-signal-wait' : 'text-bone'}
          />
        )}
        {intent && <WhyRow term="Kind of reply" detail={intent.message} />}
        {relationship && <WhyRow term="Who they are" detail={relationship.message} />}
        {stance && <WhyRow term="What it already thinks" detail={stance.message} />}
        {conflict && <WhyRow term="Contradiction" detail={conflict.message} tone="text-signal-fail" />}
        {media && <WhyRow term="What was attached" detail={media.message} />}
      </dl>

      {/* The factors are the actual argument. Showing only the total would be
          the same mistake as showing only the score. */}
      {(decision.factors?.length ?? 0) > 0 && (
        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-ink-line pt-3.5">
          {decision.factors!.map((factor) => (
            <li key={factor.label} className="font-mono text-[10px] text-bone-faint">
              <span className={factor.delta >= 0 ? 'text-signal-live/80' : 'text-signal-fail/80'}>
                {factor.delta >= 0 ? '+' : ''}
                {factor.delta}
              </span>{' '}
              {factor.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WhyRow({ term, detail, tone = 'text-bone-dim' }: { term: string; detail: string; tone?: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{term}</dt>
      <dd className={`text-sm leading-relaxed ${tone}`}>{detail}</dd>
    </div>
  );
}

/**
 * Who addressed the agent, what they were replying to, and what it read.
 *
 * The two failures this makes visible are the ones that used to be invisible:
 * a reply about to go to the wrong post, and an agent answering a vague
 * question because it never saw the post the question was about. The action
 * target and the conversation are shown as separate things, because they are.
 */
function ContextPanel({ job, retrievals }: { job: JobDetail['job']; retrievals: JobDetail['retrievals'] }) {
  const context = job.resolvedContext;
  if (!context) return null;
  const conversation = context.conversation;

  return (
    <section className="mt-14">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <p className="eyebrow">Context</p>
        {conversation && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-faint">
            {conversation.method === 'STATUS_ANCHORED' ? 'anchored by status id' : 'event only'}
            {conversation.branchConfirmed ? ' · branch confirmed' : ''}
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-ink-line">
        <div className="border-b border-ink-line bg-signal-calm/[0.05] px-5 py-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-signal-calm">Replying to</p>
          <p className="mt-1.5 text-[13px] text-bone-dim">
            {context.targetAuthorHandle ? `@${context.targetAuthorHandle}` : 'unknown author'}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-bone">
            {conversation?.incoming.text || context.incomingText || '(no text)'}
          </p>
          {context.targetUrl && (
            <a
              href={context.targetUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 block break-all font-mono text-[10px] text-bone-faint hover:text-bone-dim"
            >
              {context.targetUrl}
            </a>
          )}
        </div>

        {conversation && conversation.ancestors.length > 0 ? (
          // Root first, direct parent last, exactly as the resolver produced it.
          [...conversation.ancestors].reverse().map((post, index) => {
            const isParent = index === 0;
            const isRoot = index === conversation.ancestors.length - 1;
            return (
              <div key={post.remoteId ?? index} className="border-b border-ink-line px-5 py-3.5 last:border-b-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
                  {isParent ? 'Parent' : isRoot ? 'Root' : `Ancestor ${conversation.ancestors.length - index}`}
                  {' · '}
                  {post.authorHandle ? `@${post.authorHandle}` : 'unknown'}
                  {post.isSelf ? ' (this agent)' : ''}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-bone-dim">{post.text}</p>
              </div>
            );
          })
        ) : context.parentText ? (
          <div className="px-5 py-3.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">Parent</p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-bone-dim">{context.parentText}</p>
          </div>
        ) : (
          <div className="px-5 py-3.5">
            <p className="text-[12px] text-bone-faint">Nothing above it. This was the start of the thread.</p>
          </div>
        )}

        {conversation?.quote && (
          <div className="border-t border-ink-line bg-ink-panel/40 px-5 py-3.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
              Quoted · {conversation.quote.authorHandle ? `@${conversation.quote.authorHandle}` : 'unknown'}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-bone-dim">
              {conversation.quote.text}
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-bone-faint">
        {conversation && (
          <>
            <span>{conversation.participants.length} participant(s)</span>
            {conversation.excludedCount > 0 && <span>{conversation.excludedCount} left out (other branches)</span>}
          </>
        )}
        <span>{retrievals.length} memory item(s)</span>
      </div>

      {conversation?.note && (
        <p className="mt-2 text-[12px] leading-relaxed text-bone-faint">{conversation.note}</p>
      )}
    </section>
  );
}
