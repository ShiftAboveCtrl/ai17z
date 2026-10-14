import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { formatBaseUnits } from '@xbam/shared/contracts';
import { post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { RetryablePanel, Working } from '@app/components/ui';

/**
 * Real trades waiting for their owner, and who may ask for them.
 *
 * Every trade here is approved by the digest of the exact transaction the
 * owner was just shown. Review builds it afresh, because a Solana
 * transaction is good for about a minute; Approve and send approves that
 * digest and sends it at once, with the mandate and the pause read again at
 * the moment of sending.
 */

interface LiveTrade {
  id: string;
  agentName: string;
  side: string;
  status: string;
  spend: { amount: string; symbol: string; decimals: number };
  receive: { atLeast: string; symbol: string; decimals: number; simulated: string | null };
  digest: string | null;
  simulatedAt: string | null;
  warnings: string[];
  fromStudio: boolean;
  error: string | null;
  txHash: string | null;
  createdAt: string;
}

const STATUS: Record<string, string> = {
  AWAITING_APPROVAL: 'Waiting for you',
  APPROVED: 'Approved, sending',
  SUBMITTED: 'Sent, waiting for the chain',
  UNKNOWN: 'Sent, outcome being checked',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  RISK_REJECTED: 'Refused by the mandate',
  CANCELLED: 'Withdrawn',
  EXPIRED: 'Expired',
};

/** How long a reviewed swap stays sendable; the network forgets its blockhash soon after. */
const FRESH_MS = 60_000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function TradeCard({ trade, onChanged }: { trade: LiveTrade; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<LiveTrade>(trade);
  const reviewedAt = shown.simulatedAt ? Date.parse(shown.simulatedAt) : NaN;
  const waiting = shown.status === 'AWAITING_APPROVAL';
  const now = useNow(waiting);
  const left = Number.isFinite(reviewedAt) ? Math.max(0, Math.round((reviewedAt + FRESH_MS - now) / 1000)) : 0;
  const fresh = waiting && left > 0 && shown.digest !== null;

  const act = async (what: 'review' | 'approve' | 'reject') => {
    setBusy(what);
    setProblem(null);
    try {
      if (what === 'review') {
        const answer = await post<{ ok: boolean; why?: string; trade: LiveTrade }>(`/api/live-trades/${shown.id}/review`);
        setShown(answer.trade);
        if (!answer.ok) setProblem(answer.why ?? 'It could not be built again.');
      } else if (what === 'approve') {
        const answer = await post<{ sent: boolean; why?: string[]; trade: LiveTrade }>(`/api/live-trades/${shown.id}/approve`, { digest: shown.digest });
        setShown(answer.trade);
        if (!answer.sent) setProblem((answer.why ?? ['It was not sent.']).join(' '));
        onChanged();
      } else {
        const answer = await post<{ trade: LiveTrade }>(`/api/live-trades/${shown.id}/reject`);
        setShown(answer.trade);
        onChanged();
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-lg border border-ink-line bg-ink-deep p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-bone">
          {shown.agentName}: {shown.side === 'BUY' ? 'buy' : 'sell'}, spending {formatBaseUnits(shown.spend.amount, shown.spend.decimals)} {shown.spend.symbol}
          {' '}for at least {formatBaseUnits(shown.receive.atLeast, shown.receive.decimals)} {shown.receive.symbol}
        </p>
        <span className="text-[11px] text-bone-faint">{STATUS[shown.status] ?? shown.status}{shown.fromStudio ? ' · asked from Studio' : ''}</span>
      </div>
      {shown.receive.simulated ? (
        <p className="mt-1 text-[11px] text-bone-faint">Simulated, it delivered {formatBaseUnits(shown.receive.simulated, shown.receive.decimals)} {shown.receive.symbol}.</p>
      ) : null}
      {shown.warnings.map((w) => (
        <p key={w} className="mt-1 flex gap-1.5 break-words text-[11px] text-signal-warn"><ShieldAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />{w}</p>
      ))}
      {shown.digest ? <p className="mt-1 break-all font-mono text-[10px] text-bone-faint">digest {shown.digest}</p> : null}
      {shown.error && !waiting ? <p className="mt-1 break-words text-[11px] text-signal-fail">{shown.error}</p> : null}
      {shown.txHash ? (
        <a className="mt-1 block break-all font-mono text-[10px] text-bone underline" href={`https://solscan.io/tx/${shown.txHash}`} target="_blank" rel="noreferrer noopener">{shown.txHash}</a>
      ) : null}
      {waiting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy !== null} onClick={() => void act('review')} className="rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-panel disabled:opacity-50">
            {busy === 'review' ? 'Building it again…' : fresh ? 'Review again' : 'Review'}
          </button>
          <button
            type="button"
            disabled={busy !== null || !fresh}
            onClick={() => void act('approve')}
            className="rounded bg-signal-ok/20 px-3 py-1 text-xs text-bone hover:bg-signal-ok/30 disabled:opacity-40"
            title={fresh ? 'Approves exactly the digest above and sends it now.' : 'Review it first: what you approve must have been built in the last minute.'}
          >
            {busy === 'approve' ? 'Sending…' : fresh ? `Approve and send (${left}s)` : 'Approve and send'}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void act('reject')} className="rounded border border-ink-line px-3 py-1 text-xs text-bone-faint hover:bg-ink-panel disabled:opacity-50">
            Reject
          </button>
        </div>
      ) : null}
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-fail">{problem}</p> : null}
    </li>
  );
}

/** The real trades of this installation's agents, newest waiting first. */
export function LiveTradesList() {
  const trades = useResource<{ trades: LiveTrade[] }>('/api/live-trades');
  if (trades.loading && !trades.data) return <Working label="Reading real trades" seconds={0} />;
  if (trades.error || !trades.data) return <RetryablePanel title="Real trades did not load" detail={trades.error ?? 'No answer.'} onRetry={trades.reload} />;
  if (trades.data.trades.length === 0) return <p className="text-xs text-bone-faint">No real trade has been prepared here.</p>;
  return (
    <ul className="space-y-2">
      {trades.data.trades.map((t) => (
        <TradeCard key={`${t.id}-${t.status}`} trade={t} onChanged={trades.reload} />
      ))}
    </ul>
  );
}

/**
 * Whether Studio's agents may ask this installation to prepare real trades,
 * and which agent here carries out each one's. Off until switched on.
 */
export function LiveTradesSection() {
  const setting = useResource<{ enabled: boolean; changedAt: string | null; bindings: Record<string, string>; seen: Record<string, string> }>('/api/studio/live-trades');
  const agents = useResource<{ items: { id: string; name: string }[] }>('/api/agents');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const enabled = setting.data?.enabled ?? false;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      setting.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const seen = Object.entries(setting.data?.seen ?? {});
  return (
    <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-bone">Real trades from Studio</h2>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy || setting.loading}
          onClick={() => void run(() => put('/api/studio/live-trades', { enabled: !enabled }))}
          className="inline-flex items-center gap-1.5 rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
        >
          {enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <p className="mt-1 text-xs text-bone-faint">
        {enabled
          ? 'On. A Studio trading agent in approval mode may ask this AI17Z to prepare a real trade. It is built here, under the mandate and wallet of the agent you choose below, and nothing is signed until you approve its exact transaction here.'
          : 'Off. Studio agents cannot ask this AI17Z for anything that spends money.'}
      </p>
      {enabled && seen.length ? (
        <ul className="mt-3 space-y-2">
          {seen.map(([studioAgentId, name]) => (
            <li key={studioAgentId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-bone">{name} <span className="text-bone-faint">in Studio, carried out here by</span></span>
              <select
                className="rounded border border-ink-line bg-ink-deep px-2 py-1 text-xs text-bone"
                value={setting.data?.bindings[studioAgentId] ?? ''}
                disabled={busy}
                onChange={(e) => void run(() => put('/api/studio/live-trades/bindings', { studioAgentId, localAgentId: e.target.value || null }))}
              >
                <option value="">Nobody: its trades are refused</option>
                {(agents.data?.items ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      ) : enabled ? (
        <p className="mt-2 text-[11px] text-bone-faint">A Studio agent appears here the first time it asks, so you can choose which agent here carries out its trades.</p>
      ) : null}
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-fail">{problem}</p> : null}
      {enabled ? (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-medium text-bone">Waiting for you and recent</h3>
          <LiveTradesList />
        </div>
      ) : null}
    </section>
  );
}
