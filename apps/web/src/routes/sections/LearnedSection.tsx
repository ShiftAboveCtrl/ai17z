import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ApiError, del } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, Spinner } from '@app/components/ui';
import { Section } from './Section';

type Kind = 'MEMORY' | 'RELATIONSHIP' | 'STANCE' | 'ENTITY' | 'COMMITMENT';

interface LearnedItem {
  kind: Kind;
  id: string;
  summary: string;
  detail: string | null;
  scope: string | null;
  source: string | null;
  confidence: number | null;
  active: boolean;
  learnedAt: string;
}

/** What each kind is, said the way somebody would say it. */
const WORDS: Record<Kind, string> = {
  MEMORY: 'Remembered',
  RELATIONSHIP: 'Somebody it knows',
  STANCE: 'A position it holds',
  ENTITY: 'Something it has seen named',
  COMMITMENT: 'Something it promised',
};

/**
 * Which kinds can be forgotten one at a time, and why the others cannot.
 *
 * A relationship and an entity are records of what happened, not opinions the
 * agent formed -- deleting one would be editing history rather than changing a
 * belief, and the conversation it came from would recreate it on the next pass.
 */
const FORGETTABLE: Kind[] = ['MEMORY', 'STANCE', 'COMMITMENT'];

/**
 * What the agent has learned, and where each piece came from.
 *
 * Two questions, and the screen exists to answer them: why does my agent
 * remember this, and how do I make it forget. So every row carries its origin
 * and, where it is something the agent decided rather than something that
 * happened, a way to remove it.
 *
 * Read across memory, relationships, stances, entities and commitments rather
 * than from a store of its own. Each is written by the part of the runtime that
 * owns it, and a parallel copy would be one more thing to keep in step.
 */
export function LearnedSection({ index, agentId }: { index: number; agentId: string }) {
  const view = useResource<{ items: LearnedItem[] }>(`/api/agents/${agentId}/learned`);
  const [kind, setKind] = useState<Kind | 'ALL'>('ALL');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const forget = async (item: LearnedItem) => {
    setBusy(item.id);
    setError(null);
    try {
      await del(`/api/agents/${agentId}/learned/${item.kind.toLowerCase()}/${item.id}`);
      view.reload();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'That could not be forgotten.');
    } finally {
      setBusy(null);
    }
  };

  const items = view.data?.items ?? [];
  const shown = kind === 'ALL' ? items : items.filter((item) => item.kind === kind);
  const kinds = [...new Set(items.map((item) => item.kind))];

  return (
    <Section
      id="learned"
      index={index}
      eyebrow="Learned"
      heading="What it has picked up"
      lede="Everything this agent has learned, and where each piece came from. This is the whole of it: there is no other memory behind this screen."
    >
      {view.loading && <Spinner />}

      {view.data && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['ALL', ...kinds] as (Kind | 'ALL')[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setKind(key)}
                className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                  key === kind ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'
                }`}
              >
                {key === 'ALL' ? 'Everything' : WORDS[key]}
                <span className="ml-2 font-mono text-[11px] text-bone-faint">
                  {key === 'ALL' ? items.length : items.filter((i) => i.kind === key).length}
                </span>
              </button>
            ))}
          </div>

          {error && <p className="break-words text-[13px] text-red-300">{error}</p>}

          {shown.length === 0 ? (
            <EmptyState
              title="It has not learned anything yet"
              detail="Memory, relationships and positions are all built from conversations it has actually had."
            />
          ) : (
            <ul className="space-y-2">
              {shown.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="rounded-lg border border-bone/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-bone">{item.summary}</p>
                      {item.detail && item.detail !== item.summary && (
                        <p className="mt-1 break-words text-[13px] text-bone-faint">{item.detail.slice(0, 300)}</p>
                      )}
                      {/* The answer to "why does it remember this". */}
                      <p className="mt-2 text-[12px] text-bone-faint">
                        {WORDS[item.kind]}
                        {item.scope && ` · ${item.scope.toLowerCase()}`}
                        {item.source && ` · from ${item.source}`}
                        {` · ${timeAgo(item.learnedAt)}`}
                        {item.confidence !== null && ` · held at ${Math.round(Number(item.confidence) * 100)}%`}
                        {!item.active && ' · no longer active'}
                      </p>
                    </div>

                    {FORGETTABLE.includes(item.kind) ? (
                      <button
                        type="button"
                        disabled={busy === item.id}
                        onClick={() => void forget(item)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-bone/20 px-2.5 py-1 text-[12px] text-bone-faint hover:border-bone/40 hover:text-bone disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" /> Forget this
                      </button>
                    ) : (
                      <span className="shrink-0 text-[11px] text-bone-faint">
                        {/* Said rather than left as a missing button. */}
                        a record, not an opinion
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
