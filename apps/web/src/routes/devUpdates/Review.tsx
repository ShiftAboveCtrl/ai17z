import { useId, useState } from 'react';
import { Check, PencilLine, X } from 'lucide-react';
import { post } from '@app/lib/api';
import { timeAgo } from '@app/lib/format';
import { EmptyState } from '@app/components/ui';
import { KIND_WORDS, POST_MAX_CHARS, type DevUpdate } from '@app/lib/devUpdates';
import { CharMeter, PostPreview, ProblemList, problemOf } from './parts';

type Agent = { id: string; name: string; avatarUrl?: string | null } | null;

/**
 * Drafts waiting for the owner: what changed, why, the evidence, and the exact
 * post. Approve it, edit it and approve the edit, or reject it with a reason.
 *
 * Editing is the approve route's own `editedText`, the one path the server
 * has; the edited text goes through every rule again there, and a refusal
 * comes back listing what to change.
 */
export function Review({
  updates,
  agent,
  handle,
  rehearse,
  onDecided,
}: {
  updates: DevUpdate[];
  agent: Agent;
  handle: string | null;
  rehearse: boolean;
  onDecided: () => void;
}) {
  if (updates.length === 0) {
    return (
      <EmptyState
        title="Nothing is waiting for you"
        detail="When your coding assistant shares something it finished, the draft post appears here for you to read before anything goes out."
      />
    );
  }
  return (
    <ol className="space-y-5">
      {updates.map((update) => (
        <li key={update.id}>
          <Draft update={update} agent={agent} handle={handle} rehearse={rehearse} onDecided={onDecided} />
        </li>
      ))}
    </ol>
  );
}

function Draft({
  update,
  agent,
  handle,
  rehearse,
  onDecided,
}: {
  update: DevUpdate;
  agent: Agent;
  handle: string | null;
  rehearse: boolean;
  onDecided: () => void;
}) {
  const [mode, setMode] = useState<'read' | 'edit' | 'reject'>('read');
  const [text, setText] = useState(update.post);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string[] | null>(null);
  const headingId = useId();
  const editId = useId();
  const noteId = useId();

  const decide = async (what: 'approve' | 'reject') => {
    setProblem(null);
    if (what === 'reject' && !note.trim()) {
      setProblem(['Say why, in a few words. It is kept with the update so you and your assistant can see it later.']);
      return;
    }
    const body =
      what === 'reject'
        ? { note: note.trim() }
        : mode === 'edit' && text.trim() !== update.post
          ? { editedText: text.trim() }
          : {};
    setBusy(true);
    try {
      await post(`/api/dev-updates/updates/${update.id}/${what}`, body);
      onDecided();
    } catch (error) {
      setProblem(problemOf(error, what === 'approve' ? 'It could not be approved.' : 'It could not be rejected.'));
    } finally {
      setBusy(false);
    }
  };

  const tooLong = text.trim().length > POST_MAX_CHARS;

  return (
    <article aria-labelledby={headingId} className="panel overflow-hidden">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip">{KIND_WORDS[update.kind] ?? update.kind}</span>
            <span className="font-mono text-[11px] text-bone-dim">{timeAgo(update.createdAt)}</span>
          </div>
          <h3 id={headingId} className="break-words text-lg font-light leading-snug text-bone">
            {update.title}
          </h3>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="eyebrow text-bone-dim">What changed</dt>
              <dd className="mt-1 break-words leading-relaxed text-bone-dim">{update.summary}</dd>
            </div>
            <div>
              <dt className="eyebrow text-bone-dim">Why it matters</dt>
              <dd className="mt-1 break-words leading-relaxed text-bone-dim">{update.why}</dd>
            </div>
            <div>
              <dt className="eyebrow text-bone-dim">Evidence</dt>
              <dd className="mt-1">
                <ul className="space-y-1.5">
                  {update.evidence.map((e, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2 break-words text-bone-dim">
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-dim">
                        {e.type.toLowerCase().replace(/_/g, ' ')}
                      </span>
                      {e.ref && <span className="break-all font-mono text-[12px] text-bone">{e.ref}</span>}
                      <span className="min-w-0 break-words">{e.detail}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
          {update.reason && update.reason !== 'Waiting for the owner to approve or reject it.' && (
            <p className="break-words rounded-lg border border-signal-wait/30 bg-signal-wait/[0.05] px-3 py-2 text-xs leading-relaxed text-bone-dim">
              {update.reason}
            </p>
          )}
        </div>

        <div className="space-y-4 border-t border-ink-line bg-ink-panel/60 p-4 sm:p-5 lg:border-l lg:border-t-0">
          <p className="eyebrow text-bone-dim">{rehearse ? 'The post, as it would appear' : 'The post'}</p>
          <PostPreview agent={agent} handle={handle} text={update.post} edited={update.edited}>
            {mode === 'edit' ? (
              <div className="mt-3 space-y-2">
                <label htmlFor={editId} className="sr-only">
                  Edit the post
                </label>
                <textarea
                  id={editId}
                  className="field min-h-[140px] resize-y text-[15px] leading-relaxed"
                  value={text}
                  maxLength={400}
                  autoFocus
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="flex justify-end">
                  <CharMeter length={text.trim().length} />
                </div>
              </div>
            ) : undefined}
          </PostPreview>

          {mode === 'reject' && (
            <div className="space-y-2">
              <label htmlFor={noteId} className="block font-mono text-[10px] uppercase tracking-[0.2em] text-bone-dim">
                Why not
              </label>
              <textarea
                id={noteId}
                className="field min-h-[80px] resize-y text-sm"
                value={note}
                maxLength={500}
                autoFocus
                placeholder="Not announced yet"
                onChange={(e) => setNote(e.target.value)}
              />
              <p className="text-xs leading-relaxed text-bone-dim">
                The draft's words are deleted. Your reason stays, and the same update will not be asked about again.
              </p>
            </div>
          )}

          <ProblemList lines={problem} />

          <div className="flex flex-wrap gap-2">
            {mode === 'reject' ? (
              <>
                <button type="button" className="btn-danger" disabled={busy} onClick={() => void decide('reject')}>
                  <X className="h-4 w-4" aria-hidden /> {busy ? 'Rejecting…' : 'Reject it'}
                </button>
                <button type="button" className="btn-quiet" disabled={busy} onClick={() => { setMode('read'); setProblem(null); }}>
                  Back
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn-primary" disabled={busy || (mode === 'edit' && (tooLong || !text.trim()))} onClick={() => void decide('approve')}>
                  <Check className="h-4 w-4" aria-hidden />
                  {busy ? 'Approving…' : mode === 'edit' ? 'Approve my version' : 'Approve'}
                </button>
                {mode === 'edit' ? (
                  <button
                    type="button"
                    className="btn-quiet"
                    disabled={busy}
                    onClick={() => {
                      setMode('read');
                      setText(update.post);
                      setProblem(null);
                    }}
                  >
                    Discard my edit
                  </button>
                ) : (
                  <button type="button" className="btn-ghost" disabled={busy} onClick={() => setMode('edit')}>
                    <PencilLine className="h-4 w-4" aria-hidden /> Edit
                  </button>
                )}
                {mode === 'read' && (
                  <button type="button" className="btn-quiet sm:ml-auto" disabled={busy} onClick={() => setMode('reject')}>
                    Reject
                  </button>
                )}
              </>
            )}
          </div>
          <p className="text-xs leading-relaxed text-bone-dim">
            {rehearse
              ? 'This project rehearses, so approving checks it end to end without publishing it.'
              : `Approving queues it for ${handle ? `@${handle}` : 'the account'}, within the daily ceiling and spacing.`}
          </p>
        </div>
      </div>
    </article>
  );
}
