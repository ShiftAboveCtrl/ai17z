import { useMemo, useState } from 'react';
import { Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { MEMORY_SCOPES } from '@xbam/shared/contracts';
import type { InspectableMemory } from '@xbam/shared/contracts';
import { ApiError, del, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { compactNumber, timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner } from '@app/components/ui';
import { Section } from './Section';

interface MemoryPage {
  items: InspectableMemory[];
  total: number;
  counts: Record<string, number>;
}

/**
 * Memory opens as counts, not as a table. The table exists, but you have to ask
 * for it: a wall of rows is the wrong first impression of what an agent knows.
 */
export function MemorySection({
  index,
  agentId,
  counts,
}: {
  index: number;
  agentId: string;
  counts: Record<string, number>;
}) {
  const [scope, setScope] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState<string>('KNOWLEDGE');
  const [newHandle, setNewHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: '40', offset: String(offset) });
    if (scope) params.set('scopes', scope);
    if (query) params.set('search', query);
    return `/api/agents/${agentId}/memories?${params.toString()}`;
  }, [agentId, scope, query, offset]);

  const page = useResource<MemoryPage>(path);
  const currentCounts = page.data?.counts ?? counts;
  const total = Object.values(currentCounts).reduce((sum, n) => sum + n, 0);

  const addMemory = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agentId}/memories`, {
        scope: newScope,
        memoryType: newScope === 'KNOWLEDGE' ? 'DOCUMENT' : 'FACT',
        content: newContent.trim(),
        remoteHandle: newScope === 'USER' ? newHandle.trim() : undefined,
        pinned: true,
        importance: 0.9,
      });
      setAdding(false);
      setNewContent('');
      setNewHandle('');
      setOffset(0);
      page.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That memory could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const changeMemory = async (memory: InspectableMemory, remove: boolean) => {
    if (remove && !window.confirm('Delete this memory permanently? This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      const url = `/api/agents/${agentId}/memories/${memory.id}`;
      if (remove) await del(url);
      else await patch(url, { pinned: !memory.pinned });
      if (remove && page.data?.items.length === 1 && offset > 0) setOffset(Math.max(0, offset - 40));
      page.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That memory could not be changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="memory"
      index={index}
      eyebrow="Memory"
      heading="What it remembers."
      lede="Six scopes, written by explicit policy and retrieved by explicit rules. Every generation records which memories it used and why."
      explain={
        <>
          <p><strong>What the agent remembers between conversations</strong>, so somebody who spoke to it last week is not a stranger this week.</p>
          <p>It remembers facts about people it has talked to, what was said in a thread, and what it has been taught. It is not a transcript: things fade unless they keep proving useful.</p>
        </>
      }
    >
      <div className="mb-12">
        <p className="text-[16vw] font-light leading-none tracking-monument text-bone sm:text-[7vw]">{compactNumber(total)}</p>
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-ink-line bg-ink-line sm:grid-cols-3 lg:grid-cols-6">
          {MEMORY_SCOPES.map((s) => {
            const active = scope === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => { setScope(active ? null : s); setOffset(0); }}
                className={`px-4 py-5 text-left transition-colors ${active ? 'bg-signal-calm/[0.09]' : 'bg-ink hover:bg-white/[0.02]'}`}
                aria-pressed={active}
              >
                <span className="block text-2xl font-light text-bone">{currentCounts[s] ?? 0}</span>
                <span className="mt-1 block font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">{s}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form
          className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-2 rounded-lg border border-ink-line bg-ink-panel px-3 sm:basis-auto"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
            setOffset(0);
          }}
        >
          <label htmlFor={`memory-search-${agentId}`} className="w-full pt-2 text-xs text-bone-dim">Search memories</label>
          <Search className="h-4 w-4 shrink-0 text-bone-dim" aria-hidden />
          <input
            id={`memory-search-${agentId}`}
            type="search"
            name="memory-search"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-base text-bone placeholder:text-bone-dim"
            placeholder="A fact or subject"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search memories"
          />
          <button type="submit" className="btn-quiet min-h-12">Search</button>
        </form>
        <button type="button" className="btn-ghost min-h-12" onClick={() => setAdding(true)}>
          Teach it something
        </button>
      </div>

      {error && !adding && <p role="alert" className="mb-4 text-sm text-signal-fail">{error}</p>}
      {page.error ? (
        <div role="alert" className="text-sm text-signal-fail">
          <p>{page.error}</p>
          <button type="button" className="btn-ghost mt-3 min-h-12" onClick={page.reload}>Retry memories</button>
        </div>
      ) : page.loading ? (
        <Spinner />
      ) : page.data && page.data.items.length === 0 ? (
        <EmptyState
          title={query || scope ? 'Nothing matches that.' : 'No memories yet.'}
          detail={query || scope ? 'Try a different scope or search term.' : 'Memories appear as the agent works, or you can write one yourself.'}
          action={
            // Only when the list is genuinely empty. Offering "write one" to
            // somebody whose search matched nothing answers a question they
            // did not ask.
            query || scope ? undefined : (
              <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
                Write one yourself
              </button>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-ink-line border-y border-ink-line">
          {page.data?.items.map((memory) => (
            <li key={memory.id} className="group grid grid-cols-[1fr_auto] items-start gap-3 py-5 sm:grid-cols-[5rem_minmax(0,1fr)_auto]">
              <span className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-bone-dim">{memory.scope}</span>
              <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-bone">{memory.content}</p>
                <p className="mt-1.5 text-xs text-bone-dim">
                  {memory.remoteHandle ? `@${memory.remoteHandle} · ` : ''}
                  importance {memory.importance.toFixed(2)} · {timeAgo(memory.createdAt)}
                </p>
                <div className="mt-4 space-y-2 break-words text-sm leading-relaxed text-bone-dim">
                  <p><strong className="font-medium text-bone">Last retrieval: </strong>{memory.reason ?? 'No retrieval reason recorded.'}</p>
                  {memory.reasonJobId && <p className="text-xs">Recorded for job {memory.reasonJobId}</p>}
                  {memory.evidence.map((source) => (
                    <div key={`${source.kind}:${source.id}`}>
                      <p><strong className="font-medium text-bone">Source: </strong>{source.label}</p>
                      {source.text && <p className="whitespace-pre-wrap">{source.text}</p>}
                      {source.url && /^https?:\/\//i.test(source.url) && <a className="underline" href={source.url} target="_blank" rel="noreferrer">Open source</a>}
                    </div>
                  ))}
                  {memory.origin && Object.keys(memory.origin).length > 0 && <details>
                    <summary className="min-h-12 cursor-pointer py-3 text-bone">Recorded origin</summary>
                    <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(memory.origin, null, 2)}</pre>
                  </details>}
                  {!memory.evidence.length && !memory.origin && <p>No source evidence recorded.</p>}
                </div>
              </div>
              <div className="col-start-2 row-start-1 flex gap-1 sm:col-start-3">
                <button type="button" className="btn-quiet min-h-12 min-w-12 p-3" disabled={busy} onClick={() => void changeMemory(memory, false)} aria-label={memory.pinned ? 'Unpin memory' : 'Pin memory'} aria-pressed={memory.pinned}>
                  {memory.pinned ? <Pin className="h-3.5 w-3.5 text-signal-calm" aria-hidden /> : <PinOff className="h-3.5 w-3.5" aria-hidden />}
                </button>
                <button type="button" className="btn-quiet min-h-12 min-w-12 p-3 hover:text-signal-fail" disabled={busy} onClick={() => void changeMemory(memory, true)} aria-label="Delete memory">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {page.data && page.data.total > 0 && (
        <nav aria-label="Memory pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-bone-dim">
          <p>Showing {offset + 1} to {offset + page.data.items.length} of {page.data.total}</p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost min-h-12" disabled={offset === 0 || page.loading} onClick={() => setOffset(Math.max(0, offset - 40))} aria-label="Previous memories">Previous</button>
            <button type="button" className="btn-ghost min-h-12" disabled={offset + 40 >= page.data.total || page.loading} onClick={() => setOffset(offset + 40)} aria-label="Next memories">Next</button>
          </div>
        </nav>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add a memory">
        <div className="space-y-5">
          <Field label="Scope" htmlFor="mscope" hint="KNOWLEDGE for reference material, USER for a fact about a person, PERSONA for something the agent itself holds.">
            <select id="mscope" className="field" value={newScope} onChange={(e) => setNewScope(e.target.value)}>
              {MEMORY_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          {newScope === 'USER' && (
            <Field label="About whom" htmlFor="mhandle" hint="The remote handle this fact belongs to.">
              <input id="mhandle" className="field" value={newHandle} onChange={(e) => setNewHandle(e.target.value)} placeholder="alice" />
            </Field>
          )}
          <Field label="Content" htmlFor="mcontent">
            <textarea id="mcontent" rows={5} className="field resize-y" value={newContent} onChange={(e) => setNewContent(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-signal-fail">{error}</p>}
          <button type="button" className="btn-primary w-full" onClick={() => void addMemory()} disabled={busy || !newContent.trim()}>
            {busy && <Spinner />}
            Save memory
          </button>
        </div>
      </Modal>
    </Section>
  );
}
