import type { Server } from 'node:net';
import { FETCH_BAD_PORTS } from '@xbam/browser';

/**
 * Listens on a loopback port that `fetch` is willing to reach.
 *
 * Port 0 takes whatever the operating system hands out, and on Windows that
 * range can start at 1024. The Fetch standard refuses its bad ports before
 * sending anything, so a test server that lands on 1719 or 1720 binds cleanly
 * and every request to it fails, which reads as the code under test failing,
 * intermittently and in a different test each run.
 */
export async function listenReachable(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('The test server did not get a port.');
    if (!FETCH_BAD_PORTS.has(address.port)) return address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('No loopback port fetch would reach, after ten tries.');
}
