import { useEffect, useId, useRef, useState } from 'react';
import { post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { focusAfterPaint } from '@app/components/ui';

interface HomeState { confirmed: { published: boolean; confirmedAt: string; validUntil: string } | null; stale: boolean; url: string | null; postLink: boolean; problem: string | null; canUnpublish: boolean }
interface Preview { manifest: unknown; digest: string; expiresAt: string; note: string }
const controlClass = 'min-h-12 w-full rounded border border-bone-faint bg-ink-raised px-3 text-base text-bone';
const buttonClass = 'min-h-12 touch-manipulation rounded border border-bone-faint px-4 text-sm text-bone hover:bg-ink-raised disabled:opacity-50';

export function PublicHomePanel() {
  const agents = useResource<{ items: Array<{ id: string; name: string }> }>('/api/agents');
  const [id, setId] = useState('');
  return <section className="min-w-0 rounded-lg border border-ink-line bg-ink-panel p-4">
    <h2 className="text-sm font-medium text-bone">Agent public home</h2>
    <p className="mt-1 text-sm text-bone-dim">Preview one shareable page for an AI agent. Publishing is off until you confirm. Control from Studio must be on.</p>
    <label className="mt-4 block text-sm text-bone">Agent
      <select name="agent" className={`${controlClass} mt-2`} value={id} onChange={(event) => setId(event.target.value)}>
        <option value="">Choose an agent</option>
        {(agents.data?.items ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>
    {agents.error ? <p role="alert" className="mt-2 text-sm text-signal-fail">{agents.error}</p> : null}
    {id ? <AgentHomeControls key={id} agentId={id} /> : null}
  </section>;
}

export function AgentHomeControls({ agentId }: { agentId: string }) {
  const uid = useId();
  const base = `/api/agents/${agentId}/public-home`;
  const state = useResource<HomeState>(base);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const perform = async (run: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await run(); state.reload(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'The request could not be completed.'); }
    finally { setBusy(false); }
  };
  const data = state.data;
  const reload = state.reload;
  const validUntil = data?.confirmed?.validUntil;
  useEffect(() => {
    if (!validUntil) return;
    const delay = Date.parse(validUntil) - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => { setClock(Date.now()); reload(); }, delay + 1);
    return () => window.clearTimeout(timer);
  }, [validUntil, reload]);
  const stale = data?.stale || !!validUntil && Date.parse(validUntil) <= Math.max(clock, Date.now());
  return <div className="mt-4 min-w-0 space-y-4">
    <p className="text-sm text-bone" role="status">{data?.confirmed
      ? `Last confirmed ${data.confirmed.published ? 'published' : 'unpublished'}: ${new Date(data.confirmed.confirmedAt).toLocaleString()}.${stale ? ' Could not confirm it is current. This is not a live manifest.' : ''}`
      : data?.canUnpublish ? 'Publication outcome unknown. Studio has not confirmed whether the page is published.'
        : state.error ? 'Could not read publication state.' : state.loading ? 'Reading the last confirmed state.' : 'Unpublished. No public home has been confirmed.'}</p>
    {data?.url && !stale ? <a className="block break-all text-sm text-bone underline" href={data.url} target="_blank" rel="noreferrer">{data.url}</a> : null}
    {data?.problem || state.error ? <p role="alert" className="break-words text-sm text-signal-fail">{data?.problem ?? state.error}</p> : null}
    <form method="post" aria-labelledby={`${uid}-title`} onChange={() => setPreview(null)} onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void perform(async () => {
        const result = await post<Preview>(`${base}/preview`, { alias: form.get('alias'), includeVoice: form.get('voice') === 'on',
          paperWindow: form.get('paper') || null, includeLeague: form.get('league') === 'on', showActivity: form.get('activity') === 'on' });
        setPreview(result);
        focusAfterPaint(heading);
      });
    }}>
      <h3 id={`${uid}-title`} className="text-sm font-medium text-bone">Choose what to share</h3>
      <fieldset disabled={busy} className="mt-3 space-y-3">
        <legend className="sr-only">Public home contents</legend>
        <label className="block text-sm text-bone">Public alias (3 to 24 characters)
          <input name="alias" required minLength={3} maxLength={24} className={`${controlClass} mt-2`} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        </label>
        <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input name="voice" type="checkbox" />Voice document</label>
        <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input name="activity" type="checkbox" />Activity already shared through the tape</label>
        <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input name="league" type="checkbox" />Simulated paper league standing</label>
        <label className="block text-sm text-bone">Simulated paper record window
          <select name="paper" className={`${controlClass} mt-2`} defaultValue=""><option value="">Do not share</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="90d">90 days</option></select>
        </label>
        <button type="submit" className={buttonClass}>Preview exact manifest</button>
      </fieldset>
    </form>
    {preview ? <form method="post" aria-labelledby={`${uid}-preview`} onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        const result = await post<{ ok: boolean; why?: string }>(`${base}/publish`, { digest: preview.digest, confirmed: true });
        setMessage(result.ok ? 'Published. Anyone with the link can read it.' : result.why ?? 'Studio did not confirm publication.');
        if (result.ok) setPreview(null);
      });
    }}>
      <h3 ref={heading} tabIndex={-1} id={`${uid}-preview`} className="text-sm font-medium text-bone">Exact manifest to publish</h3>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-raised p-3 text-xs text-bone">{JSON.stringify(preview.manifest, null, 2)}</pre>
      <p className="mt-3 text-sm text-bone-dim">{preview.note}</p>
      <p className="mt-2 text-sm text-bone-dim">Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
      <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input name="confirm" type="checkbox" required />I reviewed this exact manifest and want to publish it.</label>
      <button type="submit" className={buttonClass} disabled={busy}>Confirm and publish</button>
    </form> : null}
    <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input name="postLink" type="checkbox" disabled={busy || !data} checked={data?.postLink ?? false} onChange={(event) => {
      const enabled = event.target.checked;
      void perform(async () => { await put(`${base}/posting`, { enabled }); });
    }} />Allow the agent to propose a post with this link. Reticence and posting cadence still apply.</label>
    {data?.canUnpublish || data?.confirmed?.published ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
      const result = await post<{ ok: boolean; why?: string }>(`${base}/unpublish`, {});
      setMessage(result.ok ? 'Unpublished. Copies cannot be recalled.' : result.why ?? 'Studio did not confirm removal.');
      if (result.ok) setPreview(null);
    })}>Unpublish home</button> : null}
    <p className="text-sm text-bone-dim">Unpublishing removes the public page. Copies cannot be recalled.</p>
    <p role="status" className="break-words text-sm text-bone">{busy ? 'Waiting for confirmation.' : message}</p>
  </div>;
}
