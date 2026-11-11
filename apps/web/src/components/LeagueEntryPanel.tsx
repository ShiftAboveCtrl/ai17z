import { useEffect, useRef, useState } from 'react';
import { LEAGUE_SLUG, LeagueAlias } from '@xbam/shared/contracts';
import { post } from '@app/lib/api';
import { useElapsed, useResource } from '@app/lib/hooks';
import { Field, Working } from '@app/components/ui';

type EntryAnswer = { ok: true; state: 'ACTIVE' | 'PENDING'; alreadyEntered?: boolean } | { ok: false; why: string };
const control = 'field min-h-12 w-full';

export function LeagueEntryPanel({ initialSeason = '' }: { initialSeason?: string }) {
  const agents = useResource<{ items: { id: string; name: string }[] }>('/api/agents');
  const [agentId, setAgentId] = useState('');
  const [slug, setSlug] = useState(initialSeason);
  const [alias, setAlias] = useState('');
  const [replacePaperMandate, setReplacePaperMandate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentence, setSentence] = useState<string | null>(null);
  const seconds = useElapsed(busy);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#league-entry') section.current?.scrollIntoView();
  }, []);

  const enter = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const validAlias = LeagueAlias.safeParse(alias);
    if (!agentId || !LEAGUE_SLUG.test(slug) || !validAlias.success) {
      setSentence(!agentId ? 'Choose an agent.' : !LEAGUE_SLUG.test(slug) ? 'Use the season slug from Studio.' : validAlias.error?.issues[0]?.message ?? 'Check the public alias.');
      return;
    }
    setBusy(true);
    setSentence(null);
    try {
      const answer = await post<EntryAnswer>('/api/studio/league/entry', { agentId, slug, alias, replacePaperMandate });
      setSentence(answer.ok
        ? answer.state === 'ACTIVE' ? `${agents.data?.items.find((agent) => agent.id === agentId)?.name ?? 'This agent'} is ${answer.alreadyEntered ? 'already entered' : 'entered'} in ${slug}.` : 'The entry is saved and waiting for Studio.'
        : answer.why);
    } catch (error) {
      setSentence(error instanceof Error ? error.message : 'The league entry could not be read.');
    } finally {
      setBusy(false);
    }
  };

  return <section ref={section} id="league-entry" className="min-w-0 scroll-mt-40 rounded-lg border border-ink-line bg-ink-panel p-4">
    <h2 id="league-entry-title" className="text-sm font-medium text-bone">Enter the paper league</h2>
    <p className="mt-1 text-sm text-bone-dim">Enter an agent in the season named by Studio with a public alias; the season supplies its paper mandate and simulated fills are reported to Studio.</p>
    <form aria-labelledby="league-entry-title" className="mt-4 space-y-4" onSubmit={enter}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="sr-only">League entry</legend>
        <Field label="Agent"><select name="leagueAgent" required className={control} value={agentId} onChange={(event) => { setAgentId(event.target.value); setReplacePaperMandate(false); setSentence(null); }}>
          <option value="">Choose an agent</option>
          {(agents.data?.items ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select></Field>
        <Field label="Season" hint="The season slug from Studio, such as week-45."><input name="leagueSeason" required className={control} value={slug} maxLength={40} autoCapitalize="none" spellCheck={false} onChange={(event) => { setSlug(event.target.value); setSentence(null); }} /></Field>
        <Field label="Public alias" hint="3 to 24 characters; no links or wallet addresses."><input name="leagueAlias" required className={control} value={alias} minLength={3} maxLength={24} onChange={(event) => { setAlias(event.target.value); setSentence(null); }} /></Field>
        <label className="flex min-h-12 items-center gap-3 text-sm text-bone"><input type="checkbox" checked={replacePaperMandate} onChange={(event) => { setReplacePaperMandate(event.target.checked); setSentence(null); }} />Replace this agent&apos;s existing paper mandate with the season rules.</label>
      </fieldset>
      {agents.error ? <p role="alert" className="text-sm text-signal-fail">{agents.error}</p> : null}
      <button type="submit" disabled={busy || agents.loading} className="min-h-12 rounded border border-bone-faint px-4 text-sm text-bone hover:bg-ink-raised disabled:opacity-50">Enter season</button>
      {busy ? <Working label="Entering the paper league" seconds={seconds} /> : null}
      <p role="status" className="break-words text-sm text-bone">{sentence}</p>
    </form>
  </section>;
}
