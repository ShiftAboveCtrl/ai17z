import { useId, useRef, useState } from 'react';
import { post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { focusAfterPaint } from '@app/components/ui';

interface PublishState { published: boolean; playbookId: string | null; version: number | null; title: string | null; confirmedAt: string | null; problem: string | null; canUnpublish: boolean }
interface Preview { document: unknown; digest: string; playbookId: string; version: number; expiresAt: string; note: string }
const controlClass = 'min-h-12 w-full rounded border border-bone-faint bg-ink-raised px-3 text-base text-bone';
const buttonClass = 'min-h-12 touch-manipulation rounded border border-bone-faint px-4 text-sm text-bone hover:bg-ink-raised disabled:opacity-50';

export function PlaybookPublishPanel() {
  const agents = useResource<{ items: Array<{ id: string; name: string }> }>('/api/agents');
  const [id, setId] = useState('');
  return <section className="min-w-0 rounded-lg border border-ink-line bg-ink-panel p-4">
    <h2 className="text-sm font-medium text-bone">Publish this agent&apos;s setup as a playbook</h2>
    <p className="mt-1 text-sm text-bone-dim">Publish the agent&apos;s current paper setup, not its results. Control from Studio must be on, and publishing is off until you confirm.</p>
    <label className="mt-4 block text-sm text-bone">Agent
      <select name="agent" className={`${controlClass} mt-2`} value={id} onChange={(event) => setId(event.target.value)}>
        <option value="">Choose an agent</option>
        {(agents.data?.items ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>
    {agents.error ? <p role="alert" className="mt-2 text-sm text-signal-fail">{agents.error}</p> : null}
    {id ? <AgentPlaybookControls key={id} agentId={id} /> : null}
  </section>;
}

export function AgentPlaybookControls({ agentId }: { agentId: string }) {
  const uid = useId();
  const base = `/api/agents/${agentId}/playbook-publish`;
  const state = useResource<PublishState>(base);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const perform = async (run: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await run(); state.reload(); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'The request could not be completed.'); }
    finally { setBusy(false); }
  };
  const data = state.data;
  return <div className="mt-4 min-w-0 space-y-4">
    <p className="text-sm text-bone" role="status">{data?.published
      ? `Published as "${data.title}" (${data.playbookId}, version ${data.version}), confirmed ${data.confirmedAt ? new Date(data.confirmedAt).toLocaleString() : ''}.`
      : data?.canUnpublish ? 'Publication outcome unknown. Studio has not confirmed whether the playbook is listed.'
        : state.error ? 'Could not read publication state.' : state.loading ? 'Reading the last confirmed state.' : 'Unpublished. No playbook has been confirmed.'}</p>
    {data?.problem || state.error ? <p role="alert" className="break-words text-sm text-signal-fail">{data?.problem ?? state.error}</p> : null}
    <form method="post" aria-labelledby={`${uid}-title`} onChange={() => setPreview(null)} onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void perform(async () => {
        const result = await post<Preview>(`${base}/preview`, { title: String(form.get('title') ?? '') });
        setPreview(result);
        focusAfterPaint(heading);
      });
    }}>
      <h3 id={`${uid}-title`} className="text-sm font-medium text-bone">Name the playbook</h3>
      <fieldset disabled={busy} className="mt-3 space-y-3">
        <legend className="sr-only">Playbook name</legend>
        <label className="block text-sm text-bone">Title (plain words)
          <input name="title" required maxLength={60} defaultValue={data?.title ?? ''} className={`${controlClass} mt-2`} autoComplete="off" spellCheck={false} />
        </label>
        <button type="submit" className={buttonClass}>Preview exact playbook</button>
      </fieldset>
    </form>
    {preview ? <form method="post" aria-labelledby={`${uid}-preview`} onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        const result = await post<{ ok: boolean; why?: string }>(`${base}/publish`, { digest: preview.digest });
        setMessage(result.ok ? `Published as ${preview.playbookId} version ${preview.version}.` : result.why ?? 'Studio did not confirm publication.');
        if (result.ok) setPreview(null);
      });
    }}>
      <h3 ref={heading} tabIndex={-1} id={`${uid}-preview`} className="text-sm font-medium text-bone">Exact playbook to publish</h3>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-raised p-3 text-xs text-bone">{JSON.stringify(preview.document, null, 2)}</pre>
      <p className="mt-3 text-sm text-bone-dim">{preview.note}</p>
      <p className="mt-2 text-sm text-bone-dim">Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
      <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input name="confirm" type="checkbox" required />I reviewed this exact playbook and want to publish it.</label>
      <button type="submit" className={buttonClass} disabled={busy}>Confirm and publish</button>
    </form> : null}
    {data?.published || data?.canUnpublish ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void perform(async () => {
      const result = await post<{ ok: boolean; why?: string }>(`${base}/unpublish`, {});
      setMessage(result.ok ? 'Unpublished. The listing is removed.' : result.why ?? 'Studio did not confirm removal.');
      if (result.ok) setPreview(null);
    })}>Unpublish playbook</button> : null}
    <p className="text-sm text-bone-dim">A published playbook is setup, not results: bounds, paper capital and the exact mint universe. No PnL, no wallet beyond those mints, no memory, no stance. A published version never changes; publishing again is a new version. Unpublishing removes the listing.</p>
    <p role="status" className="break-words text-sm text-bone">{busy ? 'Waiting for confirmation.' : message}</p>
  </div>;
}
