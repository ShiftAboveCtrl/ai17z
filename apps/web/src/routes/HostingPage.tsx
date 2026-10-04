import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Server } from 'lucide-react';
import { post } from '@app/lib/api';
import { usePolling, useResource } from '@app/lib/hooks';
import { EmptyState, RetryablePanel, Working } from '@app/components/ui';

/**
 * The operator's view of hosted runtimes.
 *
 * Deliberately not a customer screen and deliberately not a shop. Hosted mode
 * is in development, so this exists so the person running the installation can
 * see what is true: which tiers may hold a tenant and what the others would
 * have to prove, which hosts are reporting, and what has not been measured.
 *
 * The caveats are shown rather than hidden behind a link. An operator deciding
 * what to put on a hosted runtime is exactly the person who needs the
 * uncomfortable version, and a readiness screen that reads as green while
 * nothing has been booted is the kind of screen that gets believed.
 */

interface TierRow {
  tier: string;
  enabled: boolean;
  custody: string;
  stillRequired: string[];
}

interface Readiness {
  tiers: TierRow[];
  enabledTiers: string[];
  egressDenials: string[];
  provisioningSteps: { name: string; what: string }[];
  operatorCannotReach: string[];
  caveats: string[];
}

interface HostRow {
  id: string;
  label: string;
  state: string;
  region: string | null;
  agentVersion: string | null;
  keyThumbprint: string;
  enrolledAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  heartbeatAgeSec: number | null;
  reporting: boolean;
  reserved: { runtimes: number; browserRuntimes: number };
}

interface Hosts {
  staleAfterSec: number;
  hosts: HostRow[];
}

function StateMark({ host }: { host: HostRow }) {
  if (host.state === 'REVOKED') return <CircleSlash size={16} className="text-rose-400" aria-hidden />;
  if (host.state === 'PENDING_ENROLMENT') return <Clock size={16} className="text-amber-400" aria-hidden />;
  if (!host.reporting) return <AlertTriangle size={16} className="text-amber-400" aria-hidden />;
  return <CheckCircle2 size={16} className="text-emerald-400" aria-hidden />;
}

function describe(host: HostRow, staleAfterSec: number): string {
  if (host.state === 'PENDING_ENROLMENT') {
    return 'Offered itself and is waiting. A host is never trusted on arrival, so somebody has to enrol it.';
  }
  if (host.state === 'REVOKED') {
    return host.revokedReason
      ? `Revoked: ${host.revokedReason}. A revoked key is never re-enrolled.`
      : 'Revoked. A revoked key is never re-enrolled.';
  }
  if (host.heartbeatAgeSec === null) {
    return 'Enrolled and has never sent a heartbeat, which is not the same as having sent one saying nothing is wrong.';
  }
  if (!host.reporting) {
    return `Last heard from ${host.heartbeatAgeSec}s ago, past the ${staleAfterSec}s bound, so it is treated as not running whatever its last snapshot said. Its runtimes are unavailable, not reassigned.`;
  }
  return `Reporting, ${host.heartbeatAgeSec}s ago. Holding ${host.reserved.runtimes} runtime${host.reserved.runtimes === 1 ? '' : 's'}.`;
}

export function HostingPage() {
  const readiness = useResource<Readiness>('/api/hosting/readiness');
  const hosts = useResource<Hosts>('/api/hosting/hosts');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  usePolling(() => void hosts.reload(), 15_000, !hosts.loading);

  async function act(hostId: string, what: 'enrol' | 'drain'): Promise<void> {
    setBusy(hostId);
    setProblem(null);
    try {
      await post(`/api/hosting/hosts/${hostId}/${what}`);
      await hosts.reload();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Server size={20} aria-hidden /> Hosted runtimes
        </h1>
        <p className="text-sm text-slate-400 break-words">
          Running AI17Z somewhere an owner does not control. In development: nothing has been booted, provisioned or
          sold from this installation.
        </p>
      </header>

      {readiness.loading && !readiness.data ? <Working label="Reading what hosting can do here" seconds={0} /> : null}
      {readiness.error ? (
        <RetryablePanel
          title="Hosting readiness could not be read"
          detail={readiness.error}
          onRetry={readiness.reload}
        />
      ) : null}
      {readiness.data ? (
        <section className="space-y-6">
            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Who may hold a tenant</h2>
              <ul className="space-y-3">
                {readiness.data.tiers.map((tier) => (
                  <li key={tier.tier} className="rounded-lg border border-slate-800 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm break-words">{tier.tier}</span>
                      <span className={tier.enabled ? 'text-xs text-emerald-400' : 'text-xs text-slate-500'}>
                        {tier.enabled ? 'enabled' : 'not enabled'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400 break-words">Key custody: {tier.custody}</p>
                    {tier.stillRequired.length > 0 ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-400">
                        {tier.stillRequired.map((requirement) => (
                          <li key={requirement} className="break-words">
                            {requirement}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                What a tenant may never reach
              </h2>
              <p className="text-xs text-slate-400 break-words">
                Infrastructure rather than content. Firecracker filters no guest traffic, so these are enforced at the
                host.
              </p>
              <p className="font-mono text-xs text-slate-300 break-words">{readiness.data.egressDenials.join('  ')}</p>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                What an operator cannot reach
              </h2>
              <p className="text-xs text-slate-400 break-words">
                {readiness.data.operatorCannotReach.join(', ')}. Reaching into a tenant at all is break-glass, with a
                written reason and an expiry.
              </p>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Bringing one into existence</h2>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
                {readiness.data.provisioningSteps.map((step) => (
                  <li key={step.name} className="break-words">
                    <span className="font-mono text-slate-300">{step.name}</span> {step.what}
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-2 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                <AlertTriangle size={16} aria-hidden /> What this does not claim
              </h2>
              <ul className="list-disc space-y-1 pl-5 text-xs text-amber-100/80">
                {readiness.data.caveats.map((caveat) => (
                  <li key={caveat} className="break-words">
                    {caveat}
                  </li>
                ))}
              </ul>
            </div>
        </section>
      ) : null}

      {hosts.loading && !hosts.data ? <Working label="Reading the host list" seconds={0} /> : null}
      {hosts.error ? (
        <RetryablePanel title="The host list could not be read" detail={hosts.error} onRetry={hosts.reload} />
      ) : null}
      <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Hosts</h2>
          {problem ? <p className="text-sm text-rose-400 break-words">{problem}</p> : null}
          {hosts.data && hosts.data.hosts.length === 0 ? (
            <EmptyState
              title="No host has offered itself"
              detail="A host submits its public key and waits. It is never trusted on arrival, and there is no route that accepts a host's own claim to be approved."
            />
          ) : null}
          <ul className="space-y-3">
            {(hosts.data?.hosts ?? []).map((host) => (
              <li key={host.id} className="rounded-lg border border-slate-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium break-words">
                      <StateMark host={host} /> {host.label}
                    </p>
                    <p className="text-xs text-slate-400 break-words">
                      {describe(host, hosts.data?.staleAfterSec ?? 90)}
                    </p>
                    <p className="font-mono text-[11px] text-slate-500 break-words">
                      key {host.keyThumbprint}
                      {host.region ? ` · ${host.region}` : ''}
                      {host.agentVersion ? ` · ${host.agentVersion}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 space-x-2">
                    {host.state === 'PENDING_ENROLMENT' ? (
                      <button
                        type="button"
                        className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
                        disabled={busy === host.id}
                        onClick={() => void act(host.id, 'enrol')}
                      >
                        {busy === host.id ? 'Enrolling' : 'Enrol'}
                      </button>
                    ) : null}
                    {host.state === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="rounded border border-slate-700 px-2 py-1 text-xs hover:border-slate-500"
                        disabled={busy === host.id}
                        onClick={() => void act(host.id, 'drain')}
                      >
                        {busy === host.id ? 'Draining' : 'Drain'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500 break-words">
            There is no placement control here yet. Choosing a host needs what is already reserved on it in CPU, memory
            and disk, and nothing reports that: multiplying a count by an assumed class would produce refusals nobody
            could explain.
          </p>
      </section>
    </div>
  );
}

export default HostingPage;
