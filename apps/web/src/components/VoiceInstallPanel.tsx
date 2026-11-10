import { useRef, useState } from 'react';
import { FileUp, Search } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { useElapsed } from '@app/lib/hooks';
import { listingIdFrom, type InspectAnswer, type InstallAnswer } from '@app/lib/studioVoice';
import { Field, RetryablePanel, Spinner, Toggle, Working } from '@app/components/ui';
import { VoiceCountsLine, VoiceDocumentView, VoiceFindings } from './VoiceDocumentView';

/**
 * Installing a voice as a new agent.
 *
 * Look first, then install: the whole voice is shown, with anything in its text
 * that reads like an instruction, and nothing exists until the button is
 * pressed. A voice installed from here is the same powerless draft whichever
 * way it arrived: yours, switched off, observe only, with no account,
 * permission, model, tool, plugin or memory. The server makes it that way; this
 * screen says so before and after and cannot make it anything else.
 */

type Source = 'studio' | 'file';
type Phase = 'idle' | 'looking' | 'installing';

interface Looked {
  answer: InspectAnswer;
  /** What to send to install the same thing that was shown. */
  request: { document: unknown } | { listingId: string; version?: number };
}

export function VoiceInstallPanel({ onInstalled }: { onInstalled?: (agentId: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>('studio');
  const [pasted, setPasted] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [looked, setLooked] = useState<Looked | null>(null);
  const [name, setName] = useState('');
  const [sawFlags, setSawFlags] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string; retry: () => void } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<InstallAnswer | null>(null);
  const run = useRef(0);
  const seconds = useElapsed(phase !== 'idle');
  const busy = phase !== 'idle';

  const reset = () => {
    setLooked(null);
    setName('');
    setSawFlags(false);
    setError(null);
    setNotice(null);
    setDone(null);
  };

  const stopWaiting = () => {
    run.current += 1;
    setPhase('idle');
    setNotice(phase === 'installing' ? 'Stopped waiting. Check your agent list before trying again, in case it was made.' : 'Stopped waiting.');
  };

  const look = async (request: Looked['request']) => {
    const mine = ++run.current;
    reset();
    setPhase('looking');
    try {
      const answer = await post<InspectAnswer>('/api/studio/voices/inspect', request);
      if (mine !== run.current) return;
      // Pin the version that was looked at, so installing cannot pick up a
      // newer one that was published a moment later.
      const pinned: Looked['request'] =
        answer.source.kind === 'STUDIO' && answer.source.version !== null ? { listingId: answer.source.listingId, version: answer.source.version } : request;
      setLooked({ answer, request: pinned });
      setName(answer.inspection.title ?? '');
    } catch (e) {
      if (mine !== run.current) return;
      setError({ title: 'That voice could not be looked at.', detail: e instanceof ApiError ? e.message : 'Something went wrong.', retry: () => void look(request) });
    } finally {
      if (mine === run.current) setPhase('idle');
    }
  };

  const lookAtListing = () => {
    const listingId = listingIdFrom(pasted);
    if (!listingId) {
      reset();
      setError({ title: 'That is not a voice listing.', detail: 'Paste the listing id, or the page address Studio shows for the voice.', retry: () => setError(null) });
      return;
    }
    void look({ listingId });
  };

  const chosen = async (file: File) => {
    try {
      const text = await file.text();
      await look({ document: JSON.parse(text) as unknown });
    } catch (e) {
      // Not JSON: it never reaches the API, and says the same thing the API would.
      if (e instanceof SyntaxError) {
        reset();
        setError({ title: 'That file is not an AI17Z voice.', detail: 'It could not be read as a voice document.', retry: () => setError(null) });
      }
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const install = async () => {
    if (!looked?.answer.inspection.valid) return;
    const mine = ++run.current;
    setPhase('installing');
    setError(null);
    setNotice(null);
    try {
      const flagged = looked.answer.inspection.findings.length > 0;
      const result = await post<InstallAnswer>('/api/studio/voices/install', {
        ...looked.request,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(flagged ? { acknowledgeFindings: sawFlags } : {}),
      });
      if (mine !== run.current) return;
      setDone(result);
      setLooked(null);
      onInstalled?.(result.agentId);
    } catch (e) {
      if (mine !== run.current) return;
      setError({ title: 'That voice was not installed.', detail: e instanceof ApiError ? e.message : 'Something went wrong.', retry: () => void install() });
    } finally {
      if (mine === run.current) setPhase('idle');
    }
  };

  const inspection = looked?.answer.inspection;
  const flagged = (inspection?.findings.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <p className="max-w-prose text-[13px] leading-relaxed text-bone-dim">
        A voice is how an agent sounds: its character answers, style examples and output settings. Installing one makes{' '}
        <span className="text-bone">a new agent of your own</span>. It starts switched off and observe-only, with no account, permission, model, tool,
        plugin or memory. You add those yourself.
      </p>

      <div role="radiogroup" aria-label="Where the voice comes from" className="flex flex-wrap gap-2">
        {(
          [
            ['studio', 'From Studio'],
            ['file', 'From a file'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={source === id}
            disabled={busy}
            onClick={() => {
              setSource(id);
              reset();
            }}
            className={`rounded-lg border px-3.5 py-2 text-sm transition-colors disabled:opacity-40 ${
              source === id ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {source === 'studio' ? (
        <div className="space-y-3">
          <Field label="Listing" htmlFor="voice-listing" hint="The listing id, or the page address Studio shows for the voice.">
            <input
              id="voice-listing"
              className="field font-mono text-[13px]"
              value={pasted}
              disabled={busy}
              placeholder="voice_ab12cd34ef"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') lookAtListing();
              }}
            />
          </Field>
          <button type="button" className="btn-ghost" onClick={lookAtListing} disabled={busy || !pasted.trim()}>
            {phase === 'looking' ? <Spinner className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" aria-hidden />}
            Look at it
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button type="button" className="btn-ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
            {phase === 'looking' ? <Spinner className="h-3.5 w-3.5" /> : <FileUp className="h-3.5 w-3.5" aria-hidden />}
            Choose a voice file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".ai17z-voice,.json,application/json"
            className="sr-only"
            aria-label="Choose a voice file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void chosen(file);
            }}
          />
        </div>
      )}

      {busy && (
        <Working
          label={phase === 'looking' ? 'Reading the voice' : 'Making the agent'}
          seconds={seconds}
          slowHint={source === 'studio' && phase === 'looking' ? 'Still waiting on Studio. Nothing has been created.' : undefined}
          onCancel={stopWaiting}
          cancelLabel="Stop waiting"
        />
      )}
      {error && <RetryablePanel title={error.title} detail={error.detail} onRetry={error.retry} />}
      {notice && <p className="break-words rounded-lg border border-ink-line px-3.5 py-3 text-[13px] leading-relaxed text-bone-dim" role="status">{notice}</p>}

      {looked && inspection && !inspection.valid && (
        <RetryablePanel
          title={looked.answer.source.kind === 'STUDIO' ? 'That voice could not be inspected.' : 'That is not a voice AI17Z can use.'}
          detail={inspection.problem ?? 'It could not be read.'}
          onRetry={looked.answer.source.kind === 'STUDIO' ? () => void look(looked.request) : () => setLooked(null)}
          retryLabel={looked.answer.source.kind === 'STUDIO' ? 'Try again' : 'Choose another'}
        />
      )}

      {looked && inspection?.valid && looked.answer.document && (
        <div className="space-y-4">
          <div className="space-y-1">
            <p className="eyebrow">
              {looked.answer.source.kind === 'STUDIO' && looked.answer.source.version !== null ? `Studio, version ${looked.answer.source.version}` : 'From your file'}
            </p>
            {inspection.counts && <VoiceCountsLine counts={inspection.counts} />}
            {inspection.digest && <p className="break-all font-mono text-[10px] text-bone-faint">{inspection.digest}</p>}
          </div>
          <VoiceDocumentView document={looked.answer.document} />
          <VoiceFindings findings={inspection.findings} />
          <ul className="max-w-prose space-y-1.5 text-xs leading-relaxed text-bone-faint">
            {inspection.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>

          <Field label="Name for the new agent" htmlFor="voice-install-name" hint="Your choice. The voice does not name the agent or say who it is.">
            <input id="voice-install-name" className="field" value={name} maxLength={120} disabled={busy} onChange={(e) => setName(e.target.value)} />
          </Field>

          {flagged && (
            <Toggle
              checked={sawFlags}
              onChange={setSawFlags}
              disabled={busy}
              label="I read the flagged passages above"
              description="They are kept as words in the voice. The platform's identity and output rules apply to the new agent as to any other."
            />
          )}

          <button type="button" className="btn-primary" onClick={() => void install()} disabled={busy || (flagged && !sawFlags)}>
            {phase === 'installing' && <Spinner />}
            Install as a new agent
          </button>
        </div>
      )}

      {done && (
        <div className="min-w-0 space-y-2 rounded-lg border border-signal-live/30 bg-signal-live/[0.06] p-4" role="status">
          <p className="break-words text-sm text-bone">Installed as {done.name}.</p>
          <ul className="space-y-1 text-xs leading-relaxed text-bone-dim">
            {done.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
