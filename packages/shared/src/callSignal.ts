import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The signal belonging to whatever invocation is currently running.
 *
 * ### Why this is ambient rather than a parameter
 *
 * A capability is given an `AbortSignal` and eventually causes an HTTP request,
 * but the path between them runs through a family's read helper, `ask`, the
 * quota coordinator and the concurrency gauge -- and there are eleven such
 * helpers with several different shapes. Threading a parameter through all of
 * them would be a wide mechanical change that every new family could then
 * forget to repeat, and forgetting would be silent: the capability would still
 * work, it would just stop being cancellable.
 *
 * So the signal travels with the execution instead. `AsyncLocalStorage` is
 * exactly this: a value scoped to a call and everything it awaits, without the
 * call sites having to know. One place sets it -- the invoker -- and one place
 * reads it -- `ask` -- and every family present and future gets cancellation
 * without doing anything.
 *
 * ### What it is not
 *
 * Not a general context object, and deliberately not extensible into one. It
 * carries a signal and nothing else, because ambient state is easy to abuse and
 * a capability that could reach the runtime through here would be the second
 * control plane the capability contract exists to prevent.
 *
 * An explicit signal always wins over this one, so a caller that knows better
 * can say so.
 */

const storage = new AsyncLocalStorage<AbortSignal>();

/** Runs `work` with `signal` visible to everything it awaits. */
export function withCallSignal<T>(signal: AbortSignal, work: () => T): T {
  return storage.run(signal, work);
}

/** The signal of the invocation currently running, if there is one. */
export function currentCallSignal(): AbortSignal | undefined {
  return storage.getStore();
}
