import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agents as agentsRepo,
  capabilityInvocations,
  jobs as jobsRepo,
  memories,
  observability,
} from '@xbam/database';
import { DEFAULT_POLICY } from '@xbam/shared/contracts';
import type { ChatMessage } from '@xbam/shared/contracts';
import { CALL_CLOSE, CALL_OPEN, TOOLPACKS, registerBuiltinCapabilities, resetCapabilitiesForTest } from '@xbam/tools';
import { safeFetch } from '@xbam/upstream';
import * as upstream from '@xbam/upstream';
import * as runtime from '@xbam/runtime';
import { capabilitySettings, ingestNormalizedEvent, runCapabilityLoop, setToolpack } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { drainAgentJobs } from '../support/runner';

installHarness();

/**
 * An agent with every pack switched off is still an agent.
 *
 * This is the release invariant, and it is here because the failure it guards
 * against is not a broken capability -- it is a working one somebody turned
 * off that took the agent down with it, or that kept calling its provider
 * anyway. Both are silent. An owner who never wanted any of this sees only
 * that their agent stopped replying, or sees a bill.
 *
 * The two halves are asserted separately and neither is inferred from the
 * other: what the agent still does, and what leaves the machine.
 */

/**
 * Everything the interface can offer, registered the way bootstrap does it.
 *
 * The upstreams as well as the capabilities, because several capabilities
 * report themselves unavailable when the family behind them has no members --
 * which is right, and would otherwise make this test prove that an unregistered
 * family is refused rather than that a switched-off pack is.
 */
function registerEverything(): void {
  resetCapabilitiesForTest();
  registerBuiltinCapabilities();
  // The upstream registry refuses a second registration of the same id, so it
  // is cleared first: this runs before every case and the registry is
  // process-wide.
  upstream.resetUpstreamsForTest();
  upstream.registerEvmUpstreams();
  upstream.registerContractUpstreams();
  upstream.registerMarketUpstreams();
  upstream.registerDefiUpstreams();
  upstream.registerTokenRiskUpstreams();
  upstream.registerSolanaUpstreams();
  upstream.registerBitcoinUpstreams();
  upstream.registerGovernanceUpstreams();
  upstream.registerIpfsUpstreams();
  upstream.registerReferenceUpstreams();
  upstream.registerSignatureUpstreams();
  upstream.registerGeckoUpstreams();
  upstream.registerWebHistoryUpstreams();
  upstream.registerFeedUpstreams();
  upstream.registerScholarUpstreams();
  upstream.registerEntityUpstreams();
  upstream.registerSecUpstreams();
  runtime.registerXCapabilities();
  runtime.registerChainCapabilities();
  runtime.registerContractCapabilities();
  runtime.registerDefiCapabilities();
  runtime.registerTokenRiskCapabilities();
  runtime.registerSolanaCapabilities();
  runtime.registerBitcoinCapabilities();
  runtime.registerGovernanceCapabilities();
  runtime.registerStorageCapabilities();
  runtime.registerReferenceCapabilities();
  runtime.registerMarketCapabilities();
  runtime.registerWebHistoryCapabilities();
  runtime.registerFeedCapabilities();
  runtime.registerScholarCapabilities();
  runtime.registerEntityCapabilities();
  runtime.registerSecCapabilities();
}

/**
 * Every outbound connection this process makes, recorded and refused.
 *
 * Deliberately at the socket rather than at `ask()` or at `safeFetch`. Both of
 * those are seams a future call site could go around without anybody noticing,
 * and the claim being made is not "no upstream family ran" -- it is that
 * nothing reached the network. A guard a new code path can bypass proves only
 * that today's code paths are the ones it knew about.
 *
 * The database is the one exception, recognised by address rather than by
 * name: the test database is on this machine, and anything that is not is a
 * provider.
 */
interface Egress {
  attempts: string[];
  restore(): void;
}

/**
 * The database host, read from the connection string rather than assumed.
 *
 * Both workflows use localhost today. Hard-coding that would make this file
 * fail on CI and nowhere else the day somebody points the suite at a service
 * container by name -- the exact shape of bug that costs a day, because the
 * failure would be every database call refused and would read as the guard
 * having found something.
 */
const DATABASE_HOST = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname.toLowerCase();
  } catch {
    return '';
  }
})();

function isLocal(host: string | undefined): boolean {
  if (!host) return true; // A unix socket or a named pipe: not a provider.
  const name = host.toLowerCase();
  if (DATABASE_HOST && name === DATABASE_HOST) return true;
  return name === 'localhost' || name === '::1' || name.startsWith('127.');
}

function watchEgress(): Egress {
  const attempts: string[] = [];
  const realNet = net.connect;
  const realTls = tls.connect;

  // `any` here rather than a typed shim: these are two overloaded Node
  // built-ins being replaced wholesale, and narrowing the wrapper would mean
  // reproducing both overload sets to say nothing new.
  const wrap = (real: any, label: string) =>
    function patched(this: unknown, ...args: any[]) {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
      const host: string | undefined = options.host ?? (typeof args[1] === 'string' ? args[1] : undefined);
      if (!isLocal(host)) {
        attempts.push(`${label} ${host}:${options.port ?? args[0]}`);
        throw new Error(`the egress guard refused a connection to ${host}`);
      }
      return real.apply(this, args) as unknown;
    };

  (net as any).connect = wrap(realNet, 'tcp');
  (tls as any).connect = wrap(realTls, 'tls');

  return {
    attempts,
    restore() {
      (net as any).connect = realNet;
      (tls as any).connect = realTls;
    },
  };
}

const call = (id: string, input: unknown) => `${CALL_OPEN}${JSON.stringify({ id, input })}${CALL_CLOSE}`;

async function everyPackOff(agentId: string): Promise<void> {
  for (const pack of TOOLPACKS) await setToolpack({ agentId, packId: pack.id, on: false });
}

/** What the loop would actually put in front of the model, for one real agent. */
async function menuFor(agentId: string): Promise<string> {
  const settings = await capabilitySettings(agentId);
  let menu = '';
  await runCapabilityLoop({
    agentId,
    jobId: null,
    accountId: null,
    messages: [{ role: 'user', content: 'say ok' } as ChatMessage],
    permissions: settings.permissions,
    configs: settings.configs,
    paused: false,
    generate: async (messages) => {
      menu = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      return 'ok';
    },
  });
  return menu;
}

/**
 * The loop is on, deliberately.
 *
 * With it off the agent could not call a capability whatever the switches
 * said, and the test would prove nothing about the switches.
 */
const LOOP_ON = { tools: { ...DEFAULT_POLICY.tools, capabilityLoop: true } };

let egress: Egress | null = null;

beforeEach(() => {
  registerEverything();
  egress = watchEgress();
});

afterEach(() => {
  egress?.restore();
  egress = null;
  resetCapabilitiesForTest();
});

describe('the egress guard itself', () => {
  /*
   * The anchor for every "nothing was called" assertion in this file.
   *
   * A guard that never fires and a system that never calls out look exactly
   * the same from the outside, and the second is what the other tests claim.
   * So one case proves the guard catches a real request made the way every
   * upstream in this codebase makes one -- through `safeFetch`, which is the
   * only network primitive in `packages/upstream`.
   *
   * An address literal rather than a hostname, deliberately: it needs no DNS,
   * so this proves the interception without depending on a resolver being
   * reachable from wherever the suite runs. Nothing reaches the wire either
   * way -- the guard refuses at connect, before the socket opens.
   */
  it('catches a real request and stops it', async () => {
    const stop = AbortSignal.timeout(5_000);
    await expect(safeFetch('https://1.1.1.1/', { signal: stop, maxBytes: 1_000 })).rejects.toThrow();
    expect(egress?.attempts).toEqual(['tls 1.1.1.1:443']);
    // Cleared so the tests after this one start from nothing.
    egress!.attempts.length = 0;
  });
});

describe('an agent with every Toolspace pack switched off', () => {
  it('still generates, remembers and acts, and reaches nothing doing it', async () => {
    const fixture = await createFixture({ policy: LOOP_ON });
    await everyPackOff(fixture.agentId);

    // Checked rather than assumed. If the override did not take, this case
    // would pass by never running the loop at all -- which is the one way it
    // could be green and prove nothing.
    const active = await agentsRepo.getActivePolicy(fixture.agentId);
    expect(active?.config.tools.capabilityLoop).toBe(true);

    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('What do you think about bitcoin?'),
    });
    expect(outcome.jobs).toHaveLength(1);

    await drainAgentJobs(fixture.agentId);

    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.lastError).toBeNull();
    expect(job.status).toBe('EXECUTED');
    expect(job.generatedOutput?.trim()).toBeTruthy();

    // Memory still works: both sides of the exchange were written.
    const stored = await memories.searchMemories({ agentId: fixture.agentId, scopes: ['THREAD'], limit: 20 });
    expect(stored.total).toBe(2);

    // The job ran the whole way through, so this is not a pipeline that
    // stopped somewhere before it could have called anything.
    const trace = (await observability.listTrace(job.id)).map((event) => event.type);
    expect(trace).toEqual(
      expect.arrayContaining(['MEMORY_SELECTED', 'MODEL_REQUEST_COMPLETED', 'VALIDATION_PASSED', 'ACTION_COMPLETED']),
    );

    // Nothing was invoked, and nothing left the machine.
    expect(await capabilityInvocations.listForAgent(fixture.agentId)).toEqual([]);
    expect(egress?.attempts).toEqual([]);
  });

  it('offers the model none of the capabilities in a pack that is off', async () => {
    const fixture = await createFixture({ policy: LOOP_ON });
    await everyPackOff(fixture.agentId);

    const menu = await menuFor(fixture.agentId);
    for (const prefix of ['web.', 'feed.', 'company.', 'research.', 'entity.', 'chain.', 'x.', 'contract.']) {
      expect(menu, `${prefix} is in a pack that is off and must not be offered`).not.toContain(prefix);
    }
    // And it is not empty for the wrong reason: the always-on built-ins are
    // still there, so the menu was rendered rather than skipped.
    expect(menu).toContain('time.now');
    expect(egress?.attempts).toEqual([]);
  });

  it('refuses a switched-off capability a model asks for anyway, without calling it', async () => {
    /*
     * The menu is not the guard, it is the saving of a wasted step.
     *
     * Leaving something off the menu stops a well-behaved model choosing it.
     * It does nothing about a model that names it regardless -- and a model
     * repeating a capability it saw in an earlier turn is ordinary, not
     * adversarial. So the permission is checked again at the invocation, and
     * this is the case that proves the second check is load-bearing rather
     * than a comment about one.
     */
    const fixture = await createFixture({ policy: LOOP_ON });
    await everyPackOff(fixture.agentId);

    const settings = await capabilitySettings(fixture.agentId);
    let turns = 0;
    const result = await runCapabilityLoop({
      agentId: fixture.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'what is Q42' } as ChatMessage],
      permissions: settings.permissions,
      configs: settings.configs,
      paused: false,
      generate: async () => {
        turns += 1;
        return turns === 1 ? call('entity.facts', { id: 'Q42', limit: 5 }) : 'I cannot look that up.';
      },
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.capabilityId).toBe('entity.facts');
    expect(result.steps[0]?.outcome).toBe('REFUSED');
    // Refused is not the same as never asked, and the owner can see both.
    const recorded = await capabilityInvocations.listForAgent(fixture.agentId);
    expect(recorded.map((row) => row.outcome)).toEqual(['REFUSED']);
    expect(egress?.attempts).toEqual([]);
  });
});

describe('turning one pack on and off again', () => {
  it('offers it, runs it, and then does not', async () => {
    const fixture = await createFixture({ policy: LOOP_ON });
    await everyPackOff(fixture.agentId);

    // --- on -----------------------------------------------------------------
    await setToolpack({ agentId: fixture.agentId, packId: 'reference', on: true });
    const onMenu = await menuFor(fixture.agentId);
    expect(onMenu).toContain('research.paper_lookup');
    // Only that pack. A pack switch reaching past its own prefixes would be a
    // bulk edit nobody asked for.
    expect(onMenu).not.toContain('web.history');
    expect(onMenu).not.toContain('company.filings');

    /*
     * The model chooses it, the implementation runs, and the answer comes
     * back. Deliberately an identifier that is not one: the capability refuses
     * that itself, before any source is asked, so this exercises the whole
     * chain -- offered, chosen, invoked, answered, recorded -- with nothing on
     * the wire. What the sources do when they are asked is proved by their own
     * tests and by the live canary each of them was adopted on.
     */
    const settings = await capabilitySettings(fixture.agentId);
    let turns = 0;
    const result = await runCapabilityLoop({
      agentId: fixture.agentId,
      jobId: null,
      accountId: null,
      messages: [{ role: 'user', content: 'look up a paper' } as ChatMessage],
      permissions: settings.permissions,
      configs: settings.configs,
      paused: false,
      generate: async () => {
        turns += 1;
        return turns === 1
          ? call('research.paper_lookup', { identifier: 'not-an-identifier' })
          : 'That is neither a DOI nor an arXiv id.';
      },
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.capabilityId).toBe('research.paper_lookup');
    expect(result.steps[0]?.outcome).toBe('SUCCEEDED');
    expect(egress?.attempts).toEqual([]);

    const recorded = await capabilityInvocations.listForAgent(fixture.agentId);
    expect(recorded.map((row) => row.capabilityId)).toEqual(['research.paper_lookup']);

    // --- off again ----------------------------------------------------------
    await setToolpack({ agentId: fixture.agentId, packId: 'reference', on: false });
    expect(await menuFor(fixture.agentId)).not.toContain('research.paper_lookup');

    // And the agent goes on working with it off.
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Still there?'),
    });
    await drainAgentJobs(fixture.agentId);
    const job = await jobsRepo.requireJob(outcome.jobs[0]!.job.id);
    expect(job.status).toBe('EXECUTED');
    expect(egress?.attempts).toEqual([]);
  });
});
