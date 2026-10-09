import { describe, expect, it } from 'vitest';
import { FETCH_BAD_PORTS, freePort } from '@xbam/browser';

/**
 * Chrome's debug port is found with `fetch`, and `fetch` refuses the Fetch
 * standard's bad ports before sending a byte. Where Windows hands out ports
 * from 1024, a launch could draw one, start Chrome, and never find it.
 */
describe("Chrome's debug port", () => {
  it('is never one fetch refuses', async () => {
    const draws = [1720, 6000, 1721];
    expect(await freePort(async () => draws.shift()!)).toBe(1721);
  });

  it('gives up with a sentence rather than looping', async () => {
    await expect(freePort(async () => 1719)).rejects.toThrow(/fetch is willing to reach/);
  });

  it('names exactly the ports this runtime refuses', async () => {
    // Checked against the fetch that actually runs, not against the standard:
    // the refusal happens before any connection, so nothing needs to listen.
    for (const port of FETCH_BAD_PORTS) {
      const failure = await fetch(`http://127.0.0.1:${port}/`).then(
        () => 'answered',
        (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message ?? error),
      );
      expect(failure, String(port)).toMatch(/bad port/);
    }
  });

  it('draws real ports when left alone', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1023);
    expect(FETCH_BAD_PORTS.has(port)).toBe(false);
  });
});
