import { useState, type FormEvent } from 'react';
import { ApiError, del, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, ErrorPanel, Loading, Spinner } from '@app/components/ui';
import { Section, SubHeading } from './Section';

interface Shadow {
  id: string;
  label: string;
  venue: string;
  side: 'BUY' | 'SELL';
  maxIn: string;
  intervalSeconds: number;
  nextRunAt: string;
  lastRunAt: string | null;
  runs: number;
  fills: number;
  refusals: number;
  noMarket: number;
  lastOutcome: 'FILLED' | 'REFUSED' | 'NO_MARKET' | 'ERROR' | null;
  lastDetail: string | null;
  paused: boolean;
}

interface ShadowState {
  shadows: Shadow[];
  venues: { venue: string; ready: boolean; detail: string }[];
}

/**
 * What each outcome means, in words rather than as a code.
 *
 * NO_MARKET and REFUSED are deliberately worded as different things, because
 * they need opposite responses: one is about the venue, the other about the
 * bounds somebody set.
 */
const OUTCOME_WORDS: Record<string, string> = {
  FILLED: 'Would have filled',
  REFUSED: 'Your bounds said no',
  NO_MARKET: 'The venue could not be read',
  ERROR: 'Something went wrong',
};

/** An interval as a person says it. */
function every(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? 'every hour' : `every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'every minute' : `every ${seconds / 60} minutes`;
  return `every ${seconds} seconds`;
}

/**
 * Shadow trading: what would have happened, repeatedly, against the real market.
 *
 * Deliberately a separate section from the wallet. That one is the only place
 * anything can move; nothing here can, ever. A shadow runs the same pipeline a
 * live trade would and stops at the point where a live one would sign.
 */
export function ShadowsSection({ index, agentId }: { index: number; agentId: string }) {
  const { data, error, loading, reload } = useResource<ShadowState>(`/api/agents/${agentId}/shadows`);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ label: '', venue: '', address: '', decimals: '18', quote: '', quoteDecimals: '6', network: 'ethereum', maxIn: '', interval: '3600' });

  const priceable = data?.venues.filter((v) => v.ready) ?? [];

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await run();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
      reload();
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const venue = draft.venue || priceable[0]?.venue;
    if (!venue) return;
    const subject = { kind: 'ONCHAIN', network: draft.network, address: draft.address.trim(), decimals: Number(draft.decimals) };
    const paying = { kind: 'ONCHAIN', network: draft.network, address: draft.quote.trim(), decimals: Number(draft.quoteDecimals) };
    await act(() =>
      post(`/api/agents/${agentId}/shadows`, {
        label: draft.label.trim(),
        venue,
        side: 'BUY',
        // Buying the subject with the asset being spent. The amounts are in
        // the spent asset's base units, which is what the form asks for.
        assetIn: paying,
        assetOut: subject,
        subject,
        maxIn: draft.maxIn.trim(),
        maxSlippageBps: 100,
        maxPriceImpactBps: 200,
        maxFeeBase: draft.maxIn.trim(),
        intervalSeconds: Number(draft.interval),
      }),
    );
  };

  return (
    <Section
      id="shadows"
      index={index}
      eyebrow="Shadow trading"
      heading="What it would have done."
      lede="The same pipeline a real trade would run, against the real market, on a schedule, stopping exactly where a real one would sign. Nothing here can move anything."
    >
      {loading && !data ? (
        <Loading label="Reading the shadows" />
      ) : error || !data ? (
        <ErrorPanel
          title="The shadows could not be read."
          detail={error}
          actions={
            <button type="button" className="btn-quiet" onClick={reload}>
              Try again
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          {note && <p className="break-words text-sm text-signal-fail">{note}</p>}

          {priceable.length === 0 ? (
            // Said here rather than letting somebody set up a shadow that
            // records a column of NO_MARKET and looks like a fault.
            <EmptyState
              title="Nothing can be priced on this installation"
              detail={
                data.venues.find((v) => !v.ready)?.detail ??
                'No market reader is installed, so there is no venue to run a shadow against.'
              }
            />
          ) : (
            <>
              <div>
                <SubHeading className="text-sm font-medium text-bone">Venues it can read</SubHeading>
                <ul className="mt-2 space-y-1">
                  {priceable.map((v) => (
                    <li key={v.venue} className="break-words text-xs text-bone-dim">
                      <span className="font-mono text-bone">{v.venue}</span> {v.detail}
                    </li>
                  ))}
                </ul>
              </div>

              <form className="space-y-2" onSubmit={(e) => void create(e)}>
                <SubHeading className="text-sm font-medium text-bone">Watch a pair</SubHeading>
                <p className="text-xs text-bone-dim">
                  An exact contract, never a ticker: anybody can mint a token called anything. Amounts are whole numbers
                  of the smallest unit of what is being spent.
                </p>
                <div className="flex flex-wrap gap-2">
                  <input aria-label="Name" className="field w-40" placeholder="A name for it" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                  <select aria-label="Venue" className="field w-auto" value={draft.venue || priceable[0]!.venue} onChange={(e) => setDraft({ ...draft, venue: e.target.value })}>
                    {priceable.map((v) => (
                      <option key={v.venue} value={v.venue}>
                        {v.venue}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Network" className="field w-auto" value={draft.network} onChange={(e) => setDraft({ ...draft, network: e.target.value })}>
                    {['ethereum', 'bnb', 'solana'].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input aria-label="Contract to buy" className="field min-w-0 flex-1" placeholder="Contract to buy" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
                  <input aria-label="Its decimals" className="field w-20" inputMode="numeric" placeholder="18" value={draft.decimals} onChange={(e) => setDraft({ ...draft, decimals: e.target.value })} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <input aria-label="Contract to spend" className="field min-w-0 flex-1" placeholder="Contract to spend" value={draft.quote} onChange={(e) => setDraft({ ...draft, quote: e.target.value })} />
                  <input aria-label="Its decimals" className="field w-20" inputMode="numeric" placeholder="6" value={draft.quoteDecimals} onChange={(e) => setDraft({ ...draft, quoteDecimals: e.target.value })} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <input aria-label="Amount in base units" className="field w-44" inputMode="numeric" placeholder="Amount, base units" value={draft.maxIn} onChange={(e) => setDraft({ ...draft, maxIn: e.target.value })} />
                  <select aria-label="How often" className="field w-auto" value={draft.interval} onChange={(e) => setDraft({ ...draft, interval: e.target.value })}>
                    {[300, 900, 3600, 21600, 86400].map((s) => (
                      <option key={s} value={String(s)}>
                        {every(s)}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="btn-quiet" disabled={busy || !draft.label || !draft.address || !draft.quote || !draft.maxIn}>
                    Start watching
                  </button>
                  {busy && <Spinner />}
                </div>
              </form>
            </>
          )}

          {data.shadows.length > 0 && (
            <div>
              <SubHeading className="text-sm font-medium text-bone">Running</SubHeading>
              <ul className="mt-2 divide-y divide-ink-line">
                {data.shadows.map((s) => (
                  <li key={s.id} className="py-3 text-sm">
                    <p className="text-[11px] uppercase tracking-wide text-bone-faint">
                      {s.venue} · {s.side} · {every(s.intervalSeconds)} · {s.paused ? 'paused' : `next ${timeAgo(s.nextRunAt)}`}
                    </p>
                    <p className="mt-0.5 break-words text-bone">{s.label}</p>
                    <p className="mt-0.5 text-xs text-bone-dim">
                      {/* Named rather than only counted: how many of each is the
                          answer to "is this working", and a single total is not. */}
                      {s.runs} {s.runs === 1 ? 'run' : 'runs'} · {s.fills} would have filled · {s.refusals} refused ·{' '}
                      {s.noMarket} could not be priced
                    </p>
                    {s.lastOutcome && (
                      <p className="mt-0.5 break-words text-xs text-bone-dim">
                        Last: {OUTCOME_WORDS[s.lastOutcome] ?? s.lastOutcome}
                        {s.lastDetail ? ` — ${s.lastDetail}` : ''}
                        {s.lastRunAt ? ` (${timeAgo(s.lastRunAt)})` : ''}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-3">
                      <button
                        type="button"
                        className="btn-quiet px-0 text-xs"
                        disabled={busy}
                        onClick={() => void act(() => post(`/api/shadows/${s.id}/paused`, { paused: !s.paused }))}
                      >
                        {s.paused ? 'Start it again' : 'Pause it'}
                      </button>
                      <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void act(() => del(`/api/shadows/${s.id}`))}>
                        Remove it
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-bone-faint">
                Every run is written down as a simulated trade with the price, the fee and the depth the venue actually
                reported. A simulated result is never a real one, and it is labelled simulated everywhere it is kept.
              </p>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
