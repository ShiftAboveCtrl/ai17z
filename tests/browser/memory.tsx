import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemorySection } from '../../apps/web/src/routes/sections/MemorySection';
import '../../apps/web/src/styles.css';

const scopes = ['THREAD', 'USER', 'PERSONA', 'ACCOUNT', 'KNOWLEDGE', 'EPISODIC'];
let items = Array.from({ length: 45 }, (_, i) => ({
  id: `memory-${i}`, scope: scopes[i % 6], content: i === 0 ? `Heron launch guide ${'long-document-path/'.repeat(12)}` : `Heron fact ${i}`,
  importance: 0.7, createdAt: '2026-01-01T00:00:00Z', pinned: false,
  reason: i === 0 ? 'knowledge base: matches "Heron"' : null, reasonJobId: null,
  origin: i === 0 ? { path: 'docs/launch.md', revision: 'r1' } : null,
  evidence: i === 0 ? [{ kind: 'CHAT', id: 'save-1', label: 'Launch discussion', text: 'Heron launches Friday.', url: null }] : [],
}));
let failNext = false;
let failRead = false;
const counts = () => Object.fromEntries(scopes.map((s) => [s, items.filter((m) => m.scope === s).length]));
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith('/api/agents/test/memories')) return originalFetch(input, init);
  if (url.pathname.endsWith('/fail-read')) { failRead = true; return Response.json({ ok: true, data: {} }); }
  if (url.pathname.endsWith('/fail-next')) { failNext = true; return Response.json({ ok: true, data: {} }); }
  if (failRead) { failRead = false; return Response.json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Cannot load memories. Try again.' } }, { status: 503 }); }
  if (init?.method === 'PATCH' || init?.method === 'DELETE') {
    if (failNext) { failNext = false; return Response.json({ ok: false, error: { code: 'UNAVAILABLE', message: 'Memory service unavailable. Try again.' } }, { status: 503 }); }
    const id = url.pathname.split('/').at(-1);
    if (init.method === 'DELETE') items = items.filter((m) => m.id !== id);
    else items = items.map((m) => m.id === id ? { ...m, ...JSON.parse(String(init.body)) } : m);
  }
  const selected = items.filter((m) => (!url.searchParams.get('scopes') || m.scope === url.searchParams.get('scopes')) && m.content.includes(url.searchParams.get('search') ?? ''));
  const offset = Number(url.searchParams.get('offset') ?? 0);
  return Response.json({ ok: true, data: { items: selected.slice(offset, offset + 40), total: selected.length, counts: counts() } });
};
createRoot(document.getElementById('root')!).render(<React.StrictMode><main className="mx-auto max-w-page px-6 sm:px-10"><MemorySection agentId="test" index={1} counts={counts()} /></main></React.StrictMode>);
