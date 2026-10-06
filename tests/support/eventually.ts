/**
 * Waiting for a side effect that was deliberately not awaited.
 *
 * Several places in this product start work and do not wait for it, for good
 * reasons: telling the owner about a lost session must not slow down the read
 * that noticed it, and a trace write must not hold a pipeline step open. A
 * test of one of those has to wait for something it cannot await.
 *
 * ### Why not a sleep
 *
 * `tests/support/barrier.ts` already wrote this lesson down for cross-process
 * synchronisation, in its own words: "no guess. Correct at any speed." It
 * exists because a guessed interval failed on Linux CI and reported "expected
 * 0 to be greater than 0", a sentence about a count that says nothing about
 * the cause.
 *
 * The same bug had survived in-process. `sessionExpiry.test.ts` waited a flat
 * 150 ms for a status write to land, which is plenty on a developer's machine
 * and not plenty on a loaded CI runner. It failed there reporting "expected
 * 'CONNECTED' to be 'SESSION_EXPIRED'", which reads exactly like the product
 * having stopped working.
 *
 * ### Both directions, because they are different problems
 *
 * Polling until something becomes true is right for a positive assertion and
 * wrong for a negative one: a value that has not changed yet looks identical
 * to a value that never will. So `stays` watches for the whole window and
 * fails the moment the value moves, which is both faster at catching the bug
 * and immune to a slow machine.
 */

/** How long a positive wait is given, and how often it looks. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `read` returns `want`, or fail saying what it kept returning.
 *
 * The timeout is generous on purpose. It costs nothing when the effect lands
 * quickly, which is every ordinary run, and it is the difference between a
 * suite that is trustworthy on a busy machine and one that is not.
 */
export async function becomes<T>(
  read: () => Promise<T>,
  want: T,
  { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS, what = 'the value' } = {},
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T | undefined;
  let looks = 0;
  for (;;) {
    last = await read();
    looks += 1;
    if (last === want) return last;
    if (Date.now() >= until) {
      throw new Error(
        `${what} was still ${JSON.stringify(last)} after ${timeoutMs}ms and ${looks} looks, rather than ${JSON.stringify(want)}.`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Assert `read` keeps returning `want` for the whole window.
 *
 * For proving a side effect did **not** happen. It fails the moment the value
 * moves, naming what it moved to, rather than sleeping and checking once at
 * the end: a single check at the end cannot tell "it never changed" from "it
 * changed and changed back".
 */
export async function stays<T>(
  read: () => Promise<T>,
  want: T,
  { forMs = 750, intervalMs = DEFAULT_INTERVAL_MS, what = 'the value' } = {},
): Promise<void> {
  const until = Date.now() + forMs;
  let looks = 0;
  for (;;) {
    const now = await read();
    looks += 1;
    if (now !== want) {
      throw new Error(`${what} became ${JSON.stringify(now)} after ${looks} look(s), and should have stayed ${JSON.stringify(want)}.`);
    }
    if (Date.now() >= until) return;
    await sleep(intervalMs);
  }
}
