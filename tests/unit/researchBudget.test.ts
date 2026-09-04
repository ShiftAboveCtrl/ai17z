import { describe, expect, it } from 'vitest';
import { research } from '@xbam/runtime';

const lookup = (query: string) => ({ kind: 'search' as const, query, reason: 'because' });
const never = () => new Promise<never>(() => {});

/**
 * Measured on a real agent: when research runs at all it averages ten minutes
 * and has taken two hours, while writing the reply takes five seconds. Nobody
 * is served by an answer that arrives an hour after the question.
 *
 * A lookup that could not finish is already something this system reports
 * honestly, so the model says it could not check -- which is a better answer
 * than a late one and a far better answer than an invented one.
 */
describe('research is bounded', () => {
  it('gives up on a search that never returns', async () => {
    const started = Date.now();
    const result = await research([lookup('what happened today')], { search: never, budgetMs: 300 });

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.findings).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/too long/i);
  });

  it('reports the gap rather than pretending it looked', async () => {
    const result = await research([lookup('anything')], { search: never, budgetMs: 200 });
    // The note is what the trace shows and what the prompt is built from.
    expect(result.note).toMatch(/could not/i);
  });

  it('spends the budget across lookups instead of per lookup', async () => {
    // Three lookups with a one-minute budget each is a three-minute wait
    // wearing a one-minute label.
    const started = Date.now();
    const result = await research([lookup('a'), lookup('b'), lookup('c')], { search: never, budgetMs: 400 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.failed).toHaveLength(3);
  });

  it('keeps what came back before the budget ran out', async () => {
    let call = 0;
    const search = async (query: string) => {
      call += 1;
      if (call === 1) {
        return [
          {
            kind: 'search' as const,
            query,
            source: 'Web search',
            title: 'Found',
            summary: 'Something real.',
            url: 'https://example.com/a',
            retrievedAt: new Date().toISOString(),
          },
        ];
      }
      return never();
    };

    const result = await research([lookup('first'), lookup('second')], { search, budgetMs: 600 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('Found');
    expect(result.failed).toHaveLength(1);
  });

  it('does nothing at all when there is nothing to look up', async () => {
    // The fast path, measured at zero seconds on the real agent and worth
    // keeping there: an ordinary reply must not touch any of this.
    const started = Date.now();
    const result = await research([], { search: never });
    expect(Date.now() - started).toBeLessThan(50);
    expect(result.note).toMatch(/nothing/i);
  });
});
