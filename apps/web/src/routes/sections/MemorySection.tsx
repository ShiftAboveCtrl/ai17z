import { useMemo, useState } from 'react';
import { Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { MEMORY_SCOPES } from '@xbam/shared/contracts';
import type { MemoryRecord } from '@app/lib/types';
import { ApiError, del, patch, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { compactNumber, timeAgo } from '@app/lib/format';
import { EmptyState, Field, Modal, Spinner } from '@app/components/ui';
import { Section } from './Section';

interface MemoryPage {
  items: MemoryRecord[];
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
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState<string>('KNOWLEDGE');
  const [newHandle, setNewHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: '40' });
    if (scope) params.set('scopes', scope);
    if (query) params.set('search', query);
    return `/api/agents/${agentId}/memories?${params.toString()}`;
  }, [agentId, scope, query]);

  const page = useResource<MemoryPage>(path);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

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
      page.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That memory could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (memory: MemoryRecord) => {
    await patch(`/api/agents/${agentId}/memories/${memory.id}`, { pinned: !memory.pinned }).catch(() => undefined);
    page.reload();
  };

  const remove = async (memory: MemoryRecord) => {
    await del(`/api/agents/${agentId}/memories/${memory.id}`).catch(() => undefined);
    page.reload();
  };

  return (
    <Section
      id="memory"
      index={index}
      eyebrow="Memory"
      heading="What it remembers."
      lede="Six scopes, written by explicit policy and retrieved by explicit rules. Every generation records which memories it used and why."
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
                onClick={() => setScope(active ? null : s)}
                className={`px-4 py-5 text-left transition-colors ${active ? 'bg-signal-calm/[0.09]' : 'bg-ink hover:bg-white/[0.02]'}`}
                aria-pressed={active}
              >
                <span className="block text-2xl font-light text-bone">{counts[s] ?? 0}</span>
                <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.18em] text-bone-faint">{s}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form
          className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-lg border border-ink-line bg-ink-panel px-3"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
          }}
        >
          <Search className="h-4 w-4 shrink-0 text-bone-faint" aria-hidden />
          <input
            className="w-full bg-transparent py-2.5 text-sm text-bone placeholder:text-bone-faint focus:outline-none"
            placeholder="Search memories"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search memories"
          />
        </form>
        <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
          Teach it something
        </button>
      </div>

      {page.loading && !page.data ? (
        <Spinner />
      ) : page.data && page.data.items.length === 0 ? (
        <EmptyState
          title={query || scope ? 'Nothing matches that.' : 'No memories yet.'}
          detail={query || scope ? 'Try a different scope or search term.' : 'Memories appear as the agent works, or you can write one yourself.'}
        />
      ) : (
        <ul className="divide-y divide-ink-line border-y border-ink-line">
          {page.data?.items.map((memory) => (
            <li key={memory.id} className="group flex items-start gap-4 py-4">
              <span className="mt-1 w-20 shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-bone-faint">{memory.scope}</span>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-bone-dim">{memory.content}</p>
                <p className="mt-1.5 font-mono text-[10px] text-bone-faint">
                  {memory.remoteHandle ? `@${memory.remoteHandle} · ` : ''}
                  importance {memory.importance.toFixed(2)} · {timeAgo(memory.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                <button type="button" className="btn-quiet p-2" onClick={() => void togglePin(memory)} aria-label={memory.pinned ? 'Unpin memory' : 'Pin memory'}>
                  {memory.pinned ? <Pin className="h-3.5 w-3.5 text-signal-calm" aria-hidden /> : <PinOff className="h-3.5 w-3.5" aria-hidden />}
                </button>
                <button type="button" className="btn-quiet p-2 hover:text-signal-fail" onClick={() => void remove(memory)} aria-label="Delete memory">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {page.data && page.data.total > page.data.items.length && (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
          Showing {page.data.items.length} of {page.data.total}
        </p>
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
