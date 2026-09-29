import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useResource } from '@app/lib/hooks';
import { destinationsFor, searchDestinations } from '@app/lib/destinations';
import type { AgentListItem } from '@app/lib/types';
import { Modal } from '@app/components/ui';

/**
 * Find a setting by typing what it is called.
 *
 * Ctrl+K or Cmd+K anywhere, or the search button in the bar. Up and down move,
 * Enter goes. Every result is a real place in the app; see `destinations.ts`.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        className="btn-quiet p-2"
        aria-label="Search settings (Ctrl+K)"
        title="Search settings (Ctrl+K)"
        onClick={() => setOpen(true)}
      >
        <Search className="h-4 w-4" aria-hidden />
      </button>
      {open && <Palette onClose={() => setOpen(false)} />}
    </>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const agents = useResource<{ items: AgentListItem[] }>('/api/agents');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo(
    () =>
      destinationsFor(
        (agents.data?.items ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          accounts: a.accounts.map((l) => ({ accountId: l.accountId, channel: l.channel })),
        })),
      ),
    [agents.data],
  );
  const results = useMemo(() => searchDestinations(query, all), [query, all]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => input.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, []);

  const go = (index: number) => {
    const target = results[index];
    if (!target) return;
    onClose();
    navigate(target.href);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(active);
    }
  };

  return (
    <Modal open onClose={onClose} title="Find a setting">
      <label htmlFor="palette-input" className="sr-only">
        What are you looking for?
      </label>
      <input
        id="palette-input"
        ref={input}
        className="field w-full"
        placeholder="social radar, beliefs, knowledge, browser..."
        value={query}
        autoComplete="off"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-results"
        aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <ul id="palette-results" role="listbox" aria-label="Places" className="mt-3 max-h-[50vh] space-y-0.5 overflow-y-auto">
        {results.map((d, i) => (
          <li
            key={d.id}
            id={`palette-${d.id}`}
            role="option"
            aria-selected={i === active}
            className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-2 ${
              i === active ? 'bg-ink-line/60 text-bone' : 'text-bone-dim hover:bg-ink-line/30'
            }`}
            onMouseEnter={() => setActive(i)}
            onClick={() => go(i)}
          >
            <span className="min-w-0 truncate text-sm">{d.title}</span>
            <span className="shrink-0 truncate text-[11px] text-bone-faint">{d.where}</span>
          </li>
        ))}
        {results.length === 0 && <li className="px-3 py-2 text-sm text-bone-faint">Nothing is called that. Try another word.</li>}
      </ul>
    </Modal>
  );
}
