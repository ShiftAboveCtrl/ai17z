import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2, RefreshCw, ShieldAlert, Unlink, Wallet } from 'lucide-react';
import { AI17Z_PAYMENT, formatBaseUnits, isExactPurchaseTransaction, type PreparedMarketplacePurchase } from '@xbam/shared/contracts';
import { post } from '@app/lib/api';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import { RetryablePanel, Working } from '@app/components/ui';
import { ROBINHOOD_CHAIN_PARAMS, discoverWallets, ensureChain, type DiscoveredWallet, type Eip1193, type WalletWindow } from '@app/lib/walletDiscovery';

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
  /** Paid-through time of a subscription; null or absent for anything that does not lapse. */
  expires_at?: string | null;
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
  installed: Record<string, string>;
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
  kind?: 'PURCHASE' | 'RENEWAL';
  billing_mode?: string | null;
  payment_asset?: 'AI17Z' | 'ETH';
  base_price_wei?: string | null;
  platform_fee_bps?: number | null;
  ai17z_discount_bps?: number | null;
  quote_ai17z_per_eth_x18?: string | null;
  quote_expires_at?: string | null;
  legs?: StudioLeg[];
}

interface StudioLeg {
  leg_index: number;
  role: 'PUBLISHER' | 'TREASURY';
  asset: 'AI17Z' | 'ETH';
  recipient_address: string;
  amount_base_units: string;
  status: string;
  submitted_tx_hash: string | null;
  failure_reason: string | null;
}

interface LedgerRow {
  intentId: string;
  legIndex: number;
  attempt: number;
  role: 'PUBLISHER' | 'TREASURY';
  asset: 'AI17Z' | 'ETH';
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

interface AnnouncedWallet {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193;
  source: DiscoveredWallet['source'];
}

/** Every wallet in this browser, each with its own provider, for the life of the page. */
function useWallets(): AnnouncedWallet[] {
  const [wallets, setWallets] = useState<AnnouncedWallet[]>([]);
  useEffect(
    () =>
      discoverWallets(window as unknown as WalletWindow, (found) =>
        setWallets(found.map((w) => ({ uuid: w.key, name: w.name, icon: w.icon, rdns: w.rdns, provider: w.provider, source: w.source }))),
      ),
    [],
  );
  return wallets;
}

/** What the chosen wallet itself says: its account (without asking to connect) and chain, kept current by its events. */
function useWalletState(wallet: AnnouncedWallet | null) {
  const [state, setState] = useState<{ account: string | null; chainId: string | null }>({ account: null, chainId: null });
  useEffect(() => {
    if (!wallet) return;
    const provider = wallet.provider;
    let live = true;
    const read = async () => {
      const accounts = (await provider.request({ method: 'eth_accounts' }).catch(() => [])) as string[];
      const chainId = (await provider.request({ method: 'eth_chainId' }).catch(() => null)) as string | null;
      if (live) setState({ account: accounts[0]?.toLowerCase() ?? null, chainId: chainId ? String(chainId).toLowerCase() : null });
    };
    void read();
    const onChange = () => void read();
    for (const event of ['accountsChanged', 'chainChanged', 'connect', 'disconnect']) provider.on?.(event, onChange);
    return () => {
      live = false;
      for (const event of ['accountsChanged', 'chainChanged', 'connect', 'disconnect']) provider.removeListener?.(event, onChange);
    };
  }, [wallet]);
  return state;
}

function WalletPicker({ wallets, chosen, onChoose }: { wallets: AnnouncedWallet[]; chosen: AnnouncedWallet | null; onChoose: (uuid: string) => void }) {
  const state = useWalletState(chosen);
  const missing = ['Phantom', 'Backpack'].filter((name) => !wallets.some((w) => w.name.toLowerCase().includes(name.toLowerCase())));
  const network =
    state.chainId === null ? 'network unknown' : state.chainId === ROBINHOOD_CHAIN_PARAMS.chainId ? 'on Robinhood Chain' : `on chain ${Number.parseInt(state.chainId, 16)}, will ask to switch`;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {wallets.map((w) => (
          <button
            key={w.uuid}
            type="button"
            onClick={() => onChoose(w.uuid)}
            className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${chosen?.uuid === w.uuid ? 'border-bone text-bone' : 'border-ink-line text-bone-faint'}`}
          >
            {safeIcon(w.icon) ? <img src={safeIcon(w.icon)!} alt="" className="h-3.5 w-3.5" /> : <Wallet size={13} aria-hidden="true" />}
            {w.name}
          </button>
        ))}
      </div>
      {chosen ? (
        <p className="break-all text-[11px] text-bone-faint">
          {chosen.name}: {state.account ?? 'not connected yet'}, {network}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="text-[11px] text-bone-faint">
          Not found on this page: {missing.join(', ')}.{' '}
          {!window.isSecureContext ? 'This page is not https or localhost, and Phantom only runs on those. ' : ''}
          {missing.includes('Phantom') ? (
            <a className="underline" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">
              Install Phantom
            </a>
          ) : null}{' '}
          {missing.includes('Backpack') ? (
            <a className="underline" href="https://backpack.app/download" target="_blank" rel="noopener noreferrer">
              Install Backpack
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** Safe facts about wallet discovery on this page, for the owner. No secrets. */
function WalletDiagnostics({ wallets }: { wallets: AnnouncedWallet[] }) {
  const w = window as unknown as { phantom?: { ethereum?: { isPhantom?: boolean } }; ethereum?: { providers?: unknown[] } };
  const facts: Array<[string, string]> = [
    ['Origin', window.location.origin],
    ['Top-level', window.top === window ? 'yes' : 'no'],
    ['Secure or localhost', window.isSecureContext ? 'yes' : 'no, Phantom will not inject here'],
    ['Phantom EVM provider', w.phantom?.ethereum?.isPhantom ? 'present' : 'absent'],
    ['Legacy window.ethereum', w.ethereum ? 'present' : 'absent'],
    ['window.ethereum.providers', String(Array.isArray(w.ethereum?.providers) ? w.ethereum!.providers!.length : 0)],
  ];
  return (
    <details className="rounded-lg border border-ink-line bg-ink-panel p-3 text-[11px] text-bone-faint">
      <summary className="cursor-pointer">Wallet diagnostics</summary>
      <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-3">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-1">
        {wallets.map((x) => (
          <li key={x.uuid} className="break-all">
            {x.name} via {x.source}
            {x.rdns ? `, ${x.rdns}` : ''}, flags{' '}
            {['isPhantom', 'isMetaMask', 'isBackpack'].filter((flag) => (x.provider as unknown as Record<string, unknown>)[flag] === true).join(' ') || 'none'}
          </li>
        ))}
      </ul>
    </details>
  );
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
                <EntitlementRow key={entry.entitlement_id} entry={entry} status={status} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </>
      ) : null}
      {problem ? <p className="mt-2 break-words text-[11px] text-signal-fail">{problem}</p> : null}
    </section>
  );
}

/**
 * One Plugin this installation is entitled to. A subscription shows when it is
 * paid through, and once lapsed says so plainly: the Plugin stays installed
 * and visible and does not run until the owner renews it. Renewing is always
 * the owner starting a checkout on Studio; nothing here pays by itself.
 */
function EntitlementRow({ entry, status, onChanged }: { entry: LeaseEntitlement; status: StudioStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const elapsed = useElapsed(busy);
  const lapsed = entry.reason === 'SUBSCRIPTION_EXPIRED' || Boolean(entry.expires_at && Date.parse(entry.expires_at) <= Date.now());
  const installedVersion = status.installed[entry.plugin_id] ?? null;
  const renewUrl = status.origin ? `${status.origin}/marketplace/${encodeURIComponent(entry.plugin_id)}/checkout` : null;
  const install = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await post<{ ok: boolean; why?: string; needsAcknowledgement?: string[] }>('/api/plugins/registry/install', { id: entry.plugin_id, acknowledgeExpansion: false });
      if (!answer.ok) setProblem([answer.why, ...(answer.needsAcknowledgement ?? [])].filter(Boolean).join(' ') || 'It could not be installed.');
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="space-y-1 py-1.5 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-bone">
          {entry.plugin_id} {entry.version ? <span className="text-bone-faint">{entry.version}</span> : null}
        </span>
        <span className={entry.usable && !lapsed ? 'text-signal-live' : 'text-signal-wait'}>
          {lapsed ? 'subscription ended' : entry.usable ? 'usable here' : (entry.reason ?? 'not usable').toLowerCase().replace(/_/g, ' ')}
        </span>
      </div>
      {entry.expires_at ? (
        <p className="text-[11px] text-bone-faint">
          {lapsed
            ? `Subscription ended ${when(entry.expires_at)}. The Plugin stays installed and does not run until it is renewed.`
            : `Subscription paid through ${when(entry.expires_at)}. Nothing renews by itself.`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {entry.usable && !lapsed && !installedVersion ? (
          <button type="button" disabled={busy} onClick={() => void install()} className="rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep disabled:opacity-50">
            New Plugin available: install
          </button>
        ) : null}
        {entry.usable && installedVersion && entry.version && installedVersion !== entry.version ? (
          <span className="text-[11px] text-signal-wait">Installed {installedVersion}; Studio publishes {entry.version}. Update it from Installed.</span>
        ) : null}
        {entry.expires_at && renewUrl ? (
          <a href={renewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep">
            <ExternalLink size={12} aria-hidden="true" /> {lapsed ? 'Renew on Studio' : 'Renew early on Studio'}
          </a>
        ) : null}
      </div>
      {installedVersion && entry.usable && !lapsed ? (
        <p className="text-[11px] text-bone-faint">Installed. Choose which agents may use it under Installed; nothing runs for an agent until you allow it.</p>
      ) : null}
      {busy ? <Working label="Installing from Studio" seconds={elapsed} /> : null}
      {problem ? <p className="break-words text-[11px] text-signal-fail">{problem}</p> : null}
    </li>
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
          <WalletPicker wallets={wallets} chosen={chosen} onChoose={setWalletId} />
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

const OPEN_STATUSES = ['AWAITING_PAYMENT', 'SUBMITTED', 'CONFIRMING', 'PARTIALLY_PAID'];
const unitOf = (asset: string | undefined) => (asset === 'ETH' ? 'ETH' : 'AI17Z');
const PLAN: Record<string, string> = { ONE_TIME: 'One-time purchase', MONTHLY: 'Monthly subscription', YEARLY: 'Yearly subscription' };
const planOf = (p: StudioPurchase) => `${PLAN[p.billing_mode ?? ''] ?? 'One-time purchase'}${p.kind === 'RENEWAL' ? ', renewal' : ''}`;

/** The payments of a checkout. A Studio from before payment legs lists one, at the top level. */
function legsOf(p: StudioPurchase): StudioLeg[] {
  if (p.legs && p.legs.length > 0) return p.legs;
  return [
    {
      leg_index: 0,
      role: 'PUBLISHER',
      asset: 'AI17Z',
      recipient_address: p.recipient_address,
      amount_base_units: p.amount_base_units,
      status: p.status === 'AWAITING_PAYMENT' ? 'AWAITING_PAYMENT' : p.submitted_tx_hash ? 'SUBMITTED' : p.status,
      submitted_tx_hash: p.submitted_tx_hash,
      failure_reason: p.failure_reason,
    },
  ];
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
  const open = studio.ok ? studio.purchases.filter((p) => OPEN_STATUSES.includes(p.status)) : [];
  const settled = studio.ok ? studio.purchases.filter((p) => !OPEN_STATUSES.includes(p.status)) : [];
  return (
    <>
      <WalletSection wallets={wallets} onChanged={purchases.reload} />
      <WalletDiagnostics wallets={wallets} />
      <section className="rounded-lg border border-ink-line bg-ink-panel p-4">
        <h2 className="text-sm font-medium text-bone">Pending purchases</h2>
        <p className="mt-1 text-[11px] text-bone-faint">
          A purchase or renewal you start on Studio for this installation is finished here, where your own wallet signs
          it. A checkout is one or two payments on {status.payment.chainName}: the publisher&apos;s share and, on a paid plan,
          the marketplace fee. Each is exactly one of two things: a plain ETH transfer with no data, or a transfer of
          $AI17Z. Never an approval, a swap, a contract call or anything that repeats. Nothing renews by itself.
        </p>
        {!studio.ok ? <p className="mt-2 break-words text-xs text-signal-wait">{studio.why}</p> : null}
        {open.length === 0 && studio.ok ? <p className="mt-2 text-xs text-bone-faint">Nothing is waiting.</p> : null}
        <ul className="mt-2 space-y-3">
          {open.map((purchase) => (
            <PurchaseCard key={purchase.intent_id} purchase={purchase} ledger={ledger} wallets={wallets} onChanged={purchases.reload} />
          ))}
        </ul>
        {settled.length > 0 ? (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-bone-faint">Settled on Studio ({settled.length})</summary>
            <ul className="mt-2 space-y-2">
              {settled.map((p) => (
                <li key={p.intent_id} className="break-all text-bone-faint">
                  {p.plugin_name} ({planOf(p)}): {formatBaseUnits(p.amount_base_units)} {unitOf(p.payment_asset)}, {p.status.toLowerCase()}
                  {p.failure_reason ? `, ${p.failure_reason}` : ''}
                  {legsOf(p).map((l) => (l.submitted_tx_hash ? `, ${l.role.toLowerCase()} ${l.submitted_tx_hash}` : '')).join('')}
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
                <li key={`${row.intentId}:${row.legIndex}:${row.attempt}`} className="space-y-0.5 py-1.5">
                  <p className="text-bone">
                    {row.pluginName}: {formatBaseUnits(row.amountBaseUnits)} {unitOf(row.asset)} to {shortAddress(row.recipientAddress)}
                    {row.role === 'TREASURY' ? ' (marketplace fee)' : ''}
                    {row.attempt > 1 ? `, attempt ${row.attempt}` : ''}
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

function Terms({ purchase, chainName }: { purchase: StudioPurchase; chainName: string }) {
  const asset = unitOf(purchase.payment_asset);
  const rows: Array<[string, string]> = [
    ['Plugin', `${purchase.plugin_name}${purchase.plugin_version ? ` ${purchase.plugin_version}` : ''}`],
    ['Publisher', purchase.publisher ?? 'not stated'],
    ['Plan', planOf(purchase)],
    ['Total', `${formatBaseUnits(purchase.amount_base_units)} ${asset} (${purchase.amount_base_units} base units)`],
    ['Pay with', asset === 'ETH' ? 'ETH' : `$AI17Z, contract ${AI17Z_PAYMENT.tokenChecksum}`],
    ['Chain', `${chainName} (${purchase.chain_id})`],
    ['Paying wallet', purchase.payer_address],
    ['Purchase', purchase.intent_id],
    ['Started', when(purchase.created_at)],
    ['Pay before', when(purchase.expires_at)],
    ['State', purchase.status.toLowerCase().replace(/_/g, ' ')],
  ];
  if (purchase.platform_fee_bps != null && purchase.base_price_wei) {
    rows.splice(4, 0, ['Base price', `${formatBaseUnits(purchase.base_price_wei)} ETH, marketplace fee ${purchase.platform_fee_bps / 100}%`]);
  }
  if (purchase.payment_asset === 'AI17Z' && purchase.quote_ai17z_per_eth_x18) {
    rows.splice(5, 0, [
      'AI17Z price',
      `${formatBaseUnits(purchase.quote_ai17z_per_eth_x18)} AI17Z per ETH, ${purchase.ai17z_discount_bps != null ? `${purchase.ai17z_discount_bps / 100}% off for paying in AI17Z, ` : ''}fixed until ${when(purchase.quote_expires_at)}`,
    ]);
  }
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

function PurchaseCard({ purchase, ledger, wallets, onChanged }: { purchase: StudioPurchase; ledger: LedgerRow[]; wallets: AnnouncedWallet[]; onChanged: () => void }) {
  const legs = legsOf(purchase);
  return (
    <li className="space-y-2 rounded border border-ink-line p-3 text-xs">
      <Terms purchase={purchase} chainName={AI17Z_PAYMENT.chainName} />
      {legs.length > 1 ? (
        <p className="text-bone-faint">
          {legs.length} payments. The Plugin is granted only when every one is final; a payment already made is never asked for again.
        </p>
      ) : null}
      <ol className="space-y-2">
        {legs.map((leg) => {
          // The latest attempt this installation recorded for this payment.
          const recorded =
            ledger
              .filter((row) => row.intentId === purchase.intent_id && row.legIndex === leg.leg_index)
              .sort((a, b) => b.attempt - a.attempt)[0] ?? null;
          return <LegPayment key={leg.leg_index} purchase={purchase} leg={leg} count={legs.length} recorded={recorded} wallets={wallets} onChanged={onChanged} />;
        })}
      </ol>
    </li>
  );
}

function LegPayment({
  purchase,
  leg,
  count,
  recorded,
  wallets,
  onChanged,
}: {
  purchase: StudioPurchase;
  leg: StudioLeg;
  count: number;
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
  const unit = unitOf(leg.asset);
  const base = `/api/studio/purchases/${purchase.intent_id}`;
  const q = `?leg=${leg.leg_index}`;
  // Payable: never asked for, or refused by the chain and still owed.
  const payable = leg.status === 'AWAITING_PAYMENT' || leg.status === 'FAILED';
  const refused = leg.status === 'FAILED';
  const waitingOnWallet = recorded?.state === 'PREPARED';
  const alreadySent = !refused && (recorded?.state === 'SENT' || Boolean(leg.submitted_tx_hash));
  const chosenState = useWalletState(chosen);
  useEffect(() => {
    // Another account in the chosen wallet means the confirmation no longer describes what would be signed.
    if (review && chosenState.account && chosenState.account !== review.purchase.payer) setReview(null);
  }, [chosenState.account, chosenState.chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  const notSent = () => post(`${base}/not-sent${q}`, {});
  const report = async (hash: string) => {
    const answer = await post<{ ok: boolean; why?: string; studioProblem?: string }>(`${base}/sent${q}`, { txHash: hash });
    if (!answer.ok) setProblem(answer.why ?? 'The transaction could not be recorded.');
    else if (answer.studioProblem) setProblem(answer.studioProblem);
  };

  const check = async () => {
    setProblem(null);
    setReview(null);
    setStep('Checking the terms and reading the chain');
    try {
      const answer = await post<Review | { ok: false; why: string }>(`${base}/review${q}`, {});
      if (!answer.ok) setProblem(answer.why);
      else if (
        !isExactPurchaseTransaction(answer.purchase) ||
        answer.purchase.legIndex !== leg.leg_index ||
        answer.purchase.amountBaseUnits !== leg.amount_base_units ||
        answer.purchase.recipient !== leg.recipient_address.toLowerCase()
      ) {
        setProblem('What was prepared is not exactly this payment, so it will not be offered to your wallet.');
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
      setStep('Preparing the one transfer this payment allows');
      const prepared = await post<{ ok: true; purchase: PreparedMarketplacePurchase } | { ok: false; why: string }>(`${base}/prepare${q}`, {});
      if (!prepared.ok) {
        setProblem(prepared.why);
        return;
      }
      const tx = prepared.purchase;
      // The last look before a signature is asked for: identical to what the owner just confirmed.
      if (
        !isExactPurchaseTransaction(tx) ||
        tx.legIndex !== review.purchase.legIndex ||
        tx.asset !== review.purchase.asset ||
        tx.amountBaseUnits !== review.purchase.amountBaseUnits ||
        tx.recipient !== review.purchase.recipient ||
        tx.payer !== review.purchase.payer ||
        tx.transaction.to !== review.purchase.transaction.to ||
        tx.transaction.value !== review.purchase.transaction.value ||
        tx.transaction.data !== review.purchase.transaction.data
      ) {
        setProblem('What was prepared differs from what you confirmed, so your wallet was not asked.');
        await notSent();
        return;
      }
      setStep(`Asking ${chosen.name} which account to use`);
      const accounts = ((await chosen.provider.request({ method: 'eth_requestAccounts' })) as string[]).map((a) => a.toLowerCase());
      if (!accounts.includes(tx.payer)) {
        setProblem(`Switch ${chosen.name} to ${tx.payer}, the wallet this checkout was started with, and try again.`);
        await notSent();
        return;
      }
      setStep(`Checking ${chosen.name} is on Robinhood Chain`);
      const onChain = await ensureChain(chosen.provider);
      if (!onChain.ok) {
        setProblem(`${chosen.name}: ${onChain.why}`);
        await notSent();
        return;
      }
      setStep(`Waiting for you to confirm in ${chosen.name}`);
      let hash: string;
      try {
        hash = String(await chosen.provider.request({ method: 'eth_sendTransaction', params: [tx.transaction] }));
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === 4001) {
          await notSent();
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

  const title = count > 1 ? (leg.role === 'TREASURY' ? `Payment ${leg.leg_index + 1} of ${count}: marketplace fee` : `Payment ${leg.leg_index + 1} of ${count}: publisher`) : 'Payment';
  return (
    <li className="space-y-2 rounded border border-ink-line/70 p-2">
      <p className="text-bone">
        <span className="font-medium">{title}</span>: {formatBaseUnits(leg.amount_base_units)} {unit} to <span className="break-all">{leg.recipient_address}</span>
        <span className="text-bone-faint">, {leg.status.toLowerCase().replace(/_/g, ' ')}</span>
      </p>
      {refused && leg.failure_reason ? <p className="break-words text-signal-wait">The chain refused the last transaction for this payment: {leg.failure_reason} It is still owed.</p> : null}
      {payable && !waitingOnWallet && !review ? (
        <button type="button" disabled={step !== null} onClick={() => void check()} className="rounded border border-ink-line px-3 py-1 text-bone hover:bg-ink-deep disabled:opacity-50">
          {refused ? 'Review and pay again' : 'Review payment'}
        </button>
      ) : null}
      {review && payable && !waitingOnWallet ? (
        <div className="space-y-2 rounded border border-signal-warn/50 bg-signal-warn/[0.05] p-3">
          <p className="font-medium text-bone">Confirm before your wallet is asked</p>
          <p className="text-bone">
            Send <strong>{review.purchase.amountDisplay} {unit}</strong> to <span className="break-all">{review.purchase.recipient}</span> on{' '}
            {AI17Z_PAYMENT.chainName}, from <span className="break-all">{review.purchase.payer}</span>, for {purchase.plugin_name}
            {leg.role === 'TREASURY' ? ' (the marketplace fee)' : ''}.
          </p>
          <p className="break-all text-bone-faint">
            {review.purchase.asset === 'ETH'
              ? `A plain ETH transfer of ${review.purchase.amountBaseUnits} wei with no data: no contract is called. No approval, no swap.`
              : `One ERC-20 transfer to the $AI17Z contract ${AI17Z_PAYMENT.tokenChecksum}. No approval, no swap, no other call. Calldata ${review.purchase.transaction.data}`}
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
              <WalletPicker wallets={wallets} chosen={chosen} onChoose={setWalletId} />
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
            Your wallet was asked for this payment and AI17Z did not hear back. Check the wallet&apos;s activity before doing
            anything else, so it is never sent twice.
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
            <button type="button" onClick={() => void notSent().then(onChanged)} className="rounded border border-ink-line px-3 py-1 text-bone-faint hover:bg-ink-deep">
              Nothing was sent
            </button>
          </div>
        </div>
      ) : null}
      {alreadySent ? (
        <p className="break-all text-bone-faint">
          Submitted{recorded?.txHash ? ` as ${recorded.txHash}` : leg.submitted_tx_hash ? ` as ${leg.submitted_tx_hash}` : ''}. Studio accepts it only
          after reading the transfer on the chain itself, once the block is finalised, which can take around twenty minutes.
        </p>
      ) : null}
      {step ? <Working label={step} seconds={elapsed} slowAfter={60} /> : null}
      {problem ? <p className="break-words text-signal-fail">{problem}</p> : null}
    </li>
  );
}
