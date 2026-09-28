/**
 * Finding every EVM wallet in this browser, each by its own provider.
 *
 * Layered, in this order, because extensions race for `window.ethereum` and
 * whichever loads last wins it:
 *   A. EIP-6963 announcements: one entry per announced provider, kept for the
 *      life of the page, late ones included.
 *   B. Phantom's own EVM provider, `window.phantom.ethereum` with `isPhantom`,
 *      in case it did not announce. Never `window.ethereum` for Phantom.
 *   C. Legacy `window.ethereum` (each of `providers` when there are several),
 *      only after a short wait and only for providers not already found.
 *
 * Backpack has no adapter here: it is listed exactly when its extension
 * announces itself (A), because no current documentation establishes a
 * wallet-specific EVM namespace for it.
 *
 * Names and rdns are what a wallet says about itself, for display. The
 * provider object chosen is what is called, and nothing else ever is.
 */

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isPhantom?: boolean;
  isMetaMask?: boolean;
  isBackpack?: boolean;
  providers?: Eip1193[];
}

export interface DiscoveredWallet {
  key: string;
  name: string;
  icon: string;
  rdns: string;
  source: 'eip6963' | 'phantom' | 'legacy';
  provider: Eip1193;
}

export interface WalletWindow {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  phantom?: { ethereum?: Eip1193 };
  ethereum?: Eip1193;
}

export const LEGACY_WAIT_MS = 800;
const REQUEST_AGAIN_MS = [300, 1000, 3000];

function flagsName(provider: Eip1193): string {
  if (provider.isPhantom) return 'Phantom';
  if (provider.isBackpack) return 'Backpack';
  if (provider.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

export function discoverWallets(win: WalletWindow, onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  const byKey = new Map<string, DiscoveredWallet>();
  const emit = () => onChange([...byKey.values()]);
  const known = (provider: Eip1193) => [...byKey.values()].some((w) => w.provider === provider);
  const hasName = (name: string) => [...byKey.values()].some((w) => w.name.toLowerCase().includes(name.toLowerCase()));

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 }>).detail;
    const info = detail?.info;
    const provider = detail?.provider;
    if (!info?.uuid || !info.name || !provider || typeof provider.request !== 'function') return;
    // One entry per provider: an announcement replaces any adapter entry for the same object.
    for (const [key, wallet] of byKey) if (wallet.provider === provider && wallet.source !== 'eip6963') byKey.delete(key);
    if ([...byKey.values()].some((w) => w.source === 'eip6963' && w.provider === provider)) return;
    byKey.set(`eip6963:${info.uuid}`, { key: `eip6963:${info.uuid}`, name: info.name, icon: info.icon ?? '', rdns: info.rdns ?? '', source: 'eip6963', provider });
    emit();
  };

  win.addEventListener('eip6963:announceProvider', onAnnounce);
  const ask = () => win.dispatchEvent(new Event('eip6963:requestProvider'));
  ask();

  const phantom = win.phantom?.ethereum;
  if (phantom?.isPhantom === true && typeof phantom.request === 'function' && !known(phantom)) {
    byKey.set('phantom', { key: 'phantom', name: 'Phantom', icon: '', rdns: 'app.phantom', source: 'phantom', provider: phantom });
    emit();
  }

  const timers = REQUEST_AGAIN_MS.map((ms) => setTimeout(ask, ms));
  timers.push(
    setTimeout(() => {
      const legacy = win.ethereum;
      if (!legacy || typeof legacy.request !== 'function') return;
      const candidates = Array.isArray(legacy.providers) && legacy.providers.length > 0 ? legacy.providers : [legacy];
      candidates.forEach((provider, index) => {
        if (typeof provider.request !== 'function' || known(provider)) return;
        const name = flagsName(provider);
        // Phantom's window.ethereum shim and its own provider are the same wallet.
        if (provider.isPhantom && hasName('Phantom')) return;
        if (name !== 'Browser wallet' && hasName(name)) return;
        byKey.set(`legacy:${index}`, { key: `legacy:${index}`, name, icon: '', rdns: '', source: 'legacy', provider });
      });
      emit();
    }, LEGACY_WAIT_MS),
  );

  return () => {
    timers.forEach(clearTimeout);
    win.removeEventListener('eip6963:announceProvider', onAnnounce);
  };
}

/** Verified 2026-09-28 against the chain's own RPC; used only if a wallet does not know the chain. */
export const ROBINHOOD_CHAIN_PARAMS = {
  chainId: '0x1237',
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};

/** Puts the chosen wallet on Robinhood Chain, or says why it could not. Never another wallet. */
export async function ensureChain(provider: Eip1193): Promise<{ ok: true } | { ok: false; why: string }> {
  const current = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
  if (current === ROBINHOOD_CHAIN_PARAMS.chainId) return { ok: true };
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN_PARAMS.chainId }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 4001) return { ok: false, why: 'You declined switching to Robinhood Chain.' };
    if (code !== 4902) return { ok: false, why: `This wallet does not currently support switching to Robinhood Chain (${(error as Error).message ?? 'no reason given'}).` };
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [ROBINHOOD_CHAIN_PARAMS] });
    } catch (addError) {
      return { ok: false, why: `This wallet could not add Robinhood Chain (${(addError as Error).message ?? 'no reason given'}).` };
    }
  }
  const after = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
  return after === ROBINHOOD_CHAIN_PARAMS.chainId ? { ok: true } : { ok: false, why: `The wallet is still on chain ${Number.parseInt(after, 16)}.` };
}
