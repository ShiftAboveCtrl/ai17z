import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { ApiError, del, post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, ErrorPanel, SavedTick, Spinner, StatusDot } from './ui';
import { AddSourceModal, ReviewModal, type Source, type SourceKind, type Trait } from './PersonaSourceModals';

const STATUS_TONE = { READY: 'live', SYNCING: 'wait', IDLE: 'idle', ERROR: 'fail', UNAVAILABLE: 'fail' } as const;

/**
 * Learning an identity from a public corpus.
 *
 * Deliberately shows its working: how much was collected, how much was kept, and
 * why each excluded item was dropped. The owner can overrule any of it, and every
 * derived trait links back to the material it came from.
 */
export function PersonaSources({ agentId, onApplied }: { agentId: string; onApplied: () => void }) {
  const data = useResource<{ items: Source[]; traits: Trait[] }>(`/api/agents/${agentId}/persona-sources`);
  const kinds = useResource<{ items: SourceKind[] }>('/api/persona-source-kinds');

  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [reviewing, setReviewing] = useState<Source | null>(null);

  const syncing = (data.data?.items ?? []).some((s) => s.status === 'SYNCING');
  usePolling(() => data.reload(), 2000, syncing);

  // When each source was first seen syncing, so the row can show how long it
  // has been going. A sync can pull thousands of posts, and "syncing..." on its
  // own is indistinguishable from a sync that died.
  const startedAt = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  useEffect(() => {
    for (const source of data.data?.items ?? []) {
      if (source.status === 'SYNCING') {
        if (!startedAt.current.has(source.id)) startedAt.current.set(source.id, Date.now());
      } else {
        startedAt.current.delete(source.id);
      }
    }
  }, [data.data]);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [syncing]);

  const elapsedFor = (id: string) => {
    const began = startedAt.current.get(id);
    return began ? Math.round((Date.now() - began) / 1000) : 0;
  };

  const createAndSync = async (input: { kind: 'x_public' | 'manual'; handle: string; text: string; depth: number }) => {
    setBusy(true);
    setError(null);
    try {
      const source = await post<Source>(`/api/agents/${agentId}/persona-sources`, {
        kind: input.kind,
        handle: input.kind === 'x_public' ? input.handle.trim() : null,
        label: input.kind === 'x_public' ? `@${input.handle.trim().replace(/^@/, '')}` : 'Pasted text',
      });
      await post(`/api/persona-sources/${source.id}/sync`, {
        text: input.kind === 'manual' ? input.text : undefined,
        limit: input.depth,
      });
      setAdding(false);
      data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That source could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const resync = async (source: Source) => {
    if (source.kind === 'manual') {
      setError('A pasted source is re-synced by adding the text again.');
      return;
    }
    await post(`/api/persona-sources/${source.id}/sync`, { limit: 2000 }).catch(() => undefined);
    data.reload();
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/persona-sources/apply`, { replaceExamples: true });
      setApplied(true);
      setTimeout(() => setApplied(false), 2600);
      onApplied();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The persona could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const traits = data.data?.traits ?? [];
  const grouped = (k: Trait['kind']) => traits.filter((t) => t.kind === k);

  return (
    <div className="space-y-6 rounded-xl border border-ink-line bg-ink-panel/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Learn from a corpus</p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-bone-faint">
            Source material is evidence, not memory. It is filtered, scored, and distilled into a compact profile; the
            raw posts never go into a prompt.
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add source
        </button>
      </div>

      {error && <ErrorPanel title="That did not work." detail={error} />}

      {(data.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No sources yet."
          detail="Paste a few dozen representative posts, or point this at a public X account."
        />
      ) : (
        <ul className="divide-y divide-ink-line border-y border-ink-line">
          {data.data?.items.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
              <StatusDot state={STATUS_TONE[source.status]} />
              <span className="text-sm text-bone">{source.label || source.handle || source.kind}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{source.kind}</span>
              <span className="ml-auto font-mono text-[11px] text-bone-faint">
                {source.status === 'SYNCING'
                  ? `reading... ${elapsedFor(source.id)}s`
                  : `${source.stats.useful} useful, ${source.stats.excluded} excluded, ${timeAgo(source.lastSyncedAt)}`}
              </span>
              <button type="button" className="btn-quiet text-xs" onClick={() => setReviewing(source)}>
                Review
              </button>
              <button type="button" className="btn-quiet p-2" onClick={() => void resync(source)} aria-label="Sync again">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                className="btn-quiet p-2 hover:text-signal-fail"
                aria-label="Remove source"
                onClick={() => void del(`/api/persona-sources/${source.id}`).then(() => data.reload())}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
              {source.status === 'SYNCING' && elapsedFor(source.id) >= 20 && (
                <p className="w-full text-xs leading-relaxed text-bone-faint">
                  Still reading. Large accounts take a few minutes; nothing is written until it finishes.
                </p>
              )}
              {source.lastError && (
                <div className="w-full">
                  <p className="text-xs leading-relaxed text-signal-fail">{source.lastError}</p>
                  <button type="button" className="btn-quiet px-0 text-xs" onClick={() => void resync(source)}>
                    Try again
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {traits.length > 0 && (
        <div className="space-y-4">
          <p className="eyebrow">What it learned ({traits.length} traits)</p>
          {(['style', 'belief', 'topic', 'example'] as const).map((k) =>
            grouped(k).length === 0 ? null : (
              <div key={k}>
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">{k}</p>
                <ul className="mt-1.5 space-y-1.5">
                  {grouped(k)
                    .slice(0, k === 'example' ? 5 : 8)
                    .map((trait) => (
                      <li key={trait.id} className="text-sm leading-relaxed text-bone-dim">
                        {trait.content}
                        {trait.evidence.length > 0 && (
                          <span className="ml-2 font-mono text-[10px] text-bone-faint">
                            from {trait.evidence.length} item{trait.evidence.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ),
          )}
          <div className="flex items-center gap-3 border-t border-ink-line pt-4">
            <button type="button" className="btn-primary" onClick={() => void apply()} disabled={busy}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
              Write into a new persona version
            </button>
            <SavedTick visible={applied} />
          </div>
        </div>
      )}

      <AddSourceModal
        open={adding}
        onClose={() => setAdding(false)}
        kinds={kinds.data?.items ?? []}
        busy={busy}
        onSubmit={createAndSync}
      />
      {reviewing && (
        <ReviewModal
          source={reviewing}
          onClose={() => {
            setReviewing(null);
            data.reload();
          }}
        />
      )}
    </div>
  );
}
