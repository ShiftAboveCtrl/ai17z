import { useEffect, useState } from 'react';
import { Plug, Plus, Trash2 } from 'lucide-react';
import { ApiError, del, get, post } from '@app/lib/api';
import { useElapsed, useResource } from '@app/lib/hooks';
import { useSession } from '@app/lib/session';
import type { AccountRow, HealthReportView, ProviderCredential, ProviderKindInfo } from '@app/lib/types';
import { timeAgo } from '@app/lib/format';
import { AnimatedText, FadeIn } from '@app/components/motion';
import { EmptyState, ErrorPanel, Field, Modal, Spinner, StatusDot } from '@app/components/ui';
import { Explain } from '@app/components/Explain';
import { SessionPanel } from '@app/components/SessionPanel';
import { TelegramPanel } from '@app/components/TelegramPanel';

const HEALTH_TONE = { healthy: 'live', degraded: 'wait', offline: 'fail', unknown: 'idle' } as const;

interface ProviderVerdict {
  state: 'NOT_CONFIGURED' | 'TESTING' | 'CONNECTED' | 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'NO_MODEL_LIST' | 'MODEL_UNAVAILABLE';
  detail: string;
  fix: string | null;
  models: string[];
  transient: boolean;
}

/** Colour by what it means, not by pass and fail. */
const TONE: Record<ProviderVerdict['state'], string> = {
  CONNECTED: 'text-signal-live',
  NO_MODEL_LIST: 'text-bone-dim',
  TESTING: 'text-bone-dim',
  NOT_CONFIGURED: 'text-bone-faint',
  // Not the owner's mistake, and it clears on its own.
  RATE_LIMITED: 'text-signal-wait',
  UNAVAILABLE: 'text-signal-wait',
  INVALID_CREDENTIALS: 'text-signal-fail',
  MODEL_UNAVAILABLE: 'text-signal-fail',
};

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
  const [results, setResults] = useState<
    Record<string, { ok: boolean; detail: string; latencyMs: number; models: number; verdict?: ProviderVerdict }>
  >({});
  const [openAccount, setOpenAccount] = useState<string | null>(null);

  const testElapsed = useElapsed(Boolean(testing));

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
    <main className="mx-auto max-w-page px-6 pb-24 pt-24 sm:px-10 sm:pt-28">
      <header className="mb-16">
        <FadeIn>
          <p className="eyebrow mb-2">{user?.email}</p>
        </FadeIn>
        <AnimatedText as="h1" text="Settings" className="monument text-[12vw] leading-[0.95] sm:text-[4.4vw] lg:text-[3.2rem]" />
        <Explain label="this page" className="mt-3">
          <p><strong>The things that belong to this installation rather than to one agent.</strong> Your AI provider keys, the accounts you have connected, and how you get told when something needs you.</p>
          <p>Provider keys are encrypted before they are stored and are never shown again, not even here. If you lose the encryption key, the keys have to be entered again.</p>
        </Explain>
      </header>

      <section id="system" className="border-t border-ink-line py-12">
        <p className="eyebrow mb-2">System</p>
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

      <BrowserDiagnostics />

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
                  {testing === provider.id ? `Testing ${testElapsed}s` : 'Test'}
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
                  <div className="w-full">
                    {/*
                      One word for every failure was the problem. A rejected key,
                      an outage, a rate limit and a retired model need different
                      things done, and only one of them is the owner's fault.
                    */}
                    <p className={`font-mono text-[11px] ${TONE[results[provider.id]!.verdict?.state ?? (results[provider.id]!.ok ? 'CONNECTED' : 'UNAVAILABLE')]}`}>
                      {(results[provider.id]!.verdict?.state ?? (results[provider.id]!.ok ? 'CONNECTED' : 'UNAVAILABLE'))
                        .toLowerCase()
                        .replace(/_/g, ' ')}
                      {results[provider.id]!.ok ? ` · ${results[provider.id]!.latencyMs}ms` : ''}
                    </p>
                    <p className="mt-1 text-[12px] text-bone-dim">
                      {results[provider.id]!.verdict?.detail ?? results[provider.id]!.detail}
                    </p>
                    {results[provider.id]!.verdict?.fix && (
                      <p className="mt-1 text-[12px] text-bone-faint">{results[provider.id]!.verdict!.fix}</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="accounts" className="border-t border-ink-line py-12">
        <p className="eyebrow mb-2">Accounts</p>
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

      <section id="notifications" className="border-t border-ink-line py-12">
        <p className="eyebrow mb-2">Telling you about it</p>
        <TelegramPanel />
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

interface PreflightCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

interface PreflightReport {
  ok: boolean;
  platform: string;
  playwrightVersion: string | null;
  checks: PreflightCheck[];
  availableChannels: string[];
}

const CHECK_TONE = { ok: 'live', warn: 'wait', fail: 'fail' } as const;

/**
 * Answers "can this installation drive a browser" before an owner finds out
 * halfway through connecting an account. The work runs in a browser-capable
 * worker, so this follows the task rather than blocking the request.
 */
function BrowserDiagnostics() {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setReport(null);
    setElapsed(0);
    try {
      const task = await post<{ id: string }>('/api/browser/preflight', {});
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200));
        const current = await get<{ status: string; result: PreflightReport | null; error: string | null }>(
          `/api/browser-tasks/${task.id}`,
        );
        if (current.status === 'COMPLETED') {
          setReport(current.result);
          return;
        }
        if (current.status === 'FAILED') {
          setError(current.error ?? 'The preflight failed.');
          return;
        }
      }
      setError('The preflight did not finish within two minutes. Is a browser-capable worker running?');
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'The preflight could not be started. A worker with AI17Z_WORKER_ROLE=browser or all must be running.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="browser" className="border-t border-ink-line py-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <p className="eyebrow">Browser runtime</p>
        <button type="button" className="btn-ghost" onClick={() => void run()} disabled={busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {busy ? `Checking… ${elapsed}s` : 'Run browser preflight'}
        </button>
      </div>

      {error && <ErrorPanel title="The preflight could not run." detail={error} />}

      {report && (
        <>
          <ul className="divide-y divide-ink-line border-y border-ink-line">
            {report.checks.map((check) => (
              <li key={check.name} className="flex flex-wrap items-center gap-x-5 gap-y-1 py-3.5">
                <StatusDot state={CHECK_TONE[check.status]} />
                <span className="text-sm text-bone">{check.name}</span>
                <span className="ml-auto max-w-[34rem] break-all text-right font-mono text-[11px] text-bone-faint">
                  {check.detail}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 font-mono text-[11px] text-bone-faint">
            {report.platform} · playwright {report.playwrightVersion ?? 'unknown'} · usable browsers:{' '}
            {report.availableChannels.join(', ') || 'none'}
          </p>
        </>
      )}

      {!report && !error && !busy && (
        <p className="text-sm leading-relaxed text-bone-dim">
          Checks Playwright, the bundled Chromium, real Chrome and Edge, the profile directory, and whether a browser
          actually opens. Run it before connecting an account.
        </p>
      )}
    </section>
  );
}
