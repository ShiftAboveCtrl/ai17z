import { useId, useState } from 'react';
import { SignalUniverse, type SignalWatch, type SignalObservation, type SignalRadarData } from '@xbam/shared/contracts';
import { del, post } from '@app/lib/api';

export type { SignalRadarData } from '@xbam/shared/contracts';
interface Source {
  id: string;
  config: { watches?: SignalWatch[]; mayTrigger?: boolean; intervalSeconds?: number };
}
const PREDICATES: Record<SignalWatch['predicate'], string> = {
  liquidity_below: 'Liquidity below USD',
  concentration_above: 'Top 10 concentration above %',
  new_pool: 'New pool observed',
  wallet_transaction: 'Address transacting',
};

function Observation({ label, read }: { label: string; read: SignalObservation | null | undefined }) {
  return <div className="min-w-0 rounded-lg bg-ink-raised p-3 [overflow-wrap:anywhere]">
    <dt className="text-xs text-bone-dim">{label}</dt>
    <dd className="mt-1 text-base text-bone">{read?.value == null ? 'Unavailable' : Array.isArray(read.value) ? (read.value.join(', ') || 'No pools observed') : read.value === '' ? 'No transactions observed' : String(read.value)}</dd>
    <dd className="mt-1 text-xs text-bone-dim">{read?.source ?? 'Source unavailable'} · {read?.observedAt ?? 'Time unavailable'}</dd>
    {read?.reads?.map((part, index) => <dd key={index} className="mt-1 text-xs text-bone-dim">Read {index + 1}: {part.source} · {part.observedAt}</dd>)}
    {read?.definition && <dd className="mt-2 text-xs leading-relaxed text-bone-dim">{read.definition}</dd>}
  </div>;
}

export function SignalEvidence({ data }: { data: SignalRadarData }) {
  return <div className="min-w-0 space-y-5">
    <div>
      <h4 className="text-base text-bone">Retained baselines</h4>
      {data.baselines.length === 0 && <p className="mt-2 text-sm text-bone-dim">The first valid read establishes a baseline. It never creates a candidate.</p>}
      {data.baselines.map(row => <article key={`${row.sourceId}:${row.watchKey}`} className="mt-3 min-w-0 space-y-2 rounded-lg border border-ink-line p-3 [overflow-wrap:anywhere]">
        <p className="text-sm text-bone">{PREDICATES[row.watch.predicate]}{row.watch.threshold !== undefined ? ` ${row.watch.threshold}` : ''}</p>
        <p className="text-sm text-bone-dim">{row.watch.chain}:{row.watch.address}</p>
        <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Observation label="First valid read" read={row.state?.baseline} />
          <Observation label="Latest attempt" read={row.lastRead} />
        </dl>
        <p className="text-sm leading-relaxed text-bone-dim">{row.reason}</p>
      </article>)}
    </div>
    <div>
      <h4 className="text-base text-bone">Before / after candidates</h4>
      {data.candidates.length === 0 && <p className="mt-2 text-sm text-bone-dim">No prospective transitions recorded. A timer firing is not a reason to speak.</p>}
      {data.candidates.map(row => <article key={row.id} className="mt-3 min-w-0 space-y-2 rounded-lg border border-signal-calm/30 p-3 [overflow-wrap:anywhere]">
        <p className="text-sm text-bone">{PREDICATES[row.evidence.watch.predicate]}</p>
        <p className="text-sm text-bone-dim">{row.evidence.watch.chain}:{row.evidence.watch.address}</p>
        <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <Observation label="Before" read={row.evidence.before} />
          <Observation label="After" read={row.evidence.after} />
        </dl>
        <p className="text-sm text-bone">{row.jobStatus === 'EXECUTED' ? 'Posted' : row.jobStatus === 'DRY_RUN_COMPLETED' ? 'Dry run; nothing published' : row.jobStatus ? `Job: ${row.jobStatus}` : row.ideaStatus ? `Idea: ${row.ideaStatus}` : 'Not offered for posting'}</p>
        <p className="text-sm leading-relaxed text-bone-dim">{row.jobError || row.ideaError || row.reason}</p>
        {row.ideaStatus === 'unused' && !row.jobStatus && <p className="text-sm text-bone-dim">{!row.postingEnabled ? 'Posting schedule is off or not configured.' : row.postingReason || 'Waiting for the existing posting cadence.'}</p>}
      </article>)}
    </div>
  </div>;
}

export function SignalRadar({ accountId, source, data, reload }: { accountId: string; source?: Source; data: SignalRadarData; reload: () => void }) {
  const id = useId();
  const [address, setAddress] = useState('');
  const [chain, setChain] = useState('solana');
  const [predicate, setPredicate] = useState<SignalWatch['predicate']>('liquidity_below');
  const [threshold, setThreshold] = useState('10000');
  const [mayTrigger, setMayTrigger] = useState(source?.config.mayTrigger ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watches = source?.config.watches ?? [];
  const path = `/api/accounts/${accountId}/radar`;
  const save = async (pins: SignalWatch[], posting = mayTrigger) => {
    setBusy(true); setError(null);
    try {
      if (!pins.length && source) await del(`${path}/${source.id}`);
      else {
        const parsed = SignalUniverse.safeParse(pins);
        if (!parsed.success) throw new Error(parsed.error.issues.map(i => i.message).join(' '));
        await post(path, { kind: 'market_signal', label: 'Market and wallet signals', config: { watches: parsed.data, mayTrigger: posting, intervalSeconds: source?.config.intervalSeconds ?? 300 } });
      }
      setAddress(''); reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'The signal watch could not be saved.'); }
    finally { setBusy(false); }
  };
  return <section className="min-w-0 space-y-5 border-t border-ink-line pt-5" aria-labelledby={`${id}-title`}>
    <div>
      <h3 id={`${id}-title`} className="text-lg text-bone">Market and wallet signals</h3>
      <p className="mt-1 text-sm leading-relaxed text-bone-dim">Owner pins · {watches.length} / 12. Read-only Solana observations, checked every {Math.max(300, source?.config.intervalSeconds ?? 300) / 60} minutes through shared upstream quotas. No X reads.</p>
    </div>
    {watches.length > 0 && <ul className="space-y-2">{watches.map((watch, index) => <li key={`${watch.chain}:${watch.address}:${watch.predicate}`} className="min-w-0 rounded-lg bg-ink-raised p-3 [overflow-wrap:anywhere]">
      <p className="text-sm text-bone">{watch.chain}:{watch.address}</p>
      <p className="mt-1 text-sm text-bone-dim">{PREDICATES[watch.predicate]} {watch.threshold ?? ''}{watch.chain !== 'solana' ? ' · Unsupported chain; not watched' : ''}</p>
      <button type="button" className="btn-quiet mt-2 min-h-12" disabled={busy} onClick={() => void save(watches.filter((_, i) => i !== index))}>Remove pin {index + 1}</button>
    </li>)}</ul>}
    <form method="post" action={path} className="min-w-0 space-y-4" onSubmit={event => {
      event.preventDefault();
      void save([...watches, { chain, address: address.trim(), predicate, ...(predicate === 'liquidity_below' || predicate === 'concentration_above' ? { threshold: Number(threshold) } : {}) }]);
    }}>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block min-w-0 text-sm text-bone">Chain
          <input name="chain" autoComplete="off" className="field mt-1 min-h-12 w-full text-base" value={chain} onChange={e => setChain(e.target.value.toLowerCase())} required maxLength={30} autoCapitalize="none" spellCheck={false} />
        </label>
        <label className="block min-w-0 text-sm text-bone">Exact mint or address
          <input name="address" autoComplete="off" className="field mt-1 min-h-12 w-full text-base" value={address} onChange={e => setAddress(e.target.value)} required maxLength={120} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`${id}-coverage`} />
        </label>
      </div>
      <p id={`${id}-coverage`} className="text-sm leading-relaxed text-bone-dim">Solana is supported. Other chains are listed as unsupported and never sampled. Pool coverage is the provider top 20; concentration includes pools and programs. No wallet or developer attribution is inferred.</p>
      <fieldset className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm text-bone">Observe a transition</legend>
        {Object.entries(PREDICATES).map(([key, label]) => <label key={key} className="flex min-h-12 items-center gap-3 rounded-lg border border-ink-line p-3 text-sm text-bone">
          <input type="radio" name="predicate" value={key} checked={predicate === key} onChange={() => setPredicate(key as SignalWatch['predicate'])} />{label}
        </label>)}
      </fieldset>
      {(predicate === 'liquidity_below' || predicate === 'concentration_above') && <label className="block text-sm text-bone">{predicate === 'liquidity_below' ? 'USD threshold' : 'Concentration threshold (%)'}
        <input name="threshold" type="number" min="0" max={predicate === 'concentration_above' ? 100 : 1e15} step="any" required className="field mt-1 min-h-12 w-full text-base" value={threshold} onChange={e => setThreshold(e.target.value)} />
      </label>}
      <label className="flex min-h-12 items-start gap-3 text-sm text-bone">
        <input className="mt-1" name="mayTrigger" type="checkbox" checked={mayTrigger} onChange={e => setMayTrigger(e.target.checked)} />
        <span>Offer transitions to the idea backlog. Off by default; reticence, cadence, capacity and posting gates still decide.</span>
      </label>
      {error && <p role="alert" className="text-sm text-signal-fail [overflow-wrap:anywhere]">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary min-h-12" disabled={busy}>{busy ? 'Saving…' : 'Add owner pin'}</button>
        {source && <button type="button" className="btn-ghost min-h-12" disabled={busy} onClick={() => void save(watches)}>Save posting preference</button>}
      </div>
    </form>
    <SignalEvidence data={data} />
  </section>;
}
