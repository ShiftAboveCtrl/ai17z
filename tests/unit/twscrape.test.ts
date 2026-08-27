import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPersonaSourceAdapter } from '@xbam/persona';

/**
 * The adapter is tested against a stand-in CLI rather than the real twscrape,
 * because the real one needs X credentials in its own account pool and the
 * interesting cases are the ones where it reports something misleading.
 */
const STUB = resolve(process.cwd(), 'tests/support/fake-twscrape/twscrape.js');
const adapter = getPersonaSourceAdapter('x_public');

function useStub(mode: 'ok' | 'no_accounts' = 'ok'): void {
  // A full command line, which is also how somebody reaches twscrape inside a
  // virtualenv. Quoting covers a path with spaces.
  process.env.AI17Z_TWSCRAPE_COMMAND = `"${process.execPath}" "${STUB}"`;
  process.env.FAKE_TWSCRAPE_MODE = mode;
}

afterEach(() => {
  delete process.env.AI17Z_TWSCRAPE_COMMAND;
  delete process.env.FAKE_TWSCRAPE_MODE;
});

describe('reporting whether twscrape can actually be used', () => {
  it('says it is missing when the command is not there', async () => {
    process.env.AI17Z_TWSCRAPE_COMMAND = 'definitely-not-a-real-command-ai17z';
    const availability = await adapter.availability();
    expect(availability.available).toBe(false);
    expect(availability.detail).toMatch(/not on PATH/i);
    expect(availability.requirement).toMatch(/pip install twscrape/i);
  });
});

describe('reading a public corpus', () => {
  it('resolves the handle to a numeric id before asking for a timeline', async () => {
    // The stub fails loudly if it is handed a handle where an id belongs, which
    // is the bug this exists to catch: the real CLI silently returns nothing.
    useStub('ok');
    const items = await adapter.fetch({ handle: '@someone', limit: 50 });
    expect(items.length).toBeGreaterThan(0);
  });

  it('classifies posts, replies and quotes', async () => {
    useStub('ok');
    const items = await adapter.fetch({ handle: 'someone', limit: 50 });
    const kinds = items.map((i) => i.itemKind);
    expect(kinds).toContain('post');
    expect(kinds).toContain('reply');
    expect(kinds).toContain('quote');
  });

  it('drops entries with no text rather than storing empty evidence', async () => {
    useStub('ok');
    const items = await adapter.fetch({ handle: 'someone', limit: 50 });
    expect(items.every((i) => i.text.trim().length > 0)).toBe(true);
  });

  it('ignores twscrape log lines mixed into the output', async () => {
    useStub('ok');
    const items = await adapter.fetch({ handle: 'someone', limit: 50 });
    expect(items.every((i) => i.remoteId.length > 0)).toBe(true);
  });

  it('can leave quotes out when asked', async () => {
    useStub('ok');
    const items = await adapter.fetch({ handle: 'someone', limit: 50, includeQuotes: false });
    expect(items.some((i) => i.itemKind === 'quote')).toBe(false);
  });

  it('stops at the cursor so a resync does not re-read everything', async () => {
    useStub('ok');
    const items = await adapter.fetch({ handle: 'someone', limit: 50, since: '2' });
    expect(items.map((i) => i.remoteId)).toEqual(['1']);
  });

  it('keeps the raw record, because provenance is the point', async () => {
    useStub('ok');
    const items = await adapter.fetch({ handle: 'someone', limit: 50 });
    expect(items[0]!.raw).toBeTruthy();
  });
});

describe('an empty account pool is not a missing user', () => {
  it('explains the real cause rather than repeating "Not Found"', async () => {
    useStub('no_accounts');
    await expect(adapter.fetch({ handle: 'someone', limit: 10 })).rejects.toThrow(/no X account to read with/i);
  });

  it('does not blame the handle for a credentials problem', async () => {
    useStub('no_accounts');
    await expect(adapter.fetch({ handle: 'someone', limit: 10 })).rejects.not.toThrow(/could not find @someone/i);
  });
});
