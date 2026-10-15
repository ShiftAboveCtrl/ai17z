import { MandateEditor } from './MandateEditor';
import { useState, type FormEvent } from 'react';
import { ApiError, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, ErrorPanel, Loading, Spinner } from '@app/components/ui';
import { Section, SubHeading } from './Section';

interface Network {
  family: 'EVM' | 'SOLANA';
  label: string;
  native: string;
  decimals: number;
  explorer: string;
}

interface Wallet {
  id: string;
  family: 'EVM' | 'SOLANA';
  address: string;
  origin?: 'GENERATED' | 'PHRASE';
  backedUpAt: string | null;
  createdAt: string;
}

interface Intent {
  id: string;
  network: string;
  kind: string;
  params:
    | { kind?: 'NATIVE_TRANSFER' | 'TOKEN_TRANSFER'; to: string; amount: string; tokenSymbol?: string; tokenDecimals?: number }
    | { kind: 'SOLANA_SWAP'; amountIn: string; minOut: string; inputSymbol: string; outputSymbol: string; inputDecimals: number; outputDecimals: number };
  status: string;
  simulation: { ok: boolean; maxFee: string; balanceBefore: string; balanceAfter: string; warnings: string[]; failure: string | null } | null;
  digest: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
}

interface WalletState {
  readiness: { ready: boolean; detail: string };
  networks: Record<string, Network>;
  wallets: Wallet[];
  intents: Intent[];
}

/** Base units as a person reads them. Exact: strings and BigInt, never floats. */
function units(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${value / scale}.${fraction}` : (value / scale).toString();
}

function toBase(text: string, decimals: number): string {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > decimals) throw new Error(`Write the amount in ${decimals === 9 ? 'SOL' : 'whole units'}, with at most ${decimals} decimal places.`);
  return (BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0')).toString();
}

const STATUS_WORDS: Record<string, string> = {
  DRAFTED: 'Written down, not checked',
  AWAITING_APPROVAL: 'Checked, waiting for your approval',
  APPROVED: 'Approved, not sent',
  SUBMITTING: 'Being sent',
  SUBMITTED: 'Sent',
  CONFIRMED: 'Confirmed on chain',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
  EXPIRED: 'Approval expired',
  UNKNOWN: 'Sent, not confirmed: check it, never resend',
};

/**
 * The agent's own wallet, for its owner.
 *
 * The agent can read it. Only this screen can move anything, and only one
 * exact transaction at a time: written down, checked against the chain, read
 * here with its digest, approved, then sent once.
 */
export function WalletSection({ index, agentId }: { index: number; agentId: string }) {
  const { data, error, loading, reload } = useResource<WalletState>(`/api/agents/${agentId}/wallets`);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ network: 'ethereum', to: '', amount: '' });
  // The phrase lives in this component only while it is typed, and is cleared whatever the answer.
  const [restore, setRestore] = useState({ open: false, family: 'SOLANA' as 'SOLANA' | 'EVM', phrase: '', expected: '' });

  const submitRestore = async (event: FormEvent) => {
    event.preventDefault();
    const body = { family: restore.family, phrase: restore.phrase, expectedAddress: restore.expected.trim() || null };
    setRestore({ ...restore, phrase: '' });
    await run(`/api/agents/${agentId}/wallets/restore`, body);
  };

  const run = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setNote(null);
    try {
      await post(path, body);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(false);
      reload();
    }
  };

  const submitDraft = async (event: FormEvent) => {
    event.preventDefault();
    const network = data?.networks[draft.network];
    if (!network) return;
    let amount: string;
    try {
      amount = toBase(draft.amount, network.decimals);
    } catch (e) {
      setNote((e as Error).message);
      return;
    }
    await run(`/api/agents/${agentId}/wallet-intents`, {
      params: { kind: 'NATIVE_TRANSFER', network: draft.network, to: draft.to.trim(), amount },
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <Section
      id="wallet"
      index={index}
      eyebrow="Wallet"
      heading="Its own wallet."
      lede="The agent can read what its wallet holds. It can never send, sign or approve anything: you do that here, one exact transaction at a time."
    >
      {loading && !data ? (
        <Loading label="Reading the wallet" />
      ) : error || !data ? (
        <ErrorPanel title="The wallet could not be read." detail={error} actions={<button type="button" className="btn-quiet" onClick={reload}>Try again</button>} />
      ) : !data.readiness.ready ? (
        <EmptyState title="No wallet adapter installed" detail={data.readiness.detail} />
      ) : (
        <div className="space-y-6">
          {note && <p className="break-words text-sm text-signal-fail">{note}</p>}
          <div>
            <SubHeading className="text-sm font-medium text-bone">Wallets</SubHeading>
            <ul className="mt-2 space-y-2">
              {data.wallets.map((w) => (
                <li key={w.id} className="text-sm">
                  <p className="break-all font-mono text-bone">{w.address}</p>
                  <p className="text-xs text-bone-faint">
                    {w.family === 'EVM' ? 'Ethereum, BNB Smart Chain, Robinhood Chain' : 'Solana'} · made {timeAgo(w.createdAt)}
                  </p>
                  {w.origin === 'PHRASE' && (
                    <p className="mt-1 text-xs text-bone-dim">Restored from your recovery phrase: the words you hold open it in any standard wallet, with or without AI17Z.</p>
                  )}
                  {w.origin !== 'PHRASE' && !w.backedUpAt && (
                    <p className="mt-1 text-xs text-bone-dim">
                      This key is sealed under your master key. Losing the master key or the database loses the wallet.{' '}
                      <button type="button" className="btn-quiet px-0 text-xs underline" disabled={busy} onClick={() => void run(`/api/wallets/${w.id}/backed-up`)}>
                        I have a backup of both
                      </button>
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-3">
              {(['EVM', 'SOLANA'] as const)
                .filter((f) => !data.wallets.some((w) => w.family === f))
                .map((f) => (
                  <button key={f} type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void run(`/api/agents/${agentId}/wallets`, { family: f })}>
                    Make {f === 'EVM' ? 'an EVM' : 'a Solana'} wallet
                  </button>
                ))}
              {data.wallets.length < 2 && (
                <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => setRestore({ ...restore, open: !restore.open, phrase: '' })}>
                  {restore.open ? 'Close' : 'Restore from a recovery phrase'}
                </button>
              )}
            </div>
            {restore.open && (
              <form className="mt-3 space-y-2" onSubmit={(e) => void submitRestore(e)} autoComplete="off">
                <p className="text-xs text-bone-dim">
                  The twelve or twenty-four words you wrote down, for example when you made this agent's wallet in Studio. They are used on this computer to
                  derive the key, which is sealed like any other, and then dropped: they are not stored, logged or sent anywhere. Paste the address you expect
                  as well, and a phrase that opens a different wallet is refused.
                </p>
                <select aria-label="Which wallet" className="field w-auto" value={restore.family} onChange={(e) => setRestore({ ...restore, family: e.target.value as 'SOLANA' | 'EVM' })}>
                  {(['SOLANA', 'EVM'] as const).filter((f) => !data.wallets.some((w) => w.family === f)).map((f) => (
                    <option key={f} value={f}>{f === 'SOLANA' ? 'Solana' : 'EVM'}</option>
                  ))}
                </select>
                <textarea
                  aria-label="Recovery phrase"
                  className="field min-h-[5rem] w-full font-mono"
                  value={restore.phrase}
                  onChange={(e) => setRestore({ ...restore, phrase: e.target.value })}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-gramm="false"
                  data-lpignore="true"
                />
                <input aria-label="Address you expect" className="field w-full font-mono" placeholder="Address you expect (recommended)" value={restore.expected} onChange={(e) => setRestore({ ...restore, expected: e.target.value })} autoComplete="off" spellCheck={false} />
                <button type="submit" className="btn-primary" disabled={busy || restore.phrase.trim().split(/\s+/).length < 12}>Restore</button>
              </form>
            )}
          </div>

          <MandateEditor agentId={agentId} hasSolanaWallet={data.wallets.some((w) => w.family === 'SOLANA')} />

          {data.wallets.length > 0 && (
            <form className="space-y-2" onSubmit={(e) => void submitDraft(e)}>
              <SubHeading className="text-sm font-medium text-bone">Send from it</SubHeading>
              <p className="text-xs text-bone-dim">Nothing is sent from here. This writes a transaction down; you check it and approve it next.</p>
              <div className="flex flex-wrap gap-2">
                <select aria-label="Network" className="field w-auto" value={draft.network} onChange={(e) => setDraft({ ...draft, network: e.target.value })}>
                  {Object.entries(data.networks)
                    .filter(([, n]) => data.wallets.some((w) => w.family === n.family))
                    .map(([id, n]) => (
                      <option key={id} value={id}>
                        {n.label} ({n.native})
                      </option>
                    ))}
                </select>
                <input aria-label="Recipient address" className="field min-w-0 flex-1" placeholder="Recipient address" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
                <input aria-label="Amount" className="field w-32" placeholder="Amount" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                <button type="submit" className="btn-quiet" disabled={busy || !draft.to || !draft.amount}>
                  Write it down
                </button>
              </div>
            </form>
          )}

          {data.intents.length > 0 && (
            <div>
              <SubHeading className="text-sm font-medium text-bone">Transactions</SubHeading>
              <ul className="mt-2 divide-y divide-ink-line">
                {data.intents.map((i) => {
                  const n = data.networks[i.network]!;
                  const p = i.params;
                  const decimals = p.kind === 'SOLANA_SWAP' ? p.inputDecimals : (p.tokenDecimals ?? n.decimals);
                  const symbol = p.kind === 'SOLANA_SWAP' ? p.inputSymbol : (p.tokenSymbol ?? n.native);
                  return (
                    <li key={i.id} className="py-3 text-sm">
                      <p className="text-[11px] uppercase tracking-wide text-bone-faint">
                        {STATUS_WORDS[i.status] ?? i.status} · {n.label} · {timeAgo(i.createdAt)}
                      </p>
                      <p className="mt-0.5 break-all text-bone">
                        {p.kind === 'SOLANA_SWAP' ? (
                          <>
                            Swap {units(p.amountIn, p.inputDecimals)} {p.inputSymbol} for at least {units(p.minOut, p.outputDecimals)} {p.outputSymbol}
                          </>
                        ) : (
                          <>
                            {units(p.amount, decimals)} {symbol} to <span className="font-mono">{p.to}</span>
                          </>
                        )}
                      </p>
                      {i.simulation?.ok && (
                        <p className="mt-0.5 text-xs text-bone-dim">
                          Fee at most {units(i.simulation.maxFee, n.decimals)} {n.native}. Balance {units(i.simulation.balanceBefore, decimals)} becomes{' '}
                          {units(i.simulation.balanceAfter, decimals)} {symbol}.
                        </p>
                      )}
                      {i.simulation?.warnings.map((w) => (
                        <p key={w} className="text-xs text-signal-wait">{w}</p>
                      ))}
                      {i.error && <p className="break-words text-xs text-signal-fail">{i.error}</p>}
                      {i.status === 'AWAITING_APPROVAL' && i.digest && <p className="mt-1 break-all font-mono text-[11px] text-bone-faint">Digest {i.digest}</p>}
                      {i.txHash && (
                        <a className="mt-1 block break-all font-mono text-[11px] text-bone-dim underline" href={`${n.explorer}/tx/${i.txHash}`} target="_blank" rel="noreferrer">
                          {i.txHash}
                        </a>
                      )}
                      <div className="mt-2 flex flex-wrap gap-3">
                        {['DRAFTED', 'AWAITING_APPROVAL', 'EXPIRED'].includes(i.status) && (
                          <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void run(`/api/wallet-intents/${i.id}/simulate`)}>
                            Check it against the chain
                          </button>
                        )}
                        {i.status === 'AWAITING_APPROVAL' && i.digest && (
                          <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={busy} onClick={() => void run(`/api/wallet-intents/${i.id}/approve`, { digest: i.digest })}>
                            Approve exactly this
                          </button>
                        )}
                        {i.status === 'APPROVED' && (
                          <button type="button" className="btn-primary px-3 py-1 text-xs" disabled={busy} onClick={() => void run(`/api/wallet-intents/${i.id}/submit`)}>
                            Send it now
                          </button>
                        )}
                        {['SUBMITTED', 'UNKNOWN'].includes(i.status) && (
                          <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void run(`/api/wallet-intents/${i.id}/reconcile`)}>
                            Check the chain for it
                          </button>
                        )}
                        {['DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'EXPIRED'].includes(i.status) && (
                          <button type="button" className="btn-quiet px-0 text-xs" disabled={busy} onClick={() => void run(`/api/wallet-intents/${i.id}/reject`)}>
                            Reject
                          </button>
                        )}
                        {busy && <Spinner />}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
