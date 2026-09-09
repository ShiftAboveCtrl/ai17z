/**
 * What to say when no worker is running, in one place.
 *
 * Four screens described this situation and each wrote its own sentence. The
 * agent page said "no work is being done at all", Health said "jobs will queue
 * and nothing will run them", the Telegram notification said to run
 * `npm run dev:worker` -- a developer command an installed copy has no way to
 * run -- and only the preflight had the advice somebody could actually follow.
 *
 * Two things have to be said and only one of them usually was:
 *
 *   - **whose problem it is.** Nothing running is AI17Z itself being down, not
 *     this agent being misconfigured. Somebody reading it on an agent page will
 *     otherwise go looking for the setting they got wrong.
 *   - **how to get out of it**, in a command this installation can run.
 *
 * The containerised worker gets its own answer because the two look identical
 * from outside and only one of them is confusing: that worker polls, ingests
 * and logs, so somebody watching it work is told nothing is running and
 * reasonably concludes the message is wrong. It is not -- a container has no
 * display, so it runs with AI17Z_WORKER_ROLE=jobs and the browser work is left
 * to a second worker on this machine.
 */

/** How to start one, in the words of whatever this copy of AI17Z is. */
export const START_A_WORKER =
  'Start AI17Z from its desktop icon, or run .\\start-ai17z.ps1. In a checkout, npm run dev:worker.';

/** No worker at all. Nothing reads, replies or posts. */
export function noWorkerRunning(seconds: number): { what: string; fix: string } {
  return {
    what: `Nothing has checked in for ${seconds} seconds, so no agent is reading, replying or posting. This is AI17Z itself rather than anything about this agent.`,
    fix: START_A_WORKER,
  };
}

/** A worker is running, but it is the one in Docker, which has no browser. */
export function noBrowserWorker(): { what: string; fix: string } {
  return {
    what: 'A worker is running, but it is the one inside Docker, which has no browser.',
    fix: 'Chrome is driven by a second worker that runs on this machine. Start AI17Z from its desktop icon, or run .\\start-ai17z.ps1, and it starts one.',
  };
}

/** The one-sentence form, for a status line that has room for one. */
export function workerAbsenceSentence(seconds: number): string {
  const { what, fix } = noWorkerRunning(seconds);
  return `${what} ${fix}`;
}
