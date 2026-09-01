import { describe, expect, it, vi } from 'vitest';
import { startLoop } from '../../apps/worker/src/loop';

/**
 * A loop tick that fails must not end the worker.
 *
 * This is not a hypothetical tidy-up. Restarting Postgres killed the native
 * worker outright: the browser-task loop asked for a task, the connection was
 * gone, and the throw escaped a `try/finally` that had no `catch`. Written as
 * `setInterval(() => void this.tick(), ms)`, that becomes an unhandled
 * rejection, and an unhandled rejection ends the process in current Node.
 *
 * What made it dangerous was how it looked from outside. The `tsx` supervisor
 * stayed alive, so the count of worker processes was still one and the log
 * simply stopped. X monitoring had stopped with it, silently, and stayed
 * stopped until somebody noticed the tab health had gone stale.
 */
describe('a worker loop', () => {
  it('keeps running after a tick rejects', async () => {
    let calls = 0;
    const timer = startLoop('test', 10, async () => {
      calls += 1;
      throw new Error('the database went away');
    });

    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);

    // Several ticks, every one of them failing, and we are still here.
    expect(calls).toBeGreaterThan(1);
  });

  it('does not leave an unhandled rejection behind', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const timer = startLoop('test', 10, async () => {
      throw new Error('still gone');
    });
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('keeps calling after a tick that throws synchronously', async () => {
    let calls = 0;
    const timer = startLoop('test', 10, () => {
      calls += 1;
      // Not every failure is a rejected promise; some are thrown before the
      // first await ever happens.
      throw new Error('synchronous');
    });
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);

    expect(calls).toBeGreaterThan(1);
  });

  it('goes on running when a tick succeeds again', async () => {
    let calls = 0;
    const timer = startLoop('test', 10, async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
    });
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(timer);

    // Recovery is the point: a database that comes back must find the loop
    // still turning.
    expect(calls).toBeGreaterThan(3);
  });
});
