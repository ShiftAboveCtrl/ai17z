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
  const timer = setInterval(() => {
    tick().catch((error) => {
      log.error('a loop tick failed and was swallowed so the worker keeps running', {
        loop: name,
        message: errorMessage(error),
      });
    });
  }, intervalMs);

  // Never hold the process open on its own account. A worker with nothing left
  // to do should be able to exit.
  timer.unref?.();
  return timer;
}
