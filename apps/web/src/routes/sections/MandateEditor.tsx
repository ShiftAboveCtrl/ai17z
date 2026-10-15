import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, post, put } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';

/**
 * What the agent may trade for real, written by its owner. Every entry is still
 * approved by the owner, by its exact transaction; the only thing that may
 * happen without them is a protective exit preauthorized below.
 */

interface Mandate {
  id?: string;
  paused?: boolean;
  mode: 'PAPER' | 'LIVE';
  assetScope: 'LISTED' | 'ANY_SOLANA_TOKEN';
  maxPerTradeSol: string;
  maxPerDaySol: string;
  maxOpenExposureSol: string;
  maxOpenPositions: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  minLiquiditySol: string;
  maxFeeSol: string;
  expiresAt: string | null;
  protectiveExits: {
    stopLossPct: number | null;
    trailingPct: number | null;
    liquidityFloorSol: string | null;
    honorStudioProtective: boolean;
    maxSlippageBps: number;
    maxPriceImpactBps: number;
    maxFeeSol: string;
  } | null;
}

/** Small on purpose: a first live canary is a test of the path, not a bet. */
const DEFAULTS: Mandate = {
  mode: 'PAPER',
  assetScope: 'ANY_SOLANA_TOKEN',
  maxPerTradeSol: '0.05',
  maxPerDaySol: '0.2',
  maxOpenExposureSol: '0.2',
  maxOpenPositions: 2,
  maxSlippageBps: 300,
  maxPriceImpactBps: 500,
  minLiquiditySol: '25',
  maxFeeSol: '0.002',
  expiresAt: null,
  protectiveExits: { stopLossPct: 20, trailingPct: 25, liquidityFloorSol: '5', honorStudioProtective: true, maxSlippageBps: 800, maxPriceImpactBps: 1500, maxFeeSol: '0.003' },
};

const field = 'field w-full';

export function MandateEditor({ agentId, hasSolanaWallet }: { agentId: string; hasSolanaWallet: boolean }) {
  const current = useResource<{ mandate: (Mandate & { id: string; paused: boolean }) | null }>(`/api/agents/${agentId}/mandate`);
  const [m, setM] = useState<Mandate>(DEFAULTS);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (current.data?.mandate) setM(current.data.mandate);
  }, [current.data]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote(ok);
      current.reload();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    // Only what the owner writes: the record's own id, pause and dates are not theirs to send.
    const body = {
      mode: m.mode,
      assetScope: m.assetScope,
      maxPerTradeSol: m.maxPerTradeSol,
      maxPerDaySol: m.maxPerDaySol,
      maxOpenExposureSol: m.maxOpenExposureSol,
      maxOpenPositions: m.maxOpenPositions,
      maxSlippageBps: m.maxSlippageBps,
      maxPriceImpactBps: m.maxPriceImpactBps,
      minLiquiditySol: m.minLiquiditySol,
      maxFeeSol: m.maxFeeSol,
      expiresAt: m.expiresAt,
      protectiveExits: m.protectiveExits,
    };
    void act(() => put(`/api/agents/${agentId}/mandate`, body), 'Saved. It applies to the next trade it is asked to prepare.');
  };
  const live = current.data?.mandate;
  const exits = m.protectiveExits;

  return (
    <form className="space-y-3" onSubmit={save}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-bone">Real trading</h3>
        {live && (
          <button
            type="button"
            className={live.paused ? 'btn-primary' : 'btn-quiet text-signal-fail'}
            disabled={busy}
            onClick={() => void act(() => post(`/api/agents/${agentId}/mandate/pause`, { paused: !live.paused }), live.paused ? 'Resumed.' : 'Paused. Nothing it trades is signed, protective exits included, until you resume.')}
          >
            {live.paused ? 'Resume its trading' : 'Pause its trading now'}
          </button>
        )}
      </div>
      <p className="text-xs text-bone-dim">
        {live ? (live.paused ? 'Paused: nothing is signed for it.' : live.mode === 'LIVE' ? 'Live: it may ask for real trades, and you approve each one here.' : 'Paper: nothing is signed for it.') : 'No mandate yet: it trades nothing for real.'}{' '}
        Every entry waits for your approval of its exact transaction. Amounts are in SOL.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-bone-dim">Mode
          <select className={field} value={m.mode} onChange={(e) => setM({ ...m, mode: e.target.value as Mandate['mode'] })}>
            <option value="PAPER">Paper</option>
            <option value="LIVE" disabled={!hasSolanaWallet}>Live{hasSolanaWallet ? '' : ' (needs its Solana wallet)'}</option>
          </select>
        </label>
        <label className="text-xs text-bone-dim">Which tokens
          <select className={field} value={m.assetScope} onChange={(e) => setM({ ...m, assetScope: e.target.value as Mandate['assetScope'] })}>
            <option value="ANY_SOLANA_TOKEN">Any Solana token, within the limits below</option>
            <option value="LISTED">Only tokens listed by exact address</option>
          </select>
        </label>
        <label className="text-xs text-bone-dim">Most for one trade
          <input className={field} value={m.maxPerTradeSol} onChange={(e) => setM({ ...m, maxPerTradeSol: e.target.value })} inputMode="decimal" />
        </label>
        <label className="text-xs text-bone-dim">Most in a day
          <input className={field} value={m.maxPerDaySol} onChange={(e) => setM({ ...m, maxPerDaySol: e.target.value })} inputMode="decimal" />
        </label>
        <label className="text-xs text-bone-dim">Most held at once
          <input className={field} value={m.maxOpenExposureSol} onChange={(e) => setM({ ...m, maxOpenExposureSol: e.target.value })} inputMode="decimal" />
        </label>
        <label className="text-xs text-bone-dim">Positions at once
          <input className={field} type="number" min={1} max={20} value={m.maxOpenPositions} onChange={(e) => setM({ ...m, maxOpenPositions: Number(e.target.value) })} />
        </label>
        <label className="text-xs text-bone-dim">Slippage on entry (basis points)
          <input className={field} type="number" min={1} max={1000} value={m.maxSlippageBps} onChange={(e) => setM({ ...m, maxSlippageBps: Number(e.target.value) })} />
        </label>
        <label className="text-xs text-bone-dim">Least pool depth to enter
          <input className={field} value={m.minLiquiditySol} onChange={(e) => setM({ ...m, minLiquiditySol: e.target.value })} inputMode="decimal" />
        </label>
      </div>

      <div className="rounded border border-ink-line p-3">
        <label className="flex items-center gap-2 text-xs text-bone">
          <input type="checkbox" checked={exits !== null} onChange={(e) => setM({ ...m, protectiveExits: e.target.checked ? DEFAULTS.protectiveExits : null })} />
          Let it sell to protect a position without asking me
        </label>
        <p className="mt-1 text-xs text-bone-dim">
          Only ever a sale of what its wallet holds, back to SOL, into the same wallet, at no worse than the bounds here. It never buys without you, and a pause stops this too.
          This AI17Z checks every fifteen seconds, whether or not Studio or any model is answering.
        </p>
        {exits && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-bone-dim">Stop loss, per cent below cost
              <input className={field} type="number" min={1} max={95} value={exits.stopLossPct ?? ''} onChange={(e) => setM({ ...m, protectiveExits: { ...exits, stopLossPct: e.target.value === '' ? null : Number(e.target.value) } })} />
            </label>
            <label className="text-xs text-bone-dim">Trailing stop, per cent below its best
              <input className={field} type="number" min={1} max={95} value={exits.trailingPct ?? ''} onChange={(e) => setM({ ...m, protectiveExits: { ...exits, trailingPct: e.target.value === '' ? null : Number(e.target.value) } })} />
            </label>
            <label className="text-xs text-bone-dim">Sell if the pool holds less than (SOL)
              <input className={field} value={exits.liquidityFloorSol ?? ''} onChange={(e) => setM({ ...m, protectiveExits: { ...exits, liquidityFloorSol: e.target.value === '' ? null : e.target.value } })} inputMode="decimal" />
            </label>
            <label className="text-xs text-bone-dim">Slippage an exit may take (basis points)
              <input className={field} type="number" min={1} max={3000} value={exits.maxSlippageBps} onChange={(e) => setM({ ...m, protectiveExits: { ...exits, maxSlippageBps: Number(e.target.value) } })} />
            </label>
            <label className="flex items-center gap-2 text-xs text-bone sm:col-span-2">
              <input type="checkbox" checked={exits.honorStudioProtective} onChange={(e) => setM({ ...m, protectiveExits: { ...exits, honorStudioProtective: e.target.checked } })} />
              Also when its Studio guardian asks for a protective sale
            </label>
          </div>
        )}
      </div>

      {note && <p className="break-words text-xs text-bone-dim">{note}</p>}
      <button type="submit" className="btn-primary" disabled={busy}>Save mandate</button>
    </form>
  );
}
