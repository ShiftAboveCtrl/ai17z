import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_CLOSE,
  CALL_OPEN,
  defineCapability,
  invokeCapability,
  listModelCallable,
  parseTurn,
  registerCapability,
  resetCapabilitiesForTest,
  resolvePermission,
} from '@xbam/tools';
import { createLogger } from '@xbam/shared';

/**
 * The loop that lets a model choose, and every guard that makes that safe.
 *
 * AI17Z spent its whole life so far with no tool loop, deliberately: a control
 * nothing calls is worse than no control, so the one tool whose purpose was to
 * be called was removed rather than left switched on. Adding the loop is
 * therefore adding the thing that was refused until it could be done properly,
 * and "properly" is this file: unregistered cannot run, not-model-callable
 * cannot run, a wrong argument never reaches an implementation, the owner's
 * answer is obeyed, PAUSE ALL outranks it, and a result that does not match its
 * own declared shape is a failure rather than a surprise elsewhere.
 */

const logger = createLogger('test');

const context = {
  agentId: 'agent-1',
  jobId: null,
  accountId: null,
  config: {},
  logger,
};

const allowed = { stored: null, paused: false };

function echo(id: string, overrides: Partial<Parameters<typeof defineCapability>[0]> = {}) {
  return defineCapability({
    id,
    name: 'Echo',
    description: 'Returns what it was given.',
    category: 'READ' as const,
    effect: 'READ' as const,
    risk: 'LOW' as const,
    input: z.object({ word: z.string().min(1) }),
    output: z.object({ word: z.string() }),
    modelCallable: true,
    timeoutMs: 1_000,
    async run(input: { word: string }) {
      return { word: input.word };
    },
    ...(overrides as object),
  });
}

beforeEach(() => resetCapabilitiesForTest());
afterEach(() => resetCapabilitiesForTest());

describe('the protocol a model writes a call in', () => {
  it('reads a call', () => {
    const turn = parseTurn(`${CALL_OPEN}\n{"id":"a.b","input":{"word":"hi"}}\n${CALL_CLOSE}`);
    expect(turn.kind).toBe('call');
    if (turn.kind === 'call') expect(turn.call.id).toBe('a.b');
  });

  it('treats text with no tag as the answer', () => {
    expect(parseTurn('  Just words.  ')).toEqual({ kind: 'answer', text: 'Just words.' });
  });

  it('does not mistake quoted JSON in an answer for a call', () => {
    // An agent that talks about software quotes JSON all day. Without the tag
    // this is indistinguishable from a call, which is the whole reason for it.
    const turn = parseTurn('The payload looks like {"id":"x.read_post","input":{}} in the logs.');
    expect(turn.kind).toBe('answer');
  });

  it('says what was wrong rather than guessing', () => {
    expect(parseTurn(`${CALL_OPEN}not json${CALL_CLOSE}`).kind).toBe('malformed');
    expect(parseTurn(`${CALL_OPEN}{"input":{}}${CALL_CLOSE}`).kind).toBe('malformed');
    expect(parseTurn(`${CALL_OPEN}{"id":"a.b"}`).kind).toBe('malformed');
  });
});

describe('what may be registered', () => {
  it('refuses an id that is not family.verb_noun', () => {
    expect(() => registerCapability(echo('nofamily'))).toThrow(/family/);
    expect(() => registerCapability(echo('Bad.Case'))).toThrow(/family/);
  });

  it('refuses a second implementation of one id', () => {
    registerCapability(echo('test.echo'));
    expect(() => registerCapability(echo('test.echo'))).toThrow(/already registered/);
  });

  it('offers only what is model-callable', () => {
    registerCapability(echo('test.echo'));
    registerCapability(echo('test.internal', { modelCallable: false }));
    expect(listModelCallable().map((c) => c.id)).toEqual(['test.echo']);
  });
});

describe('what may run', () => {
  it('refuses a capability that does not exist', async () => {
    const result = await invokeCapability({
      call: { id: 'test.invented', input: {} },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.detail).toContain('no capability');
  });

  it('refuses one the model is not allowed to choose', async () => {
    registerCapability(echo('test.internal', { modelCallable: false }));
    const result = await invokeCapability({
      call: { id: 'test.internal', input: { word: 'hi' } },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('REFUSED');
  });

  it('never hands a bad argument to an implementation', async () => {
    const run = vi.fn();
    registerCapability(echo('test.echo', { run }));
    const result = await invokeCapability({
      call: { id: 'test.echo', input: { word: 42 } },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('REFUSED');
    expect(result.detail).toContain('word');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one that is allowed, and returns its validated output', async () => {
    registerCapability(echo('test.echo'));
    const result = await invokeCapability({
      call: { id: 'test.echo', input: { word: 'hello' } },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.output).toEqual({ word: 'hello' });
  });

  it('fails a result that does not match the capability’s own shape', async () => {
    // The output schema is not decoration: something downstream is about to
    // read this, and a shape nobody declared is a shape nobody can consume.
    registerCapability(echo('test.echo', { async run() { return { wrong: true }; } }));
    const result = await invokeCapability({
      call: { id: 'test.echo', input: { word: 'hi' } },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('FAILED');
    expect(result.detail).toContain('result shape');
  });

  it('abandons one that ignores the signal, which is the only kind that matters', async () => {
    // The first version aborted the signal and then awaited `run`, which bounds
    // nothing: a capability that never looks at the signal keeps going and the
    // job holding it waits for ever. Found by pointing a browser read at a real
    // page -- the signal fired, Playwright never looked at it, and the whole
    // thing sat there. The timeout has to win on its own.
    registerCapability(
      echo('test.deaf', {
        timeoutMs: 20,
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          return { word: 'eventually' };
        },
      }),
    );
    const started = Date.now();
    const result = await invokeCapability({
      call: { id: 'test.deaf', input: { word: 'hi' } },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('TIMED_OUT');
    // Returned on the timeout rather than when the work finished.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('abandons one that runs too long', async () => {
    registerCapability(
      echo('test.slow', {
        timeoutMs: 20,
        async run(_input: unknown, ctx: { signal: AbortSignal }) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          });
          return { word: 'never' };
        },
      }),
    );
    const result = await invokeCapability({
      call: { id: 'test.slow', input: { word: 'hi' } },
      context,
      permission: allowed,
    });
    expect(result.outcome).toBe('TIMED_OUT');
  });
});

describe('the owner’s answer', () => {
  const capability = echo('test.echo');

  it('allows a low-risk read nobody has configured', () => {
    const decision = resolvePermission({ capability, stored: null, paused: false });
    expect(decision.allowed).toBe(true);
  });

  it('does not allow a write nobody has configured', () => {
    // The default that matters. An agent that looks things up unasked is
    // useful; one that publishes unasked is a decision somebody makes.
    const write = echo('test.write', { effect: 'WRITE', risk: 'HIGH' });
    const decision = resolvePermission({ capability: write, stored: null, paused: false });
    expect(decision.allowed).toBe(false);
    expect(decision.permission).toBe('DISABLED');
  });

  it('obeys a switch that is off', () => {
    const decision = resolvePermission({ capability, stored: 'DISABLED', paused: false });
    expect(decision.allowed).toBe(false);
    expect(decision.why).toContain('switched off');
  });

  it('holds one that needs approval until it has it', () => {
    const held = resolvePermission({ capability, stored: 'OWNER_APPROVAL', paused: false });
    expect(held.allowed).toBe(false);
    expect(held.needsApproval).toBe(true);

    const approved = resolvePermission({ capability, stored: 'OWNER_APPROVAL', paused: false, approved: true });
    expect(approved.allowed).toBe(true);
  });

  it('lets PAUSE ALL outrank everything, and says so', () => {
    const decision = resolvePermission({ capability, stored: 'ALLOWED', paused: true });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('BLOCKED');
    expect(decision.why).toContain('paused');
  });

  it('blames the reason it cannot run before the switch it is not using', () => {
    // An owner told "you have not enabled this" about something that could not
    // have worked anyway learns the wrong thing.
    const decision = resolvePermission({
      capability,
      stored: 'DISABLED',
      paused: false,
      readiness: { status: 'UNAVAILABLE', why: 'No browser is running.' },
    });
    expect(decision.status).toBe('UNAVAILABLE');
    expect(decision.why).toContain('browser');
  });
});

describe('whether the loop runs at all', () => {
  it('is off until an owner turns it on', async () => {
    // Low-risk reads are already permitted for every agent, so a loop that ran
    // by default would change how every existing agent answers the moment it
    // shipped. Generation is exactly what it was until somebody decides.
    const { DEFAULT_POLICY } = await import('@xbam/shared/contracts');
    expect(DEFAULT_POLICY.tools.capabilityLoop).toBe(false);
  });

  it('is reachable from a screen, like every other enforced setting', async () => {
    // A runtime-enforced setting an owner cannot find is the defect the
    // reachability registry exists for.
    const { POLICY_REACHABILITY } = await import('@xbam/shared/contracts');
    expect(POLICY_REACHABILITY['tools.capabilityLoop']?.where).toBe('ADVANCED_ONLY');
  });
});
