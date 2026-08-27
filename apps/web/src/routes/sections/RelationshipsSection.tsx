import { useState } from 'react';
import { ApiError, del, patch } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, SavedTick, Spinner } from '@app/components/ui';
import { IndexedRow, Section } from './Section';

type Familiarity = 'NEW' | 'KNOWN' | 'FAMILIAR' | 'REGULAR';
type Disposition = 'NEUTRAL' | 'FRIENDLY' | 'CAUTIOUS' | 'BLOCKED';

interface Relationship {
  id: string;
  handle: string;
  displayName: string;
  familiarity: Familiarity;
  familiarityPinned: boolean;
  interactionCount: number;
  inboundCount: number;
  outboundCount: number;
  lastInteractionAt: string;
  topics: string[];
  summary: string;
  ownerNote: string;
  disposition: Disposition;
}

interface Callback {
  id: string;
  label: string;
  detail: string;
  useCount: number;
  lastUsedAt: string | null;
  retired: boolean;
}

const LEVELS: { key: Familiarity; label: string; hint: string }[] = [
  { key: 'REGULAR', label: 'Regulars', hint: 'Many exchanges, over weeks' },
  { key: 'FAMILIAR', label: 'Familiar', hint: 'Several conversations' },
  { key: 'KNOWN', label: 'Known', hint: 'Spoken more than once' },
  { key: 'NEW', label: 'New', hint: 'Barely met' },
];

/**
 * Who the agent talks to.
 *
 * The counts come first because that is the question people actually have —
 * does this agent know anybody yet — and the individual profiles are one click
 * behind it rather than a wall of names.
 */
export function RelationshipsSection({ index, agentId }: { index: number; agentId: string }) {
  const [filter, setFilter] = useState<Familiarity | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Relationship | null>(null);

  const params = new URLSearchParams();
  if (filter) params.set('familiarity', filter);
  if (search.trim()) params.set('search', search.trim());
  const { data, loading, reload } = useResource<{ counts: Record<Familiarity, number>; items: Relationship[] }>(
    `/api/agents/${agentId}/relationships?${params.toString()}`,
    [filter, search],
  );

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <Section
      id="relationships"
      index={index}
      eyebrow="Relationships"
      heading="Who it knows."
      lede="Built from conversations that actually happened. Somebody who mentions the agent repeatedly without ever being answered is not a regular."
    >
      {loading && !data ? (
        <Spinner />
      ) : total === 0 ? (
        <EmptyState
          title="Nobody yet."
          detail="A relationship is recorded when the agent replies to somebody. Once it has, this shows what they have discussed."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {LEVELS.map((level) => (
              <button
                key={level.key}
                type="button"
                onClick={() => setFilter(filter === level.key ? null : level.key)}
                className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
                  filter === level.key
                    ? 'border-signal-calm/60 bg-signal-calm/[0.07]'
                    : 'border-ink-line hover:border-bone-faint'
                }`}
              >
                <span className="block font-mono text-2xl font-light tabular-nums text-bone">
                  {data?.counts[level.key] ?? 0}
                </span>
                <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
                  {level.label}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-bone-faint">{level.hint}</span>
              </button>
            ))}
          </div>

          <div className="mt-6">
            <input
              className="field"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find somebody by handle"
              aria-label="Find somebody by handle"
            />
          </div>

          <div className="mt-4 border-b border-ink-line">
            {(data?.items ?? []).map((person, i) => (
              <IndexedRow
                key={person.id}
                index={i + 1}
                label={person.familiarity.toLowerCase()}
                title={`@${person.handle}`}
                meta={
                  person.topics.length > 0
                    ? `${person.topics.slice(0, 3).join(', ')} · ${timeAgo(person.lastInteractionAt)}`
                    : `${Math.min(person.inboundCount, person.outboundCount)} exchanges · ${timeAgo(person.lastInteractionAt)}`
                }
                status={
                  person.disposition !== 'NEUTRAL' ? (
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-signal-wait">
                      {person.disposition.toLowerCase()}
                    </span>
                  ) : undefined
                }
                onClick={() => setOpen(person)}
              />
            ))}
          </div>
        </>
      )}

      {open && (
        <RelationshipModal
          agentId={agentId}
          person={open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            reload();
          }}
        />
      )}
    </Section>
  );
}

function RelationshipModal({
  agentId,
  person,
  onClose,
  onSaved,
}: {
  agentId: string;
  person: Relationship;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, reload } = useResource<{ relationship: Relationship; callbacks: Callback[] }>(
    `/api/agents/${agentId}/relationships/${person.id}`,
  );
  const [note, setNote] = useState(person.ownerNote);
  const [summary, setSummary] = useState(person.summary);
  const [disposition, setDisposition] = useState<Disposition>(person.disposition);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/agents/${agentId}/relationships/${person.id}`, { ownerNote: note, summary, disposition });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const exchanges = Math.min(person.inboundCount, person.outboundCount);

  return (
    <Modal open onClose={onClose} title={`@${person.handle}`} wide>
      <div className="space-y-6">
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-ink-line px-3.5 py-3">
          <Stat label="Familiarity" value={person.familiarity.toLowerCase()} hint={person.familiarityPinned ? 'pinned by you' : undefined} />
          <Stat label="Exchanges" value={String(exchanges)} hint={`${person.inboundCount} in, ${person.outboundCount} out`} />
          <Stat label="Last spoke" value={timeAgo(person.lastInteractionAt)} />
        </div>

        {person.topics.length > 0 && (
          <div>
            <p className="eyebrow mb-2">What you have discussed</p>
            <div className="flex flex-wrap gap-1.5">
              {person.topics.map((topic) => (
                <span key={topic} className="rounded border border-ink-line px-2 py-0.5 text-xs text-bone-dim">
                  {topic}
                </span>
              ))}
            </div>
          </div>
        )}

        <Field label="Summary" htmlFor="relsummary" hint="What the agent believes about this relationship. Correct it if it is wrong.">
          <textarea
            id="relsummary"
            className="field min-h-[4rem]"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>

        <Field
          label="Your note"
          htmlFor="relnote"
          hint="Goes into the prompt as an instruction from you, and outranks anything the agent worked out for itself."
        >
          <textarea id="relnote" className="field min-h-[3rem]" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <Field label="How to treat them" hint="Blocked means the agent will not reply to them at all.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(['NEUTRAL', 'FRIENDLY', 'CAUTIOUS', 'BLOCKED'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDisposition(option)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  disposition === option
                    ? option === 'BLOCKED'
                      ? 'border-signal-fail/60 bg-signal-fail/[0.07] text-bone'
                      : 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                    : 'border-ink-line text-bone-dim hover:border-bone-faint'
                }`}
              >
                {option.toLowerCase()}
              </button>
            ))}
          </div>
        </Field>

        {(data?.callbacks ?? []).filter((c) => !c.retired).length > 0 && (
          <div>
            <p className="eyebrow mb-2">Shared references</p>
            <ul className="space-y-2">
              {(data?.callbacks ?? [])
                .filter((c) => !c.retired)
                .map((callback) => (
                  <li key={callback.id} className="flex items-start gap-3 rounded-lg border border-ink-line px-3.5 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-bone">{callback.label}</span>
                      <span className="mt-0.5 block text-xs text-bone-faint">
                        {callback.detail} · used {callback.useCount}×{' '}
                        {callback.lastUsedAt ? `· last ${timeAgo(callback.lastUsedAt)}` : '· never used'}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-quiet text-xs"
                      onClick={() =>
                        void del(`/api/agents/${agentId}/relationships/${person.id}/callbacks/${callback.id}`).then(reload)
                      }
                    >
                      Retire
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {error && <p className="break-words text-sm text-signal-fail">{error}</p>}

        <div className="flex items-center gap-3">
          <button type="button" className="btn-ghost" onClick={() => void save()} disabled={busy}>
            {busy && <Spinner className="h-3.5 w-3.5" />}
            Save
          </button>
          <SavedTick visible={saved} />
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{label}</p>
      <p className="mt-1 text-sm text-bone">{value}</p>
      {hint && <p className="text-[10px] text-bone-faint">{hint}</p>}
    </div>
  );
}
