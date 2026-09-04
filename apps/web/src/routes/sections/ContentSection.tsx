import { useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { ApiError, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner } from '@app/components/ui';
import { Section } from './Section';

interface Idea {
  id: string;
  kind: string;
  summary: string;
  detail: string;
  source: string;
  sourceHandle: string | null;
  score: number;
  effectiveScore: number;
  status: 'unused' | 'drafting' | 'used' | 'discarded';
  attempts: number;
  lastError: string;
  usedAt: string | null;
  createdAt: string;
}

interface Schedule {
  enabled: boolean;
  intervalSeconds: number;
  nextPostAt: string | null;
  lastPostAt: string | null;
  lastReason: string;
  /** When it last looked, which is what makes the reason readable. */
  updatedAt: string;
}

interface Draft {
  id: string;
  status: string;
  text: string | null;
  createdAt: string;
  idea: string | null;
}

interface Posted {
  id: string;
  text: string | null;
  url: string | null;
  executedAt: string | null;
}

interface ContentView {
  counts: Record<string, number>;
  ideas: Idea[];
  schedule: Schedule | null;
  drafts: Draft[];
  posted: Posted[];
}

/** The four states a post passes through, in the order it passes through them. */
type Stage = 'IDEAS' | 'DRAFTS' | 'SCHEDULED' | 'POSTED';
const STAGES: { key: Stage; label: string; lede: string }[] = [
  { key: 'IDEAS', label: 'Ideas', lede: 'Things worth saying, waiting their turn. An empty list means it says nothing, which is the right outcome rather than a gap to fill.' },
  { key: 'DRAFTS', label: 'Drafts', lede: 'Written and held for you. Nothing goes out until you decide.' },
  { key: 'SCHEDULED', label: 'Scheduled', lede: 'When it may next speak. The schedule is a ceiling, not a timetable.' },
  { key: 'POSTED', label: 'Posted', lede: 'What actually went out.' },
];

/** Hours, said the way a person would say them. */
function everyHowOften(seconds: number): string {
  const hours = Math.round(seconds / 3600);
  if (hours <= 1) return 'about once an hour';
  if (hours < 24) return `about every ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'about once a day' : `about every ${days} days`;
}

/** When the next chance to post is, or why there is not one. */
function nextChance(schedule: Schedule | null): string {
  if (!schedule || !schedule.enabled) return 'Posting is off, so this backlog is only being collected.';
  if (!schedule.nextPostAt) return 'Posting is on. The first chance has not been scheduled yet.';
  const at = new Date(schedule.nextPostAt).getTime();
  if (at <= Date.now()) return 'Due now.';
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes < 60) return `Next chance in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  const hours = Math.round(minutes / 60);
  return `Next chance in about ${hours} hour${hours === 1 ? '' : 's'}.`;
}

const STATUS_LABEL: Record<Idea['status'], string> = {
  unused: 'Waiting',
  drafting: 'Being written',
  used: 'Posted',
  discarded: 'Set aside',
};

const STATUS_TONE: Record<Idea['status'], string> = {
  unused: 'text-bone',
  drafting: 'text-amber-300',
  used: 'text-emerald-300',
  discarded: 'text-bone-faint',
};

/** Where an idea came from, in words rather than in a column value. */
function provenance(idea: Idea): string {
  if (idea.source === 'you') return 'You added this';
  if (idea.source === 'conversation') {
    return idea.sourceHandle ? `From a conversation with @${idea.sourceHandle}` : 'From a conversation';
  }
  return `From ${idea.source}`;
}

/**
 * What the agent might say next, and why it has not said anything.
 *
 * The backlog existed and had no screen at all, which meant the one question
 * owners actually ask -- "why has my agent not posted?" -- had no answer short
 * of a database query. It has three possible answers and they are all here:
 * posting is off, it is not due yet, or it looked and found nothing worth
 * saying. The last is only believable next to the list it looked at.
 *
 * An idea an owner types is treated differently from one the agent noticed, and
 * the screen says so rather than hiding it: an owner's idea never ages out and
 * never loses ground to something newer, because it is a decision rather than
 * an observation.
 */
export function ContentSection({ index, agentId }: { index: number; agentId: string }) {
  const view = useResource<ContentView>(`/api/agents/${agentId}/content`);
  const [stage, setStage] = useState<Stage>('IDEAS');
  const [adding, setAdding] = useState(false);
  const [summary, setSummary] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const say = (problem: unknown) => setError(problem instanceof ApiError ? problem.message : String(problem));

  const add = async () => {
    setBusy('add');
    setError(null);
    try {
      await post(`/api/agents/${agentId}/ideas`, { summary: summary.trim(), detail: detail.trim() });
      setSummary('');
      setDetail('');
      setAdding(false);
      view.reload();
    } catch (problem) {
      say(problem);
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (idea: Idea, status: 'unused' | 'discarded') => {
    setBusy(idea.id);
    setError(null);
    try {
      await patch(`/api/agents/${agentId}/ideas/${idea.id}`, { status });
      view.reload();
    } catch (problem) {
      say(problem);
    } finally {
      setBusy(null);
    }
  };

  const data = view.data;
  const waiting = data?.counts.unused ?? 0;

  return (
    <Section
      id="content"
      index={index}
      eyebrow="Content"
      heading="What it might say next"
      lede="An agent posts from things that actually happened, never from a blank page. When its schedule comes due it looks here; an empty list means it says nothing, which is the right outcome rather than a gap to fill."
    >
      {view.loading && <Spinner />}

      {data && (
        <div className="space-y-6">
          <div className="rounded-lg border border-bone/10 bg-black/20 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="text-sm text-bone">
                  {waiting === 0 ? 'Nothing waiting' : `${waiting} idea${waiting === 1 ? '' : 's'} waiting`}
                  {data.schedule?.enabled && <span className="text-bone-faint">, posting {everyHowOften(data.schedule.intervalSeconds)}</span>}
                </p>
                <p className="mt-1 text-[13px] text-bone-faint">{nextChance(data.schedule)}</p>
              </div>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-2 rounded border border-bone/20 px-3 py-1.5 text-[13px] text-bone hover:border-bone/40"
              >
                <Plus className="h-3.5 w-3.5" /> Add an idea
              </button>
            </div>

            {data.schedule?.lastReason && (
              // The reason the last chance produced nothing. Without this the
              // only visible fact is silence, which reads as broken.
              // Without the "when", this line contradicts the count above it:
              // "nothing was worth posting" sitting over "3 ideas waiting" reads
              // as a bug rather than as ideas that arrived after it looked.
              <p className="mt-3 break-words border-t border-bone/10 pt-3 text-[13px] text-bone-faint">
                <span className="text-bone">It looked {timeAgo(data.schedule.updatedAt)}:</span>{' '}
                {data.schedule.lastReason}
                {data.schedule.lastPostAt && <span> Last post {timeAgo(data.schedule.lastPostAt)}.</span>}
              </p>
            )}
          </div>

          {error && <p className="break-words text-[13px] text-red-300">{error}</p>}

          {/* The four states a post passes through. Drafts and posted are read
              from jobs and actions rather than a second table: a post already
              runs the ten pipeline steps, so the job is the record. */}
          <div className="flex flex-wrap gap-2">
            {STAGES.map((s) => {
              const count =
                s.key === 'IDEAS' ? data.ideas.length : s.key === 'DRAFTS' ? data.drafts.length : s.key === 'POSTED' ? data.posted.length : 0;
              const active = s.key === stage;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setStage(s.key)}
                  className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                    active ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'
                  }`}
                >
                  {s.label}
                  {s.key !== 'SCHEDULED' && <span className="ml-2 font-mono text-[11px] text-bone-faint">{count}</span>}
                </button>
              );
            })}
          </div>
          <p className="text-[13px] text-bone-faint">{STAGES.find((s) => s.key === stage)!.lede}</p>

          {stage === 'DRAFTS' && (
            data.drafts.length === 0 ? (
              <EmptyState title="Nothing waiting for you" detail="A post written while review is on waits here until you approve it." />
            ) : (
              <ul className="space-y-2">
                {data.drafts.map((draft) => (
                  <li key={draft.id} className="rounded-lg border border-bone/10 bg-black/20 p-4">
                    {draft.idea && <p className="text-[12px] text-bone-faint">From: {draft.idea}</p>}
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-bone">{draft.text ?? 'Nothing was written.'}</p>
                    <p className="mt-2 text-[12px] text-bone-faint">Written {timeAgo(draft.createdAt)}</p>
                    <a href={`/jobs/${draft.id}`} className="mt-2 inline-block text-[12px] text-bone hover:underline">
                      Read it and decide
                    </a>
                  </li>
                ))}
              </ul>
            )
          )}

          {stage === 'SCHEDULED' && (
            <div className="rounded-lg border border-bone/10 bg-black/20 p-4">
              <p className="text-sm text-bone">{nextChance(data.schedule)}</p>
              {data.schedule?.enabled && (
                <p className="mt-2 text-[13px] text-bone-faint">
                  It posts {everyHowOften(data.schedule.intervalSeconds)}, and only if there is something worth saying.
                  Coming due is a chance to speak, not an obligation.
                </p>
              )}
            </div>
          )}

          {stage === 'POSTED' && (
            data.posted.length === 0 ? (
              <EmptyState title="Nothing posted yet" detail="Posts it made of its own accord appear here. Replies are under Activity." />
            ) : (
              <ul className="space-y-2">
                {data.posted.map((post) => (
                  <li key={post.id} className="rounded-lg border border-bone/10 bg-black/20 p-4">
                    <p className="whitespace-pre-wrap break-words text-sm text-bone">{post.text}</p>
                    <p className="mt-2 text-[12px] text-bone-faint">
                      {post.executedAt ? timeAgo(post.executedAt) : 'time unknown'}
                      {post.url && (
                        <>
                          {' · '}
                          <a href={post.url} target="_blank" rel="noreferrer" className="text-bone hover:underline">
                            on X
                          </a>
                        </>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )
          )}

          {stage === 'IDEAS' && (data.ideas.length === 0 ? (
            <EmptyState
              title="No ideas yet"
              detail="Ideas are captured from conversations the agent has: a question worth answering where more people can see it, or a position it keeps coming back to. You can also add one yourself, and yours never ages out."
            />
          ) : (
            <ul className="space-y-2">
              {data.ideas.map((idea) => (
                <li key={idea.id} className="rounded-lg border border-bone/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-bone">{idea.summary}</p>
                      {idea.detail && <p className="mt-1 break-words text-[13px] text-bone-faint">{idea.detail}</p>}
                      <p className="mt-2 text-[12px] text-bone-faint">
                        <span className={STATUS_TONE[idea.status]}>{STATUS_LABEL[idea.status]}</span>
                        {' · '}
                        {provenance(idea)}
                        {' · '}
                        {timeAgo(idea.createdAt)}
                        {idea.source !== 'you' && idea.effectiveScore !== idea.score && (
                          // Ageing is visible, because an idea quietly sinking
                          // down a list it is still on looks like a bug.
                          <span> · worth {idea.effectiveScore} now, {idea.score} when captured</span>
                        )}
                      </p>
                      {idea.attempts > 0 && idea.lastError && (
                        <p className="mt-2 break-words text-[12px] text-amber-300">
                          {idea.attempts === 1 ? 'One attempt' : `${idea.attempts} attempts`} so far. {idea.lastError}
                        </p>
                      )}
                    </div>

                    {idea.status !== 'used' && (
                      <div className="flex shrink-0 gap-2">
                        {idea.status === 'discarded' ? (
                          <button
                            type="button"
                            disabled={busy === idea.id}
                            onClick={() => setStatus(idea, 'unused')}
                            className="inline-flex items-center gap-1.5 rounded border border-bone/20 px-2.5 py-1 text-[12px] text-bone hover:border-bone/40 disabled:opacity-50"
                          >
                            <RotateCcw className="h-3 w-3" /> Put back
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy === idea.id}
                            onClick={() => setStatus(idea, 'discarded')}
                            className="inline-flex items-center gap-1.5 rounded border border-bone/20 px-2.5 py-1 text-[12px] text-bone-faint hover:border-bone/40 hover:text-bone disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" /> Set aside
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add an idea">
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-bone-faint">
            Write it as a note to yourself, not as the post. The agent writes the post in its own voice; this is what it
            is about. Anything you add here waits its turn without ageing.
          </p>
          <Field label="The idea">
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={2}
              className="w-full rounded border border-bone/20 bg-black/30 px-3 py-2 text-sm text-bone"
              placeholder="Why the schedule matters more than the throughput number"
            />
          </Field>
          <Field label="Anything else it should know" hint="Optional.">
            <textarea
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              rows={3}
              className="w-full rounded border border-bone/20 bg-black/30 px-3 py-2 text-sm text-bone"
            />
          </Field>
          {error && <p className="break-words text-[13px] text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="rounded border border-bone/20 px-3 py-1.5 text-[13px] text-bone-faint">
              Cancel
            </button>
            <button
              type="button"
              disabled={summary.trim().length < 5 || busy === 'add'}
              onClick={add}
              className="rounded border border-bone/30 px-3 py-1.5 text-[13px] text-bone disabled:opacity-40"
            >
              {busy === 'add' ? 'Adding...' : 'Add it'}
            </button>
          </div>
        </div>
      </Modal>
    </Section>
  );
}
