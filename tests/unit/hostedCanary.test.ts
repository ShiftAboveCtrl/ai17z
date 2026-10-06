/**
 * The canary renderer, which must never report having done anything.
 *
 * `tools/hosted-canary.mts` exists so that "blocked on confidential hardware"
 * stops being a sentence and becomes a command somebody can read: it renders
 * every request the canary would send and names the exact credential each
 * provider is missing. The danger with a tool like that is the one the whole
 * subsystem is arranged against, which is output that reads like a result.
 *
 * So these cases are mostly about what it must not say. The tool is run as a
 * subprocess because it is a script that reports and exits.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

interface CanaryReport {
  provisioned: boolean;
  blockedBy: string | null;
  providers: {
    provider: string;
    ready: boolean;
    missing: { name: string; how: string }[];
    mayHold: boolean;
    provision: { method?: string; path?: string; monthlyUsd?: number; refused?: string };
    policy: { binds?: string; refused?: string };
    live: { operation: string; method: string; path: string }[];
  }[];
  wouldProve: string[];
  wouldNotProve: string[];
  steps: string[];
  caveats: string[];
}

/** The report, read from stdout whether or not the exit code is zero. */
function canary(): { report: CanaryReport; exitCode: number } {
  let stdout: string;
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, ['--import', 'tsx', 'tools/hosted-canary.mts', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    stdout = String(failure.stdout ?? '');
    exitCode = failure.status ?? 1;
    expect(stdout, `the canary produced no report: ${String(failure.stderr ?? error)}`).not.toBe('');
  }
  return { report: JSON.parse(stdout) as CanaryReport, exitCode };
}

const { report, exitCode } = canary();

describe('the canary renderer never reports having run a canary', () => {
  it('says nothing was provisioned, and exits non-zero while it is blocked', () => {
    expect(report.provisioned).toBe(false);
    expect(report.blockedBy).toBe('CLOUD_CREDENTIAL_OR_BUDGET');
    // A zero exit on a blocked canary is how a blocked item becomes a passing
    // one in somebody's script.
    expect(exitCode).not.toBe(0);
  });

  it('refuses to let any provider hold a tenant, because none has been proved', () => {
    expect(report.providers.length).toBeGreaterThan(0);
    for (const provider of report.providers) {
      expect(provider.mayHold, `${provider.provider} may hold a tenant`).toBe(false);
    }
  });

  it('shows every live operation as a call that would be made and never one that was', () => {
    for (const provider of report.providers) {
      expect(provider.live.length).toBeGreaterThan(0);
      for (const operation of provider.live) {
        expect(operation.method).not.toBe('');
        expect(operation.path).not.toBe('');
      }
    }
  });
});

describe('what it is missing is named rather than counted', () => {
  it('names a credential per provider, each with where it comes from', () => {
    for (const provider of report.providers.filter((p) => !p.ready)) {
      expect(provider.missing.length, `${provider.provider} is not ready and named nothing`).toBeGreaterThan(0);
      for (const missing of provider.missing) {
        expect(missing.name).not.toBe('');
        // "needs credentials" is not actionable, so each one says where it
        // comes from.
        expect(missing.how.length, `${missing.name} has no sentence saying where it comes from`).toBeGreaterThan(20);
      }
    }
  });

  it('renders a request for a provider whose sizes are priced, and refuses for one whose are not', () => {
    const azure = report.providers.find((p) => p.provider === 'AZURE');
    expect(azure, 'no Azure in the report').toBeDefined();
    // Azure has priced sizes, so the request has to render: a tool that could
    // not render it would not have reduced the remaining work to configuration.
    expect(azure!.provision.path, 'the Azure request did not render').toBeTruthy();
    expect(azure!.provision.monthlyUsd).toBeGreaterThan(0);

    const google = report.providers.find((p) => p.provider === 'GOOGLE_CLOUD');
    expect(google, 'no Google in the report').toBeDefined();
    // Google's all-in price needs a billing credential, so it refuses rather
    // than quoting a number from memory.
    expect(google!.provision.refused, 'Google rendered a request despite having no priced size').toBeTruthy();
  });

  it('reports what a key release policy binds, which is the distinction the provider choice turns on', () => {
    const azure = report.providers.find((p) => p.provider === 'AZURE');
    // PLATFORM_ONLY is the honest answer for Azure's secure key release as this
    // adapter renders it, and the tool must not round it up to the stronger one.
    expect(azure!.policy.binds).toBe('PLATFORM_ONLY');
  });
});

describe('it says what a canary would not prove', () => {
  it('carries both lists, and the second one refuses the host-operator claim', () => {
    expect(report.wouldProve.length).toBeGreaterThan(0);
    expect(report.wouldNotProve.length).toBeGreaterThan(0);
    const notProved = report.wouldNotProve.join(' ');
    expect(notProved).toMatch(/host operator/i);
    expect(notProved).toMatch(/availability is not confidentiality/i);
  });

  it('keeps the standing caveats, including that no provider is enabled', () => {
    expect(report.caveats.join(' ')).toMatch(/CONFIDENTIAL_PROVIDERS_ENABLED is empty/);
  });

  it('gives the canary as ordered steps, starting with the credential', () => {
    expect(report.steps.length).toBeGreaterThanOrEqual(5);
    expect(report.steps[0]).toMatch(/credential/i);
    // The barrier is what decides whether the canary moved anything, so the
    // last step has to be re-running it rather than declaring a result.
    expect(report.steps[report.steps.length - 1]).toMatch(/phase1:barrier/);
  });
});
