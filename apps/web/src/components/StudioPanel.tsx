import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2, RefreshCw, ShieldAlert, Unlink, Wallet } from 'lucide-react';
import { AI17Z_PAYMENT, formatBaseUnits, isExactPurchaseTransaction, type PreparedMarketplacePurchase } from '@xbam/shared/contracts';
import { post } from '@app/lib/api';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import { RetryablePanel, Working } from '@app/components/ui';

/**
 * AI17Z Studio, from inside AI17Z.
 *
 * Linking, what this installation is entitled to, and purchases the owner
 * started on Studio and finishes here. The wallet is the owner's own, found in
 * this browser through EIP-6963, and it is asked to sign exactly one thing:
 * the transfer the local API prepared, checked again on this page before the
 * wallet sees it. No key of any wallet ever reaches AI17Z.
 */

interface LeaseEntitlement {
  entitlement_id: string;
  plugin_id: string;
  usable: boolean;
  reason: string | null;
  version: string | null;
  capability_ids: string[];
}

interface StudioStatus {
  origin: string | null;
  unsafeDev: boolean;
  state: 'NOT_CONFIGURED' | 'NOT_LINKED' | 'PENDING' | 'LINKED' | 'REVOKED';
  installationId: string | null;
  linkedAt: string | null;
  pending: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string } | null;
  lease: { ok: true; validUntil: string; issuedAt: string; entitlements: LeaseEntitlement[] } | { ok: false; why: string } | null;
  sync: { attemptedAt: string; okAt: string | null; problem: string | null } | null;
  canRelink: boolean;
  payment: { chainId: number; chainName: string; token: string; decimals: number };
}

interface StudioPurchase {
  intent_id: string;
  plugin_id: string;
  plugin_name: string;
  publisher?: string;
  plugin_version?: string;
  created_at?: string;
  chain_id: number;
  status: string;
  payer_address: string;
  recipient_address: string;
  amount_base_units: string;
  expires_at: string;
  submitted_tx_hash: string | null;
  failure_reason: string | null;
}

interface LedgerRow {
  intentId: string;
  pluginName: string;
  amountBaseUnits: string;
  recipientAddress: string;
  state: 'PREPARED' | 'SENT' | 'ABANDONED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';
  txHash: string | null;
  studioStatus: string | null;
  note: string | null;
  preparedAt: string;
}

interface Purchases {
  studio: { ok: true; purchases: StudioPurchase[] } | { ok: false; why: string };
  ledger: LedgerRow[];
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
interface AnnouncedWallet {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193;
}

/** EIP-6963: ask every installed wallet to announce itself, and listen. */
function useWallets(): AnnouncedWallet[] {
  const [wallets, setWallets] = useState<AnnouncedWallet[]>([]);
  useEffect(() => {
    const seen = new Map<string, AnnouncedWallet>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<{ info?: Partial<AnnouncedWallet>; provider?: Eip1193 }>).detail;
      const info = detail?.info;
      if (!info?.uuid || !info.name || !detail.provider || typeof detail.provider.request !== 'function') return;
      seen.set(info.uuid, { uuid: info.uuid, name: info.name, icon: info.icon ?? '', rdns: info.rdns ?? '', provider: detail.provider });
      setWallets([...seen.values()]);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    // Some wallets announce late; ask again for a few seconds.
    const again = [500, 1500, 3000].map((ms) => setTimeout(() => window.dispatchEvent(new Event('eip6963:requestProvider')), ms));
    return () => {
      again.forEach(clearTimeout);
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
    };
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);
  return wallets;
}

/** An announced icon is shown only as a data: image, never fetched from somewhere the wallet names. */
function safeIcon(icon: string): string | null {
  return /^data:image\/(png|svg\+xml|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : null;
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

export function StudioPanel() {
  const status = useResource<StudioStatus>('/api/studio');
  const data = status.data;

  if (status.loading && !data) return <Working label="Reading the Studio link" seconds={0} />;
  if (status.error || !data) return <RetryablePanel title="That did not load" detail={status.error ?? 'No answer.'} onRetry={status.reload} />;

  return (
    <div className="space-y-5">
      {data.unsafeDev ? (
        <div className="flex gap-2 rounded-lg border border-signal-warn/50 bg-signal-warn/[0.06] px-3.5 py-3 text-xs text-bone">
          <ShieldAlert size={16} className="shrink-0 text-signal-warn" aria-hidden="true" />
          <p className="break-words">
            This installation is pointed at a development Studio at <code>{data.origin}</code> by AI17Z_STUDIO_UNSAFE_DEV_ORIGIN.
            It is not the public AI17Z Studio. A payment made through it is still a real transfer on the chain.
          </p>
        </div>
      ) : null}
      <LinkSection status={data} onChanged={status.reload} />
      {data.state === 'LINKED' ? (
        <>
          <EntitlementsSection status={data} onChanged={status.reload} />
          <PurchasesSection status={data} />
        </>
      ) : null}
      <p className="text-[11px] text-bone-faint">
        Linking is optional and nothing else in AI17Z depends on it. This installation always starts the conversation;
        Studio never connects to it. What is sent: a public key, a name, the platform and the AI17Z version. Never your
        agents, memories, prompts, provider keys, X sessions or files.
      </p>
    </div>
  );
}

function LinkSection({ status, onChanged }: { status: StudioStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [replace, setReplace] = useState(true);
  const waiting = status.state === 'PENDING';
  const elapsed = useElapsed(waiting);

  usePolling(
    () => {
      void post<{ state: string; why?: string }>('/api/studio/link/poll', {}).then((answer) => {
        if (answer.state === 'FAILED') setProblem(answer.why ?? 'Linking did not finish.');
        if (answer.state !== 'PENDING') onChanged();
      });
    },
    5_000,
    waiting,
  );

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await post<{ ok?: boolean; why?: string; studioTold?: boolean }>(path, body);
      if (answer.ok === false) setProblem(answer.why ?? 'That did not work.');
      else if (answer.studioTold === false) setProblem(`Disconnected here. Studio could not be told${answer.why ? `: ${answer.why}` : ''}. Revoke it on Studio too.`);
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
      <h2 className="text-sm font-medium text-bone">AI17Z Studio</h2>
      {status.state === 'NOT_CONFIGURED' ? (
        <p className="mt-1 text-xs text-bone-faint">
          Set the Studio address under Settings first. It is the same address as the Plugin registry, and it has to be
          https.
        </p>
      ) : null}
      {status.state === 'NOT_LINKED' || status.state === 'REVOKED' ? (
        <div className="mt-2 space-y-3">
          <p className="text-xs text-bone-faint">
            {status.state === 'REVOKED'
              ? 'Studio says this installation is no longer linked. Marketplace Plugins have stopped; everything else is unaffected.'
              : `Not linked to ${status.origin}. Link it to use Plugins you have on your Studio account.`}
          </p>
          {status.canRelink ? (
            <label className="flex items-center gap-2 text-xs text-bone">
              <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
              Suggest that this replaces the installation linked before, so its seats come across. You confirm it on Studio.
            </label>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('/api/studio/link', { replacePrevious: status.canRelink && replace })}
            className="inline-flex items-center gap-1.5 rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
          >
            <Link2 size={13} aria-hidden="true" /> Link to Studio
          </button>
        </div>
      ) : null}
      {waiting && status.pending ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-bone-faint">Open Studio, sign in, and enter this code. Only enter it on your own account.</p>
          <p className="font-mono text-2xl tracking-[0.2em] text-bone">{status.pending.userCode}</p>
          <a
            href={status.pending.verificationUriComplete}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 break-all text-xs text-bone underline underline-offset-2"
          >
            {status.pending.verificationUri} <ExternalLink size={12} aria-hidden="true" />
          </a>
          <Working
            label="Waiting for you to approve it on Studio"
            seconds={elapsed}
            slowAfter={120}
            slowHint={`The code works until ${when(status.pending.expiresAt)}.`}
            onCancel={() => void act('/api/studio/disconnect')}
            cancelLabel="Stop linking"
          />
        </div>
      ) : null}
      {status.state === 'LINKED' ? (
        <div className="mt-2 space-y-2 text-xs">
          <p className="break-words text-bone">
            Linked to {status.origin} since {when(status.linkedAt)}.
          </p>
          <p className="break-all text-bone-faint">Installation {status.installationId}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('/api/studio/disconnect')}
              className="inline-flex items-center gap-1.5 rounded border border-ink-line px-3 py-1 text-bone-faint hover:bg-ink-deep disabled:opacity-50"
            >
              <Unlink size={13} aria-hidden="true" /> Disconnect
            </button>
          </div>
          <p className="text-[11px] text-bone-faint">
            Disconnecting tells Studio first and releases this installation&apos;s seats so a new link can take them.
            Purchases stay on your account either way.
          </p>
        </div>
      ) : null}
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-fail">{problem}</p> : null}
    </section>
  );
}

function EntitlementsSection({ status, onChanged }: { status: StudioStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const elapsed = useElapsed(busy);
  const sync = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await post<{ ok: boolean; why?: string }>('/api/studio/sync', {});
      if (!answer.ok) setProblem(answer.why ?? 'The sync did not complete.');
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const lease = status.lease;
  return (
    <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-bone">What this installation may use</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => void sync()}
          className="inline-flex items-center gap-1.5 rounded border border-ink-line px-3 py-1 text-xs text-bone hover:bg-ink-deep disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden="true" /> Sync now
        </button>
      </div>
      {busy ? <Working label="Asking Studio" seconds={elapsed} /> : null}
      <p className="mt-1 text-[11px] text-bone-faint">
        Last checked {when(status.sync?.okAt)}.{status.sync?.problem ? ` The last attempt did not complete: ${status.sync.problem}` : ''}
      </p>
      {lease && !lease.ok ? <p className="mt-2 break-words text-xs text-signal-wait">{lease.why}</p> : null}
      {lease && lease.ok ? (
        <>
          <p className="mt-1 text-[11px] text-bone-faint">
            Signed by Studio and valid until {when(lease.validUntil)}. If Studio cannot be reached before then,
            marketplace Plugins pause and nothing else does.
          </p>
          {lease.entitlements.length === 0 ? (
            <p className="mt-2 text-xs text-bone-faint">Nothing yet. Get a Plugin on Studio and assign it to this installation.</p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-line">
              {lease.entitlements.map((entry) => (
                <li key={entry.entitlement_id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5 text-xs">
                  <span className="text-bone">
                    {entry.plugin_id} {entry.version ? <span className="text-bone-faint">{entry.version}</span> : null}
                  </span>
                  <span className={entry.usable ? 'text-signal-live' : 'text-signal-wait'}>
                    {entry.usable ? 'usable here' : (entry.reason ?? 'not usable').toLowerCase().replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-fail">{problem}</p> : null}
    </section>
  );
}

interface LinkedWallet {
  address: string;
  chain_id: number;
  verified_at: string;
}

const utf8Hex = (text: string) =>
  `0x${Array.from(new TextEncoder().encode(text))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

/**
 * Linking a wallet to the Studio account, from here. Studio writes the
 * message and checks the signature; the local API checks the message is a
 * wallet-link message for this wallet before this page may show it; the
 * wallet shows it to the owner. It signs a message and nothing else: no
 * transaction, no allowance, no gas.
 */
function WalletSection({ wallets, onChanged }: { wallets: AnnouncedWallet[]; onChanged: () => void }) {
  const linked = useResource<{ ok: true; wallets: LinkedWallet[] } | { ok: false; why: string }>('/api/studio/wallets');
  const [walletId, setWalletId] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const elapsed = useElapsed(step !== null);
  const chosen = wallets.find((w) => w.uuid === walletId) ?? wallets[0] ?? null;

  const connect = async () => {
    if (!chosen) return;
    setProblem(null);
    try {
      setStep(`Asking ${chosen.name} which account to link`);
      const accounts = (await chosen.provider.request({ method: 'eth_requestAccounts' })) as string[];
      const address = accounts[0];
      if (!address) {
        setProblem(`${chosen.name} did not share an account.`);
        return;
      }
      setStep('Asking Studio for a one-time message');
      const challenge = await post<{ ok: true; challengeId: string; message: string } | { ok: false; why: string }>('/api/studio/wallets/challenge', { address });
      if (!challenge.ok) {
        setProblem(challenge.why);
        return;
      }
      setStep(`Waiting for you to sign the message in ${chosen.name}`);
      const signature = String(await chosen.provider.request({ method: 'personal_sign', params: [utf8Hex(challenge.message), address] }));
      setStep('Studio is checking the signature');
      const done = await post<{ ok: boolean; why?: string }>('/api/studio/wallets', { challengeId: challenge.challengeId, signature });
      if (!done.ok) setProblem(done.why ?? 'Studio did not accept the signature.');
      linked.reload();
      onChanged();
    } catch (error) {
      const code = (error as { code?: number }).code;
      setProblem(code === 4001 ? 'You declined it in the wallet. Nothing was linked.' : error instanceof Error ? error.message : String(error));
    } finally {
      setStep(null);
    }
  };

  const list = linked.data && linked.data.ok ? linked.data.wallets : [];
  return (
    <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
      <h2 className="text-sm font-medium text-bone">Your wallet</h2>
      <p className="mt-1 text-[11px] text-bone-faint">
        A purchase is paid from a wallet linked to your Studio account. Linking asks your wallet to sign a message proving
        you control it. It sends nothing and costs nothing, and AI17Z never sees a key.
      </p>
      {linked.data && !linked.data.ok ? <p className="mt-2 break-words text-xs text-signal-wait">{linked.data.why}</p> : null}
      {list.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs">
          {list.map((w) => (
            <li key={w.address} className="break-all text-bone">
              {w.address} <span className="text-bone-faint">linked {when(w.verified_at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {wallets.length === 0 ? (
        <p className="mt-2 text-xs text-signal-wait">No wallet announced itself in this browser. Open AI17Z in a browser with your wallet extension installed.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {wallets.length > 0 ? (
            <select value={chosen?.uuid ?? ''} onChange={(event) => setWalletId(event.target.value)} className="rounded border border-ink-line bg-ink-deep px-2 py-1 text-bone">
              {wallets.map((w) => (
                <option key={w.uuid} value={w.uuid}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" disabled={step !== null} onClick={() => void connect()} className="inline-flex items-center gap-1.5 rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep disabled:opacity-50">
            <Wallet size={13} aria-hidden="true" /> {list.length > 0 ? 'Link another wallet' : 'Connect wallet'}
          </button>
        </div>
      )}
      {step ? <Working label={step} seconds={elapsed} slowAfter={60} /> : null}
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-fail">{problem}</p> : null}
    </section>
  );
}

function PurchasesSection({ status }: { status: StudioStatus }) {
  const purchases = useResource<Purchases>('/api/studio/purchases');
  const wallets = useWallets();
  usePolling(() => purchases.reload(), 30_000, true);
  if (purchases.loading && !purchases.data) return <Working label="Reading purchases" seconds={0} />;
  if (purchases.error || !purchases.data) {
    return <RetryablePanel title="Purchases did not load" detail={purchases.error ?? 'No answer.'} onRetry={purchases.reload} />;
  }
  const { studio, ledger } = purchases.data;
  const open = studio.ok ? studio.purchases.filter((p) => ['AWAITING_PAYMENT', 'SUBMITTED', 'CONFIRMING'].includes(p.status)) : [];
  const settled = studio.ok ? studio.purchases.filter((p) => !['AWAITING_PAYMENT', 'SUBMITTED', 'CONFIRMING'].includes(p.status)) : [];
  return (
    <>
      <WalletSection wallets={wallets} onChanged={purchases.reload} />
      <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <h2 className="text-sm font-medium text-bone">Pending purchases</h2>
        <p className="mt-1 text-[11px] text-bone-faint">
          A purchase you start on Studio for this installation is finished here, where your own wallet signs it. Only one
          kind of transaction is ever prepared: a transfer of the exact $AI17Z price on {status.payment.chainName} to the
          publisher. Never an approval, a swap or any other call.
        </p>
        {!studio.ok ? <p className="mt-2 break-words text-xs text-signal-wait">{studio.why}</p> : null}
        {open.length === 0 && studio.ok ? <p className="mt-2 text-xs text-bone-faint">Nothing is waiting.</p> : null}
        <ul className="mt-2 space-y-3">
          {open.map((purchase) => (
            <PurchaseRow
              key={purchase.intent_id}
              purchase={purchase}
              recorded={ledger.find((row) => row.intentId === purchase.intent_id) ?? null}
              wallets={wallets}
              onChanged={purchases.reload}
            />
          ))}
        </ul>
        {settled.length > 0 ? (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-bone-faint">Settled on Studio ({settled.length})</summary>
            <ul className="mt-2 space-y-2">
              {settled.map((p) => (
                <li key={p.intent_id} className="break-all text-bone-faint">
                  {p.plugin_name}: {formatBaseUnits(p.amount_base_units)} AI17Z, {p.status.toLowerCase()}
                  {p.submitted_tx_hash ? `, ${p.submitted_tx_hash}` : ''}
                  {p.failure_reason ? `, ${p.failure_reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {ledger.length > 0 ? (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-bone-faint">Recorded on this installation ({ledger.length})</summary>
            <ul className="mt-2 divide-y divide-ink-line">
              {ledger.map((row) => (
                <li key={row.intentId} className="space-y-0.5 py-1.5">
                  <p className="text-bone">
                    {row.pluginName}: {formatBaseUnits(row.amountBaseUnits)} AI17Z to {shortAddress(row.recipientAddress)}
                  </p>
                  <p className="break-all text-bone-faint">
                    {row.state === 'SENT' ? 'submitted' : row.state.toLowerCase()}
                    {row.studioStatus ? `, Studio says ${row.studioStatus.toLowerCase().replace(/_/g, ' ')}` : ''}
                    {row.txHash ? `, ${row.txHash}` : ''}
                    {row.note ? `, ${row.note}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </>
  );
}

interface Review {
  ok: true;
  purchase: PreparedMarketplacePurchase;
  terms: StudioPurchase;
  preflight: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
}

function Terms({ purchase, token, chainName }: { purchase: StudioPurchase; token: string; chainName: string }) {
  const rows: Array<[string, string]> = [
    ['Plugin', `${purchase.plugin_name}${purchase.plugin_version ? ` ${purchase.plugin_version}` : ''}`],
    ['Publisher', purchase.publisher ?? 'not stated'],
    ['Price', `${formatBaseUnits(purchase.amount_base_units)} AI17Z (${purchase.amount_base_units} base units)`],
    ['Token', token],
    ['Chain', `${chainName} (${purchase.chain_id})`],
    ['Recipient', purchase.recipient_address],
    ['Paying wallet', purchase.payer_address],
    ['Purchase', purchase.intent_id],
    ['Started', when(purchase.created_at)],
    ['Pay before', when(purchase.expires_at)],
    ['State', purchase.status.toLowerCase().replace(/_/g, ' ')],
  ];
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-bone-faint">{label}</dt>
          <dd className="break-all text-bone">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PurchaseRow({
  purchase,
  recorded,
  wallets,
  onChanged,
}: {
  purchase: StudioPurchase;
  recorded: LedgerRow | null;
  wallets: AnnouncedWallet[];
  onChanged: () => void;
}) {
  const [walletId, setWalletId] = useState<string>('');
  const [review, setReview] = useState<Review | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [manualHash, setManualHash] = useState('');
  const elapsed = useElapsed(step !== null);
  const inFlight = useRef(false);
  const chosen = wallets.find((w) => w.uuid === walletId) ?? wallets[0] ?? null;
  const awaiting = purchase.status === 'AWAITING_PAYMENT';
  const waitingOnWallet = recorded?.state === 'PREPARED';
  const alreadySent = recorded?.state === 'SENT' || Boolean(purchase.submitted_tx_hash);

  const report = async (hash: string) => {
    const answer = await post<{ ok: boolean; why?: string; studioProblem?: string }>(`/api/studio/purchases/${purchase.intent_id}/sent`, { txHash: hash });
    if (!answer.ok) setProblem(answer.why ?? 'The transaction could not be recorded.');
    else if (answer.studioProblem) setProblem(answer.studioProblem);
  };

  const check = async () => {
    setProblem(null);
    setReview(null);
    setStep('Checking the terms and reading the chain');
    try {
      const answer = await post<Review | { ok: false; why: string }>(`/api/studio/purchases/${purchase.intent_id}/review`, {});
      if (!answer.ok) setProblem(answer.why);
      else if (!isExactPurchaseTransaction(answer.purchase) || answer.purchase.amountBaseUnits !== purchase.amount_base_units) {
        setProblem('What was prepared is not exactly this purchase, so it will not be offered to your wallet.');
      } else setReview(answer);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStep(null);
    }
  };

  const pay = async () => {
    if (inFlight.current || !chosen || !review?.preflight.ok) return;
    inFlight.current = true;
    setProblem(null);
    try {
      setStep('Preparing the one transfer this purchase allows');
      const prepared = await post<{ ok: true; purchase: PreparedMarketplacePurchase } | { ok: false; why: string }>(`/api/studio/purchases/${purchase.intent_id}/prepare`, {});
      if (!prepared.ok) {
        setProblem(prepared.why);
        return;
      }
      const tx = prepared.purchase;
      // The last look before a signature is asked for: identical to what the owner just confirmed.
      if (
        !isExactPurchaseTransaction(tx) ||
        tx.amountBaseUnits !== review.purchase.amountBaseUnits ||
        tx.recipient !== review.purchase.recipient ||
        tx.payer !== review.purchase.payer ||
        tx.transaction.data !== review.purchase.transaction.data
      ) {
        setProblem('What was prepared differs from what you confirmed, so your wallet was not asked.');
        await post(`/api/studio/purchases/${purchase.intent_id}/not-sent`, {});
        return;
      }
      setStep(`Asking ${chosen.name} which account to use`);
      const accounts = ((await chosen.provider.request({ method: 'eth_requestAccounts' })) as string[]).map((a) => a.toLowerCase());
      if (!accounts.includes(tx.payer)) {
        setProblem(`Switch ${chosen.name} to ${tx.payer}, the wallet this checkout was started with, and try again.`);
        await post(`/api/studio/purchases/${purchase.intent_id}/not-sent`, {});
        return;
      }
      const chain = String(await chosen.provider.request({ method: 'eth_chainId' })).toLowerCase();
      if (chain !== tx.chainIdHex) {
        setStep(`Asking ${chosen.name} to switch to ${review.purchase.chainId === 4663 ? 'Robinhood Chain' : review.purchase.chainId}`);
        try {
          await chosen.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: tx.chainIdHex }] });
        } catch {
          setProblem(`Add Robinhood Chain (chain ${tx.chainId}) to ${chosen.name}, then try again.`);
          await post(`/api/studio/purchases/${purchase.intent_id}/not-sent`, {});
          return;
        }
      }
      setStep(`Waiting for you to confirm in ${chosen.name}`);
      let hash: string;
      try {
        hash = String(await chosen.provider.request({ method: 'eth_sendTransaction', params: [tx.transaction] }));
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === 4001) {
          await post(`/api/studio/purchases/${purchase.intent_id}/not-sent`, {});
          setProblem('You declined it in the wallet. Nothing was sent.');
        } else {
          setProblem(`${chosen.name} did not return a transaction (${(error as Error).message ?? 'no reason given'}). Check its activity before doing anything else.`);
        }
        return;
      }
      setStep('Recording the transaction');
      await report(hash);
      setReview(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setStep(null);
      onChanged();
    }
  };

  return (
    <li className="space-y-2 rounded border border-ink-line p-3 text-xs">
      <Terms purchase={purchase} token={AI17Z_PAYMENT.tokenChecksum} chainName={AI17Z_PAYMENT.chainName} />
      {awaiting && !alreadySent && !waitingOnWallet && !review ? (
        <button type="button" disabled={step !== null} onClick={() => void check()} className="rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep disabled:opacity-50">
          Review payment
        </button>
      ) : null}
      {review && awaiting && !alreadySent && !waitingOnWallet ? (
        <div className="space-y-2 rounded border border-signal-warn/50 bg-signal-warn/[0.05] p-3">
          <p className="font-medium text-bone">Confirm before your wallet is asked</p>
          <p className="text-bone">
            Send <strong>{review.purchase.amountDisplay} AI17Z</strong> to <span className="break-all">{review.purchase.recipient}</span> on{' '}
            {AI17Z_PAYMENT.chainName}, from <span className="break-all">{review.purchase.payer}</span>, for {purchase.plugin_name}.
          </p>
          <p className="break-all text-bone-faint">
            One ERC-20 transfer to the $AI17Z contract {AI17Z_PAYMENT.tokenChecksum}. No approval, no swap, no other call.
            Calldata {review.purchase.transaction.data}
          </p>
          <ul className="space-y-0.5">
            {review.preflight.checks.map((c) => (
              <li key={c.name} className={c.ok ? 'text-signal-live' : 'text-signal-fail'}>
                {c.ok ? 'OK' : 'NO'} {c.name}: {c.detail}
              </li>
            ))}
          </ul>
          {!review.preflight.ok ? <p className="text-signal-fail">The chain does not agree this transfer can go ahead, so it cannot be sent.</p> : null}
          {wallets.length === 0 ? (
            <p className="text-signal-wait">No wallet announced itself in this browser.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {wallets.length > 0 ? (
                <select value={chosen?.uuid ?? ''} onChange={(event) => setWalletId(event.target.value)} className="rounded border border-ink-line bg-ink-deep px-2 py-1 text-bone">
                  {wallets.map((w) => (
                    <option key={w.uuid} value={w.uuid}>
                      {w.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                disabled={step !== null || !review.preflight.ok}
                onClick={() => void pay()}
                className="inline-flex items-center gap-1.5 rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep disabled:opacity-50"
              >
                {chosen && safeIcon(chosen.icon) ? <img src={safeIcon(chosen.icon)!} alt="" className="h-3.5 w-3.5" /> : <Wallet size={13} aria-hidden="true" />}
                Ask {chosen?.name ?? 'my wallet'} to sign this transfer
              </button>
              <button type="button" disabled={step !== null} onClick={() => setReview(null)} className="rounded border border-ink-line px-3 py-1 text-bone-faint hover:bg-ink-deep">
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : null}
      {waitingOnWallet && !alreadySent ? (
        <div className="space-y-2 rounded border border-signal-wait/40 p-2">
          <p className="text-bone">
            Your wallet was asked to pay for this and AI17Z did not hear back. Check the wallet&apos;s activity before doing
            anything else, so the payment is never sent twice.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={manualHash}
              onChange={(event) => setManualHash(event.target.value)}
              placeholder="0x… transaction hash"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-ink-line bg-ink-deep px-2 py-1 font-mono text-xs text-bone"
            />
            <button type="button" disabled={!/^0x[0-9a-fA-F]{64}$/.test(manualHash.trim())} onClick={() => void report(manualHash.trim()).then(onChanged)} className="rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep disabled:opacity-50">
              It was sent
            </button>
            <button type="button" onClick={() => void post(`/api/studio/purchases/${purchase.intent_id}/not-sent`, {}).then(onChanged)} className="rounded border border-ink-line px-3 py-1 text-bone-faint hover:bg-ink-deep">
              Nothing was sent
            </button>
          </div>
        </div>
      ) : null}
      {alreadySent ? (
        <p className="break-all text-bone-faint">
          Submitted{recorded?.txHash ? ` as ${recorded.txHash}` : purchase.submitted_tx_hash ? ` as ${purchase.submitted_tx_hash}` : ''}. Studio grants it
          only after reading the transfer on the chain itself, once the block is finalised, which can take around twenty
          minutes. Sync on this tab afterwards.
        </p>
      ) : null}
      {step ? <Working label={step} seconds={elapsed} slowAfter={60} /> : null}
      {problem ? <p className="break-words text-signal-fail">{problem}</p> : null}
    </li>
  );
}
