import { useState } from 'react';
import { Plug, Plus, Trash2 } from 'lucide-react';
import { ApiError, del, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { useSession } from '@app/lib/session';
import type { AccountRow, HealthReportView, ProviderCredential, ProviderKindInfo } from '@app/lib/types';
import { timeAgo } from '@app/lib/format';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { EmptyState, Field, Modal, Spinner, StatusDot } from '@app/components/ui';
import { SessionPanel } from '@app/components/SessionPanel';

const HEALTH_TONE = { healthy: 'live', degraded: 'wait', offline: 'fail', unknown: 'idle' } as const;

export function SettingsPage() {
  const { user } = useSession();
  const providers = useResource<{ items: ProviderCredential[] }>('/api/providers');
  const kinds = useResource<{ items: ProviderKindInfo[] }>('/api/provider-kinds');
  const accounts = useResource<{ items: AccountRow[] }>('/api/accounts');
  const health = useResource<HealthReportView>('/api/health');
  const settings = useResource<{ system: Record<string, unknown> }>('/api/settings');

  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('ollama');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string; latencyMs: number; models: number }>>({});
  const [openAccount, setOpenAccount] = useState<string | null>(null);

  const selectedKind = kinds.data?.items.find((k) => k.kind === kind);

  const addProvider = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/providers', {
        provider: kind,
        label: label.trim() || kind,
        baseUrl: baseUrl.trim() || null,
        apiKey: apiKey.trim() || null,
      });
      setAdding(false);
      setLabel('');
      setApiKey('');
      setBaseUrl('');
      providers.reload();
      health.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That provider could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const result = await post<{ ok: boolean; detail: string; latencyMs: number; models: string[] }>(
        `/api/providers/${id}/test`,
        {},
      );
      setResults((r) => ({
        ...r,
        [id]: { ok: result.ok, detail: result.detail, latencyMs: result.latencyMs, models: result.models.length },
      }));
    } catch (e) {
      // A failed test is a result, not an absence of one.
      setResults((r) => ({
        ...r,
        [id]: { ok: false, detail: e instanceof ApiError ? e.message : 'The test failed.', latencyMs: 0, models: 0 },
      }));
    } finally {
      setTesting(null);
      providers.reload();
      health.reload();
    }
  };

  const removeProvider = async (id: string) => {
    await del(`/api/providers/${id}`).catch(() => undefined);
    providers.reload();
  };

  return (
    <main className="mx-auto max-w-page px-6 pb-32 pt-32 sm:px-10 sm:pt-44">
      <header className="mb-16">
        <FadeIn>
          <p className="eyebrow mb-6">{user?.email}</p>
        </FadeIn>
        <AnimatedText as="h1" text="Settings" className="monument text-[16vw] leading-[0.84] sm:text-[9vw] lg:text-[6.5vw]" />
      </header>

      <section id="system" className="border-t border-ink-line py-12">
        <p className="eyebrow mb-6">System</p>
        {health.data ? (
          <ul className="divide-y divide-ink-line border-y border-ink-line">
            {health.data.components.map((component) => (
              <li key={component.name} className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3.5">
                <StatusDot state={HEALTH_TONE[component.status]} />
                <span className="text-sm text-bone">{component.name}</span>
                {component.optional && <span className="chip">optional</span>}
                <span className="ml-auto max-w-[24rem] truncate text-right font-mono text-[11px] text-bone-faint">
                  {component.detail ?? component.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Spinner />
        )}
        {settings.data && (
          <p className="mt-4 font-mono text-[11px] text-bone-faint">
            master key {settings.data.system.masterKeyConfigured ? 'configured' : 'MISSING'} · browser{' '}
            {settings.data.system.browserEnabled ? 'enabled' : 'disabled'} · node {String(settings.data.system.nodeVersion)}
          </p>
        )}
      </section>

      <section id="providers" className="border-t border-ink-line py-12">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <p className="eyebrow">Model providers</p>
          <button type="button" className="btn-ghost" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add provider
          </button>
        </div>

        {providers.data?.items.length === 0 ? (
          <EmptyState
            title="No providers yet."
            detail="Ollama runs locally and needs no key. Everything else needs an API key, which is encrypted at rest and never returned by the API."
          />
        ) : (
          <ul className="divide-y divide-ink-line border-y border-ink-line">
            {providers.data?.items.map((provider) => (
              <li key={provider.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
                <div className="min-w-0 flex-1">
                  <p className="text-base text-bone">{provider.label}</p>
                  <p className="mt-1 font-mono text-[11px] text-bone-faint">
                    {provider.provider}
                    {provider.hasKey ? ` · key ${provider.keyFingerprint}` : ' · no key'}
                    {provider.lastStatus ? ` · ${provider.lastStatus}` : ''}
                    {provider.lastCheckedAt ? ` · tested ${timeAgo(provider.lastCheckedAt)}` : ''}
                  </p>
                </div>
                <button type="button" className="btn-quiet" onClick={() => void test(provider.id)} disabled={testing === provider.id}>
                  {testing === provider.id ? <Spinner className="h-3.5 w-3.5" /> : <Plug className="h-3.5 w-3.5" aria-hidden />}
                  Test
                </button>
                <button
                  type="button"
                  className="btn-quiet hover:text-signal-fail"
                  aria-label={`Delete ${provider.label}`}
                  onClick={() => void removeProvider(provider.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
                {results[provider.id] && (
                  <p
                    className={`w-full font-mono text-[11px] ${results[provider.id]!.ok ? 'text-signal-live' : 'text-signal-fail'}`}
                  >
                    {results[provider.id]!.ok
                      ? `connected · ${results[provider.id]!.latencyMs}ms · ${results[provider.id]!.models} models`
                      : results[provider.id]!.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="accounts" className="border-t border-ink-line py-12">
        <p className="eyebrow mb-6">Accounts</p>
        {accounts.data?.items.length === 0 ? (
          <EmptyState title="No accounts connected." detail="Accounts are created from an agent, then managed here." />
        ) : (
          <ul className="divide-y divide-ink-line border-y border-ink-line">
            {accounts.data?.items.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-x-5 gap-y-1 py-4 text-left"
                  onClick={() => setOpenAccount(account.id)}
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-faint">{account.channel}</span>
                  <span className="text-base text-bone">@{account.handle}</span>
                  {!account.implemented && <span className="chip">adapter not implemented</span>}
                  <span className="ml-auto font-mono text-[11px] text-bone-faint">
                    {account.status.toLowerCase()} · checked {timeAgo(account.lastHealthCheckAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add a model provider">
        <div className="space-y-5">
          <Field label="Provider" htmlFor="pkind">
            <select id="pkind" className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.data?.items.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.kind}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label" htmlFor="plabel" hint="How you will refer to it when configuring an agent.">
            <input id="plabel" className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Anthropic production" />
          </Field>
          <Field label="Base URL" htmlFor="pbase" hint={selectedKind ? `Blank uses ${selectedKind.defaultBaseUrl || 'the provider default'}.` : undefined}>
            <input id="pbase" className="field" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={selectedKind?.defaultBaseUrl} />
          </Field>
          {selectedKind?.requiresApiKey && (
            <Field label="API key" htmlFor="pkey" hint="Encrypted with your master key before storage, and never returned by the API.">
              <input id="pkey" type="password" className="field" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
            </Field>
          )}
          {error && <p className="text-sm text-signal-fail">{error}</p>}
          <button type="button" className="btn-primary w-full" onClick={() => void addProvider()} disabled={busy}>
            {busy && <Spinner />}
            Add provider
          </button>
        </div>
      </Modal>

      <Modal open={Boolean(openAccount)} onClose={() => setOpenAccount(null)} title="Session" wide>
        {openAccount && <SessionPanel accountId={openAccount} onChanged={() => accounts.reload()} />}
      </Modal>
    </main>
  );
}
