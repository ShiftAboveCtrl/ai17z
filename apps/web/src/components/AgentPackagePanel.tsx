import { useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { ApiError, getToken, post } from '@app/lib/api';
import { ErrorPanel, Spinner } from '@app/components/ui';

const BASE = (import.meta.env.VITE_XBAM_API_URL ?? '').replace(/\/+$/, '');

interface Summary {
  valid: boolean;
  problem: string | null;
  mode: 'SHARE' | 'MOVE' | null;
  name: string | null;
  exportedAt: string | null;
  exportedByVersion: string | null;
  checksumOk: boolean;
  counts: {
    styleExamples: number;
    models: number;
    tools: number;
    knowledgeSources: number;
    memories: number;
  };
  hasAvatar: boolean;
  notes: string[];
}

interface Imported {
  agentId: string;
  imported: { memories: number; avatar: boolean };
  skipped: string[];
}

/**
 * Downloads a package.
 *
 * Through fetch rather than a plain link, because the artifact routes need an
 * Authorization header and an `<a href>` sends none. The blob is released as
 * soon as the browser has taken it.
 */
async function download(agentId: string, mode: 'SHARE' | 'MOVE'): Promise<void> {
  const token = getToken();
  const response = await fetch(`${BASE}/api/agents/${agentId}/package?mode=${mode}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new ApiError('INTERNAL', 'That package could not be built.', response.status);

  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'agent.ai17z-agent';
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = named;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Taking an agent somewhere else, and bringing one back.
 *
 * Two modes, because they answer different questions. **Share** is how the
 * agent is configured, and is safe to hand to anybody. **Move** adds what it
 * has learned, and is for carrying your own agent to your own new machine.
 *
 * Importing is always inspect-then-import. The whole point of a portable agent
 * is that somebody can be handed one, and being handed a file is exactly when
 * you want to look inside before opening it. Every number on that screen is
 * counted from the file's contents rather than read from a field the file
 * supplied.
 */
export function AgentPackagePanel({ agentId, onImported }: { agentId?: string; onImported?: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<Imported | null>(null);

  const exportAs = async (mode: 'SHARE' | 'MOVE') => {
    if (!agentId) return;
    setBusy(mode);
    setError(null);
    try {
      await download(agentId, mode);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That package could not be downloaded.');
    } finally {
      setBusy(null);
    }
  };

  const chosen = async (file: File) => {
    setBusy('inspect');
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      setPending(text);
      setSummary(await post<Summary>('/api/agents/package/inspect', JSON.parse(text) as unknown));
    } catch (e) {
      // A file that is not JSON never reaches the API; say the same thing the
      // API would have.
      setSummary({
        valid: false,
        problem: e instanceof ApiError ? e.message : 'That file is not an AI17Z agent package.',
        mode: null,
        name: null,
        exportedAt: null,
        exportedByVersion: null,
        checksumOk: false,
        counts: { styleExamples: 0, models: 0, tools: 0, knowledgeSources: 0, memories: 0 },
        hasAvatar: false,
        notes: [],
      });
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    setBusy('import');
    setError(null);
    try {
      const imported = await post<Imported>('/api/agents/package/import', JSON.parse(pending) as unknown);
      setResult(imported);
      setSummary(null);
      setPending(null);
      onImported?.(imported.agentId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That agent could not be imported.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {agentId && (
        <div className="space-y-3">
          <p className="eyebrow">Take it somewhere else</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-quiet" onClick={() => void exportAs('SHARE')} disabled={busy !== null}>
              {busy === 'SHARE' ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" aria-hidden />}
              Export to share
            </button>
            <button type="button" className="btn-quiet" onClick={() => void exportAs('MOVE')} disabled={busy !== null}>
              {busy === 'MOVE' ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" aria-hidden />}
              Export to move
            </button>
          </div>
          <p className="max-w-prose text-xs leading-relaxed text-bone-faint">
            <span className="text-bone-dim">Share</span> is how the agent is configured — persona, policy, which model
            does what. Safe to send to anybody. <span className="text-bone-dim">Move</span> adds what it has learned,
            for carrying your own agent to your own new machine. Neither carries an API key, a login or a browser
            session.
          </p>
        </div>
      )}

      <div className="space-y-3">
        <p className="eyebrow">Bring one in</p>
        <button type="button" className="btn-quiet" onClick={() => input.current?.click()} disabled={busy !== null}>
          {busy === 'inspect' ? <Spinner className="h-3.5 w-3.5" /> : <FileUp className="h-3.5 w-3.5" aria-hidden />}
          Choose an agent file
        </button>
        <input
          ref={input}
          type="file"
          accept=".ai17z-agent,application/json"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void chosen(file);
          }}
        />
      </div>

      {summary && !summary.valid && <ErrorPanel title="That file could not be read." detail={summary.problem ?? ''} />}

      {summary?.valid && (
        <div className="space-y-4 rounded-lg border border-ink-line p-4">
          <div>
            <p className="text-base text-bone">{summary.name}</p>
            <p className="mt-1 font-mono text-[11px] text-bone-faint">
              {summary.mode === 'MOVE' ? 'move package' : 'share package'}
              {summary.exportedByVersion ? ` · written by AI17Z ${summary.exportedByVersion}` : ''}
              {summary.exportedAt ? ` · ${summary.exportedAt.slice(0, 10)}` : ''}
            </p>
          </div>

          {/* Counted from the file's contents, not read from what it claims. */}
          <ul className="grid gap-x-6 gap-y-1 text-[13px] text-bone-dim sm:grid-cols-2">
            <li>{summary.counts.styleExamples} style example(s)</li>
            <li>{summary.counts.models} model role(s)</li>
            <li>{summary.counts.tools} tool(s)</li>
            <li>{summary.counts.knowledgeSources} knowledge source(s)</li>
            <li>{summary.counts.memories} memor{summary.counts.memories === 1 ? 'y' : 'ies'}</li>
            <li>{summary.hasAvatar ? 'a picture' : 'no picture'}</li>
          </ul>

          {summary.notes.length > 0 && (
            <ul className="space-y-1.5 border-t border-ink-line pt-3 text-xs leading-relaxed text-bone-faint">
              {summary.notes.map((note) => (
                <li key={note} className={note.includes('checksum') ? 'text-signal-wait' : undefined}>
                  {note}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void confirmImport()}
              disabled={busy !== null || !summary.checksumOk}
            >
              {busy === 'import' && <Spinner />}
              Import as a new agent
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setSummary(null);
                setPending(null);
              }}
            >
              Cancel
            </button>
          </div>
          {!summary.checksumOk && (
            <p className="text-xs text-signal-wait">
              This file does not match its own checksum, so it cannot be imported. Ask for a fresh copy.
            </p>
          )}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-signal-live/30 bg-signal-live/[0.06] p-4">
          <p className="text-sm text-bone">Imported as a new agent.</p>
          <p className="mt-1 text-xs text-bone-dim">
            {result.imported.memories} memor{result.imported.memories === 1 ? 'y' : 'ies'}
            {result.imported.avatar ? ' and a picture' : ''} came across.
          </p>
          {result.skipped.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs leading-relaxed text-bone-faint">
              {result.skipped.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <ErrorPanel title="That did not work." detail={error} />}
    </div>
  );
}
