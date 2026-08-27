import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { get, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { Field, Modal, Spinner } from './ui';

export interface SourceKind {
  kind: 'x_public' | 'manual';
  displayName: string;
  available: boolean;
  detail: string;
  requirement: string | null;
}

export interface Trait {
  id: string;
  kind: 'style' | 'belief' | 'topic' | 'example' | 'language';
  content: string;
  confidence: number;
  evidence: Array<{ id: string; text: string; url: string | null }>;
}

export interface Source {
  id: string;
  kind: 'x_public' | 'manual';
  handle: string | null;
  label: string;
  status: 'IDLE' | 'SYNCING' | 'READY' | 'ERROR' | 'UNAVAILABLE';
  lastError: string | null;
  lastSyncedAt: string | null;
  stats: { total: number; useful: number; excluded: number };
}

interface Item {
  id: string;
  rawText: string;
  url: string | null;
  classification: string;
  styleScore: number;
  excluded: boolean;
  exclusionReason: string | null;
  ownerOverride: boolean | null;
}

export function AddSourceModal({
  open,
  onClose,
  kinds,
  busy,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  kinds: SourceKind[];
  busy: boolean;
  onSubmit: (input: { kind: 'x_public' | 'manual'; handle: string; text: string; depth: number }) => void;
}) {
  const [kind, setKind] = useState<'x_public' | 'manual'>('manual');
  const [handle, setHandle] = useState('');
  const [text, setText] = useState('');
  const [depth, setDepth] = useState(2000);

  const selected = kinds.find((k) => k.kind === kind);
  const blocked = selected && !selected.available;

  return (
    <Modal open={open} onClose={onClose} title="Add a persona source" wide>
      <div className="space-y-5">
        <Field label="Where the material comes from">
          <div className="grid gap-2 sm:grid-cols-2">
            {(['manual', 'x_public'] as const).map((option) => {
              const info = kinds.find((k) => k.kind === option);
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  className={`rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${
                    kind === option
                      ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone'
                      : 'border-ink-line text-bone-dim hover:border-bone-faint'
                  }`}
                >
                  <span className="block">{info?.displayName ?? option}</span>
                  <span className="mt-1 block text-[11px] leading-snug text-bone-faint">
                    {info?.available === false ? 'Not available here' : info?.detail ?? ''}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>

        {blocked && (
          <div className="rounded-lg border border-signal-wait/30 bg-signal-wait/[0.06] px-4 py-3">
            <p className="text-sm text-signal-wait">{selected!.detail}</p>
            {selected!.requirement && (
              <p className="mt-2 text-xs leading-relaxed text-bone-dim">{selected!.requirement}</p>
            )}
          </div>
        )}

        {kind === 'x_public' ? (
          <>
            <Field label="X handle" htmlFor="psHandle" hint="Public posts only. No sign-in to that account is involved.">
              <input id="psHandle" className="field" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="someone" />
            </Field>
            <Field label="How far back" htmlFor="psDepth" hint="Number of posts to consider.">
              <input
                id="psDepth"
                type="number"
                className="field"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value) || 2000)}
              />
            </Field>
          </>
        ) : (
          <Field
            label="Paste the material"
            htmlFor="psText"
            hint="One post per line, or separated by blank lines. Short remarks are welcome: a two-word reply often carries more voice than a long announcement."
          >
            <textarea id="psText" rows={10} className="field resize-y" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}

        <button
          type="button"
          className="btn-primary w-full"
          disabled={busy || blocked || (kind === 'x_public' ? !handle.trim() : !text.trim())}
          onClick={() => onSubmit({ kind, handle, text, depth })}
        >
          {busy && <Spinner />}
          Add and analyse
        </button>
      </div>
    </Modal>
  );
}

const VIEWS = [
  { key: 'useful', label: 'Useful' },
  { key: 'excluded', label: 'Excluded' },
  { key: 'all', label: 'All' },
] as const;

/**
 * Lets the owner see and change what was kept.
 *
 * Filtering that cannot be inspected is filtering you have to trust blindly.
 * Every excluded item shows the reason it was dropped, and either decision can
 * be overruled.
 */
export function ReviewModal({ source, onClose }: { source: Source; onClose: () => void }) {
  const [view, setView] = useState<'useful' | 'excluded' | 'all'>('useful');
  const page = useResource<{
    items: Item[];
    total: number;
    stats: { total: number; useful: number; excluded: number };
  }>(`/api/persona-sources/${source.id}/items?view=${view}&limit=100`);

  const override = async (item: Item, include: boolean | null) => {
    await put(`/api/persona-sources/${source.id}/items/${item.id}`, { include }).catch(() => undefined);
    page.reload();
  };

  return (
    <Modal open onClose={onClose} title={source.label || source.handle || 'Source'} wide>
      <div className="space-y-4">
        <p className="font-mono text-[11px] text-bone-faint">
          {page.data?.stats.total ?? 0} collected · {page.data?.stats.useful ?? 0} useful ·{' '}
          {page.data?.stats.excluded ?? 0} excluded
        </p>

        <div className="flex gap-2">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              aria-pressed={view === v.key}
              className={`rounded-full border px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                view === v.key
                  ? 'border-signal-calm/60 bg-signal-calm/[0.08] text-bone'
                  : 'border-ink-line text-bone-faint hover:text-bone-dim'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {page.loading && !page.data ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-ink-line border-y border-ink-line">
            {page.data?.items.map((item) => {
              const included = item.ownerOverride ?? !item.excluded;
              return (
                <li key={item.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-bone-dim">{item.rawText}</p>
                    <p className="mt-1 font-mono text-[10px] text-bone-faint">
                      {item.classification} · style {item.styleScore.toFixed(2)}
                      {item.exclusionReason ? ` · ${item.exclusionReason}` : ''}
                      {item.ownerOverride !== null ? ' · you overruled this' : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`btn-quiet p-2 ${included ? 'text-signal-live' : ''}`}
                    aria-label={included ? 'Exclude this item' : 'Include this item'}
                    onClick={() => void override(item, included ? false : true)}
                  >
                    {included ? <Check className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {(page.data?.total ?? 0) > (page.data?.items.length ?? 0) && (
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
            Showing {page.data?.items.length} of {page.data?.total}
          </p>
        )}
      </div>
    </Modal>
  );
}
