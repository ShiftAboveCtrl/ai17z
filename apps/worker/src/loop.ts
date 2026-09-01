import { createLogger, errorMessage } from '@xbam/shared';

const log = createLogger('loop');

/**
 * A repeating loop that cannot take the process down.
 *
 * `setInterval(() => void this.tick(), ms)` reads as fire-and-forget and is
 * not: `void` discards the promise, it does not handle its rejection, and an
 * unhandled rejection ends the process in current Node.
 *
 * That is not theoretical. Restarting Postgres killed the native worker outright
 * -- the browser-task loop asked for a task, the connection was gone, the throw
 * escaped a `try/finally` with no `catch`, and the process died. The `tsx`
 * supervisor stayed up, so nothing looked wrong: the count of worker processes
 * was still one. What actually happened was that X monitoring stopped, silently,
 * and stayed stopped.
 *
 * A loop failing a tick is ordinary -- the database blinked, the browser was
 * busy, a page timed out. It is a thing to log and try again on the next tick.
 * It is never a thing to exit for. Individual loops still catch what they can
 * handle usefully; this is the floor under all of them.
 */
export function startLoop(name: string, intervalMs: number, tick: () => Promise<void>): NodeJS.Timeout {
  const swallow = (error: unknown): void => {
    log.error('a loop tick failed and was swallowed so the worker keeps running', {
      loop: name,
      message: errorMessage(error),
    });
  };

  const timer = setInterval(() => {
    // Two ways to fail, and only one of them is a rejected promise. A tick that
    // throws before it returns -- reading a property of something that is
    // suddenly undefined, a synchronous validate at the top -- never produces a
    // promise to attach `catch` to. That throw leaves the timer callback as an
    // uncaught exception, which ends the process just as surely as the
    // unhandled rejection this function was written to stop.
    //
    // It looked handled for a while: `setInterval` keeps firing after a callback
    // throws, so a test that only counts ticks passes while the guarantee is
    // broken. Under a test runner the exception is caught and reported; in the
    // worker it is fatal.
    try {
      const running = tick();
      // Defended rather than assumed: the signature says Promise, and the whole
      // point here is what happens when a caller does something the signature
      // did not expect.
      if (running && typeof running.catch === 'function') running.catch(swallow);
    } catch (error) {
      swallow(error);
    }
  }, intervalMs);

  // Never hold the process open on its own account. A worker with nothing left
  // to do should be able to exit.
  timer.unref?.();
  return timer;
}
