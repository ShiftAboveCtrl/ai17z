import { describe, expect, it, vi } from 'vitest';

/**
 * A plan abandoned at its deadline is cancelled, not left running.
 *
 * Measured on a live installation: a research plan the reply stopped waiting
 * for at 3.5 seconds went on for 8.5, and the provider billed all of it for a
 * plan nobody read.
 */

const seen: { signal: AbortSignal | undefined } = { signal: undefined };

vi.mock('@xbam/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xbam/models')>();
  return {
    ...actual,
    resolveTargets: async () => [{ provider: 'mock', model: 'slow' }],
    generate: (request: { signal?: AbortSignal }) => {
      seen.signal = request.signal;
      // A provider that never answers on its own.
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
});

describe('the research plan deadline', () => {
  it('cancels the provider request and falls back to the rules', async () => {
    const { planLookups } = await import('@xbam/runtime');
    const plan = await planLookups('agent', null, {
      incoming: 'what happened with the Robinhood Chain launch today?',
      parent: 'Robinhood Chain mainnet went live',
      hasMedia: false,
      links: [],
      deterministic: [{ kind: 'search', query: 'Robinhood Chain mainnet launch' }],
      timeoutMs: 50,
    } as never);

    expect(plan.decidedBy).toBe('rules');
    expect(plan.fellBackBecause).toMatch(/longer than 50ms/);
    expect(seen.signal?.aborted).toBe(true);
  });
});
