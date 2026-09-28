import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_WAIT_MS, discoverWallets, ensureChain, type DiscoveredWallet, type Eip1193, type WalletWindow } from '../../apps/web/src/lib/walletDiscovery';

function provider(flags: Partial<Eip1193> = {}, answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const p: Eip1193 & { calls: string[] } = {
    calls,
    ...flags,
    async request({ method }) {
      calls.push(method);
      if (method in answers) {
        const a = answers[method];
        if (a instanceof Error) throw a;
        return typeof a === 'function' ? (a as () => unknown)() : a;
      }
      return method === 'eth_requestAccounts' ? ['0xabc'] : null;
    },
  };
  return p;
}

function page(extra: Partial<WalletWindow> = {}) {
  const target = new EventTarget();
  const win = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    ...extra,
  } as WalletWindow;
  const announce = (uuid: string, name: string, p: Eip1193, rdns = '') =>
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name, icon: '', rdns }, provider: p } }));
  let latest: DiscoveredWallet[] = [];
  const stop = discoverWallets(win, (w) => (latest = w));
  return { win, announce, stop, names: () => latest.map((w) => w.name), wallets: () => latest };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('finding every wallet', () => {
  it.each([
    ['MetaMask first', ['MetaMask', 'Phantom']],
    ['Phantom first', ['Phantom', 'MetaMask']],
  ])('lists both when %s announces', (_label, order) => {
    const p = page();
    for (const name of order) p.announce(name, name, provider());
    expect(p.names().sort()).toEqual(['MetaMask', 'Phantom']);
  });

  it('lists Phantom from its own provider while window.ethereum is MetaMask', () => {
    const phantom = provider({ isPhantom: true });
    const metamask = provider({ isMetaMask: true });
    const p = page({ phantom: { ethereum: phantom }, ethereum: metamask });
    vi.advanceTimersByTime(LEGACY_WAIT_MS);
    expect(p.names().sort()).toEqual(['MetaMask', 'Phantom']);
    expect(p.wallets().find((w) => w.name === 'Phantom')!.provider).toBe(phantom);
  });

  it('does not accept a Phantom that does not say isPhantom', () => {
    const p = page({ phantom: { ethereum: provider() } });
    vi.advanceTimersByTime(LEGACY_WAIT_MS);
    expect(p.names()).toEqual([]);
  });

  it('keeps a late announcement, once, and one entry for a repeated one', () => {
    const p = page();
    const backpack = provider();
    vi.advanceTimersByTime(5000);
    p.announce('bp-1', 'Backpack', backpack, 'app.backpack');
    p.announce('bp-1', 'Backpack', backpack, 'app.backpack');
    expect(p.names()).toEqual(['Backpack']);
  });

  it('replaces the Phantom adapter entry when Phantom announces the same provider', () => {
    const phantom = provider({ isPhantom: true });
    const p = page({ phantom: { ethereum: phantom } });
    p.announce('ph-1', 'Phantom', phantom, 'app.phantom');
    expect(p.wallets().map((w) => [w.name, w.source])).toEqual([['Phantom', 'eip6963']]);
  });

  it('falls back to a legacy wallet that never announces, and enumerates providers', () => {
    const a = provider({ isMetaMask: true });
    const b = provider();
    const p = page({ ethereum: { ...provider(), providers: [a, b] } });
    expect(p.names()).toEqual([]);
    vi.advanceTimersByTime(LEGACY_WAIT_MS);
    expect(p.names()).toEqual(['MetaMask', 'Browser wallet']);
  });

  it('adds no legacy duplicate of an announced wallet, and no button for a wallet that is absent', () => {
    const metamask = provider({ isMetaMask: true });
    const p = page({ ethereum: metamask });
    p.announce('mm', 'MetaMask', metamask, 'io.metamask');
    vi.advanceTimersByTime(LEGACY_WAIT_MS);
    expect(p.names()).toEqual(['MetaMask']);
    expect(p.names()).not.toContain('Backpack');
  });
});

describe('the chosen wallet is the only one asked', () => {
  it('calls only the selected provider', async () => {
    const phantom = provider({ isPhantom: true });
    const metamask = provider({ isMetaMask: true });
    const p = page({ phantom: { ethereum: phantom }, ethereum: metamask });
    vi.advanceTimersByTime(LEGACY_WAIT_MS);
    await p.wallets().find((w) => w.name === 'Phantom')!.provider.request({ method: 'eth_requestAccounts' });
    expect(phantom.calls).toEqual(['eth_requestAccounts']);
    expect(metamask.calls).toEqual([]);
    await p.wallets().find((w) => w.name === 'MetaMask')!.provider.request({ method: 'eth_requestAccounts' });
    expect(metamask.calls).toEqual(['eth_requestAccounts']);
    expect(phantom.calls).toEqual(['eth_requestAccounts']);
  });
});

describe('Robinhood Chain on the chosen wallet', () => {
  beforeEach(() => vi.useRealTimers());

  it('does nothing when already there', async () => {
    const w = provider({}, { eth_chainId: '0x1237' });
    expect(await ensureChain(w)).toEqual({ ok: true });
    expect(w.calls).toEqual(['eth_chainId']);
  });

  it('switches, and adds the chain only when the wallet does not know it', async () => {
    let chain = '0x1';
    const unknown = Object.assign(new Error('unknown chain'), { code: 4902 });
    let added = false;
    const w = provider({}, {
      eth_chainId: () => chain,
      wallet_switchEthereumChain: () => {
        if (!added) throw unknown;
        chain = '0x1237';
      },
      wallet_addEthereumChain: () => {
        added = true;
        chain = '0x1237';
      },
    });
    expect(await ensureChain(w)).toEqual({ ok: true });
    expect(w.calls).toEqual(['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId']);
  });

  it('says so truthfully when the wallet cannot use the chain, and never tries another wallet', async () => {
    const w = provider({}, { eth_chainId: '0x1', wallet_switchEthereumChain: Object.assign(new Error('Unsupported chain'), { code: -32603 }) });
    const result = await ensureChain(w);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toMatch(/does not currently support/);
  });
});
