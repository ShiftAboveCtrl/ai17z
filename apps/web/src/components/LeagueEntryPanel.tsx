import { useId, useState, type FormEvent } from 'react';
import { post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { Panel } from '@app/routes/studio/shared';

type Status = { enabled: boolean; entry: { seasonSlug: string; alias: string; status: string; reason: string | null } | null };

export function LeagueEntryPanel({ agentId }: { agentId: string }) {
  const path = `/api/agents/${agentId}/studio/league`;
  const status = useResource<Status>(path);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const entry = status.data?.entry;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      const result = await post<{ ok: true; state: string } | { ok: false; why: string }>(`${path}/entry`, {
        slug: form.get('slug'), alias: form.get('alias'), replacePaperMandate: form.get('replace') === 'on',
      });
      setMessage(result.ok ? (result.state === 'ACTIVE' ? 'Entered. The simulated paper mandate is in place.' : 'Entry saved. Waiting for Studio.') : result.why);
      status.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The entry could not be sent. Try again.');
    } finally { setBusy(false); }
  }

  if (status.error) return <p role="status" className="mt-6 text-sm text-bone-dim">The paper league control could not be loaded. <button type="button" className="btn-quiet min-h-12" onClick={status.reload}>Try again</button></p>;
  if (!status.data?.enabled) return null;
  return (
    <Panel title="Paper league" lede="Enter a Studio season with simulated paper trades. No real funds are used.">
      {entry && <p className="mb-4 break-words text-sm text-bone-dim">{entry.alias} in {entry.seasonSlug}: {entry.status.toLowerCase()}.{entry.reason ? ` ${entry.reason}` : ''}</p>}
      <form aria-label="Enter paper league" action={`${path}/entry`} method="post" onSubmit={(event) => void submit(event)} className="max-w-lg space-y-4">
        <div><label htmlFor={`${id}-slug`} className="mb-1 block text-sm text-bone">Season slug (required)</label>
          <input id={`${id}-slug`} name="slug" className="field min-h-12 w-full !text-base focus-visible:!outline focus-visible:!outline-2 focus-visible:!outline-bone" required minLength={3} maxLength={40} pattern="[a-z0-9](?:[a-z0-9]|-){1,38}[a-z0-9]" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} defaultValue={entry?.seasonSlug} /></div>
        <div><label htmlFor={`${id}-alias`} className="mb-1 block text-sm text-bone">Public alias (required, 3 to 24 characters)</label>
          <input id={`${id}-alias`} name="alias" className="field min-h-12 w-full !text-base focus-visible:!outline focus-visible:!outline-2 focus-visible:!outline-bone" required minLength={3} maxLength={24} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} defaultValue={entry?.alias} /></div>
        <label className="flex min-h-12 items-center gap-3 text-sm text-bone-dim"><input name="replace" type="checkbox" />Replace this agent's existing paper mandate for the season</label>
        <button type="submit" disabled={busy} className="btn-primary min-h-12">{busy ? 'Entering paper season...' : 'Enter paper season'}</button>
        <p role="status" className="break-words text-sm text-bone-dim">{message}</p>
      </form>
    </Panel>
  );
}
