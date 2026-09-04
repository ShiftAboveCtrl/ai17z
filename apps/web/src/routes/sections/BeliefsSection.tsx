import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ApiError, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner } from '@app/components/ui';
import { Section } from './Section';

type Position = 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'NEUTRAL' | 'UNCERTAIN';

interface Stance {
  id: string;
  subject: string;
  position: Position;
  summary: string;
  confidence: number;
  pinned: boolean;
  createdAt: string;
  lastReinforcedAt: string;
}

interface Evidence {
  id: string;
  kind: string;
  excerpt: string;
  remoteUrl: string | null;
  createdAt: string;
}

interface Prediction {
  id: string;
  claim: string;
  confidence: number;
  reviewAt: string | null;
  createdAt: string;
}

interface Commitment {
  id: string;
  promise: string;
  recipientHandle: string | null;
  createdAt: string;
  /** OPEN is waiting its turn; DUE is being followed up on now. */
  status: string;
  /** When it will be revisited. Null when it cannot be. */
  dueAt: string | null;
  attempts: number;
  outcome: string;
}

const POSITION_WORDS: Record<Position, string> = {
  POSITIVE: 'positive',
  NEGATIVE: 'sceptical',
  MIXED: 'mixed',
  NEUTRAL: 'no view',
  UNCERTAIN: 'unsure',
};

const POSITION_TONE: Record<Position, string> = {
  POSITIVE: 'text-signal-live',
  NEGATIVE: 'text-signal-fail',
  MIXED: 'text-signal-wait',
  NEUTRAL: 'text-bone-faint',
  UNCERTAIN: 'text-bone-faint',
};

/**
 * What the agent thinks.
 *
 * Confidence is shown as a bar rather than a number: the precision of "0.74" is
 * not real, and inviting somebody to tune it to two decimal places would be a
 * lie about how it was derived.
 */
export function BeliefsSection({ index, agentId }: { index: number; agentId: string }) {
  const { data, loading, reload } = useResource<{
    items: Stance[];
    predictions: Prediction[];
    commitments: Commitment[];
  }>(`/api/agents/${agentId}/stances`);
  const [open, setOpen] = useState<Stance | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Section
      id="beliefs"
      index={index}
      eyebrow="Beliefs"
      heading="What it thinks."
      lede="Positions the agent has taken, and what they rest on. Changing its mind is allowed; changing it by accident is what this prevents."
    >
      {loading && !data ? (
        <Spinner />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No positions yet."
          detail="These build up from what the agent actually posts, or you can write one yourself."
          action={
            <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
              Write a position
            </button>
          }
        />
      ) : (
        <ul className="divide-y divide-ink-line border-y border-ink-line">
          {data?.items.map((stance) => (
            <li key={stance.id}>
              <button
                type="button"
                onClick={() => setOpen(stance)}
                className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 py-4 text-left transition-colors hover:bg-white/[0.02]"
              >
                <span className="text-sm text-bone">{stance.subject}</span>
                <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${POSITION_TONE[stance.position]}`}>
                  {POSITION_WORDS[stance.position]}
                </span>
                {stance.pinned && (
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] text-bone-faint">
                    yours
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <span className="h-1 w-16 overflow-hidden rounded-full bg-ink-line">
                    <span
                      className="block h-full bg-bone-faint"
                      style={{ width: `${Math.round(Number(stance.confidence) * 100)}%` }}
                    />
                  </span>
                  <span className="font-mono text-[10px] text-bone-faint">{timeAgo(stance.lastReinforcedAt)}</span>
                </span>
                <span className="w-full text-xs leading-relaxed text-bone-dim">{stance.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(data?.commitments.length ?? 0) > 0 && (
        <div className="mt-8">
          <p className="eyebrow mb-3">It said it would</p>
          <ul className="space-y-2">
            {data?.commitments.map((commitment) => (
              <li key={commitment.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-line px-3.5 py-3">
                <span className="min-w-0 flex-1 text-sm text-bone-dim">
                  <span className="break-words">{commitment.promise}</span>
                  {commitment.recipientHandle && (
                    <span className="ml-1.5 font-mono text-[11px] text-bone-faint">to @{commitment.recipientHandle}</span>
                  )}
                  {/* Whether this is actually tracked. A promise with no date is
                      one nothing will revisit, and saying so is the difference
                      between a record and a reassurance. */}
                  <span className="mt-1 block text-[11px] text-bone-faint">
                    {commitment.status === 'DUE'
                      ? 'Being followed up on now.'
                      : commitment.dueAt
                        ? `Will be revisited ${timeAgo(commitment.dueAt)}.`
                        : 'Not scheduled: this agent cannot follow up, so nothing will revisit it.'}
                    {commitment.attempts > 0 && ` Tried ${commitment.attempts} time${commitment.attempts === 1 ? '' : 's'}.`}
                    {commitment.outcome && ` ${commitment.outcome}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-quiet text-xs"
                  onClick={() =>
                    void post(`/api/agents/${agentId}/commitments/${commitment.id}`, { status: 'COMPLETED' }).then(reload)
                  }
                >
                  Done
                </button>
                <button
                  type="button"
                  className="btn-quiet text-xs"
                  onClick={() =>
                    void post(`/api/agents/${agentId}/commitments/${commitment.id}`, { status: 'CANCELLED' }).then(reload)
                  }
                >
                  Drop
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(data?.predictions.length ?? 0) > 0 && (
        <div className="mt-8">
          <p className="eyebrow mb-3">It predicted</p>
          <ul className="space-y-2">
            {data?.predictions.map((prediction) => (
              <li key={prediction.id} className="rounded-lg border border-ink-line px-3.5 py-3">
                <p className="text-sm text-bone-dim">{prediction.claim}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="font-mono text-[10px] text-bone-faint">
                    said {timeAgo(prediction.createdAt)}
                    {prediction.reviewAt && ` · worth checking ${timeAgo(prediction.reviewAt)}`}
                  </span>
                  {/* Only a person decides how a prediction turned out. */}
                  {(['CORRECT', 'WRONG', 'UNRESOLVABLE'] as const).map((outcome) => (
                    <button
                      key={outcome}
                      type="button"
                      className="btn-quiet text-xs"
                      onClick={() =>
                        void post(`/api/agents/${agentId}/predictions/${prediction.id}`, { outcome, note: '' }).then(
                          reload,
                        )
                      }
                    >
                      {outcome.toLowerCase()}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8">
        <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Write a position
        </button>
      </div>

      {open && <StanceModal agentId={agentId} stance={open} onClose={() => setOpen(null)} onChanged={reload} />}
      <AddStanceModal
        open={adding}
        agentId={agentId}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          reload();
        }}
      />
    </Section>
  );
}

function StanceModal({
  agentId,
  stance,
  onClose,
  onChanged,
}: {
  agentId: string;
  stance: Stance;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data } = useResource<{ stance: Stance; evidence: Evidence[]; history: Stance[] }>(
    `/api/agents/${agentId}/stances/${stance.id}`,
  );

  const superseded = (data?.history ?? []).filter((h) => h.id !== stance.id);

  return (
    <Modal open onClose={onClose} title={stance.subject} wide>
      <div className="space-y-6">
        <div>
          <p className={`font-mono text-[11px] uppercase tracking-[0.16em] ${POSITION_TONE[stance.position]}`}>
            {POSITION_WORDS[stance.position]} · confidence {Math.round(Number(stance.confidence) * 100)}%
          </p>
          <p className="mt-2 text-sm leading-relaxed text-bone">{stance.summary}</p>
          <p className="mt-2 font-mono text-[10px] text-bone-faint">
            held since {timeAgo(stance.createdAt)} · last reinforced {timeAgo(stance.lastReinforcedAt)}
          </p>
        </div>

        <div>
          <p className="eyebrow mb-2">What this rests on</p>
          {(data?.evidence.length ?? 0) === 0 ? (
            <p className="text-sm text-bone-faint">
              Nothing recorded. A position with no evidence behind it is an assertion.
            </p>
          ) : (
            <ul className="space-y-2">
              {data?.evidence.map((item) => (
                <li key={item.id} className="rounded-lg border border-ink-line px-3.5 py-2.5">
                  <p className="text-xs leading-relaxed text-bone-dim">{item.excerpt}</p>
                  <p className="mt-1 font-mono text-[10px] text-bone-faint">
                    {item.kind === 'told_by_owner' ? 'you told it this' : item.kind} · {timeAgo(item.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {superseded.length > 0 && (
          <div>
            <p className="eyebrow mb-2">What it used to think</p>
            <ul className="space-y-2">
              {superseded.map((old) => (
                <li key={old.id} className="rounded-lg border border-ink-line px-3.5 py-2.5">
                  <p className={`font-mono text-[10px] uppercase tracking-[0.14em] ${POSITION_TONE[old.position]}`}>
                    {POSITION_WORDS[old.position]} · until {timeAgo(old.createdAt)}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-bone-dim">{old.summary}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-quiet text-xs"
            onClick={() =>
              void patch(`/api/agents/${agentId}/stances/${stance.id}`, { pinned: !stance.pinned }).then(() => {
                onChanged();
                onClose();
              })
            }
          >
            {stance.pinned ? 'Let the agent revise this' : 'Pin so the agent cannot revise it'}
          </button>
          <button
            type="button"
            className="btn-quiet text-xs hover:text-signal-fail"
            onClick={() =>
              void patch(`/api/agents/${agentId}/stances/${stance.id}`, { status: 'RETIRED' }).then(() => {
                onChanged();
                onClose();
              })
            }
          >
            Retire this position
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddStanceModal({
  open,
  agentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  agentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [position, setPosition] = useState<Position>('POSITIVE');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/stances`, { subject, position, summary, confidence: 0.85 });
      setSubject('');
      setSummary('');
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Write a position">
      <div className="space-y-5">
        <Field label="About what" htmlFor="ssubject" hint="A project, a person, a topic. Whatever the agent has a view on.">
          <input id="ssubject" className="field" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>

        <Field label="Where it stands">
          <div className="grid grid-cols-3 gap-2">
            {(['POSITIVE', 'NEGATIVE', 'MIXED'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setPosition(option)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  position === option
                    ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                    : 'border-ink-line text-bone-dim hover:border-bone-faint'
                }`}
              >
                {POSITION_WORDS[option]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="In its own words" htmlFor="ssummary" hint="How the agent would state this if asked.">
          <textarea id="ssummary" className="field min-h-[4rem]" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>

        <p className="text-xs leading-relaxed text-bone-faint">
          A position you write is pinned: nothing the agent says will revise it on its own.
        </p>

        {error && <p className="break-words text-sm text-signal-fail">{error}</p>}

        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => void save()}
          disabled={busy || !subject.trim() || !summary.trim()}
        >
          {busy && <Spinner />}
          Save position
        </button>
      </div>
    </Modal>
  );
}
