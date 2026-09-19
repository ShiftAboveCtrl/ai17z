import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resetPressureHold } from '@xbam/shared';
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

  it('does not leave an uncaught exception behind either', async () => {
    // Counting ticks is not enough to prove this one, and for a while that was
    // the whole test. `setInterval` keeps firing after its callback throws, so
    // the count went up while the exception escaped to the process -- reported
    // by the test runner as an unhandled error, and fatal in the worker. The
    // assertion has to be about what got out, not about what carried on.
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);

    const timer = startLoop('test', 10, () => {
      throw new Error('thrown before any promise exists');
    });
    await new Promise((r) => setTimeout(r, 80));
    clearInterval(timer);
    process.off('uncaughtException', uncaught);

    expect(uncaught).not.toHaveBeenCalled();
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

/**
 * What an agent gives up before it stops answering people.
 *
 * Memory pressure used to be a boolean that said "pause background work",
 * which nothing read: the health row claimed everything speculative had
 * stopped while only job concurrency had moved. An ordering is enforceable,
 * and this is where it is enforced.
 */
describe('what a loop gives up under memory pressure', () => {
  const tick = async () => {
    /* counted by the caller */
  };

  const countTicks = async (priority: 'ESSENTIAL' | 'STANDARD' | 'OPTIONAL', pressure: 'NORMAL' | 'PRESSURED' | 'CRITICAL') => {
    resetPressureHold(pressure);
    let calls = 0;
    const timer = startLoop(
      'test',
      5,
      async () => {
        calls += 1;
        await tick();
      },
      priority,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    clearInterval(timer);
    return calls;
  };

  it('never stops the work somebody is waiting on', async () => {
    // Mentions arriving, the owner's own commands, recovering a job a dead
    // worker left. An agent that stops noticing people to save memory has
    // stopped being an agent.
    for (const pressure of ['NORMAL', 'PRESSURED', 'CRITICAL'] as const) {
      expect(await countTicks('ESSENTIAL', pressure)).toBeGreaterThan(0);
    }
  });

  it('drops the speculative work first', async () => {
    expect(await countTicks('OPTIONAL', 'NORMAL')).toBeGreaterThan(0);
    // Watching a repository is the thing nobody misses for ten minutes.
    expect(await countTicks('OPTIONAL', 'PRESSURED')).toBe(0);
    expect(await countTicks('OPTIONAL', 'CRITICAL')).toBe(0);
  });

  it('keeps the agent thinking until things are critical', async () => {
    expect(await countTicks('STANDARD', 'NORMAL')).toBeGreaterThan(0);
    expect(await countTicks('STANDARD', 'PRESSURED')).toBeGreaterThan(0);
    expect(await countTicks('STANDARD', 'CRITICAL')).toBe(0);
  });

  it('resumes when the pressure clears', async () => {
    expect(await countTicks('OPTIONAL', 'CRITICAL')).toBe(0);
    expect(await countTicks('OPTIONAL', 'NORMAL')).toBeGreaterThan(0);
  });
});

/**
 * Work that needs a browser is only started where there is one.
 *
 * Every engagement kind there is is an action on X, driven through the real
 * signed-in Chrome a given worker process may or may not have. The loop was
 * started unconditionally, so a jobs-only worker claimed proposals it could
 * never perform. Measured on a live installation inside a single minute: three
 * permanent failures reading "Google Chrome could not be found" from the
 * container worker, beside two successes from the native one, on the same
 * account.
 *
 * The cost is not the noise in the action ledger. `claimDue` moves the attempt
 * forward in the statement that selects the row, so a worker with no browser
 * spends the three attempts a proposal gets and something a browser-capable
 * worker was about to do is given up on instead.
 *
 * Read from the source because the loop is created inside the worker's own
 * startup, and starting that needs a database, a browser and a process to own
 * them. What matters is the gate, and the gate is here.
 */
describe('the engagement loop', () => {
  const main = readFileSync(resolve(__dirname, '../../apps/worker/src/main.ts'), 'utf8');

  it('is only started by a worker that can drive a browser', () => {
    const start = main.indexOf("startLoop('engagement'");
    expect(start, 'the engagement loop should still exist').toBeGreaterThan(0);
    // The gate sits immediately before it, the same shape the tab reporter uses.
    const before = main.slice(Math.max(0, start - 200), start);
    expect(before).toMatch(/capabilities\.browserCapable/);
  });

  it('still clears its timer on shutdown now that it can be absent', () => {
    expect(main).toMatch(/if \(engagement\) clearInterval\(engagement\)/);
  });
});
