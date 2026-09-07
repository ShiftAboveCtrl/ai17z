/**
 * Is a worker that can drive a browser serving *this* installation?
 *
 * Exits 0 for yes, 1 for no, 2 if the question could not be asked. For the
 * launcher, which cannot import TypeScript and must not guess.
 *
 * The launcher used to answer this from a pid file: read the number, ask
 * Windows whether a process with that id exists, and call it running. Three
 * things wrong with that, all of which happened at once on a machine with two
 * installations:
 *
 *   - the recorded pid is the `cmd.exe` that npm runs, not the worker. The
 *     worker can be gone while the wrapper lives on
 *   - pids are reused, so an unrelated process answers to the number
 *   - and a pid says nothing about *which installation* the worker serves.
 *     Two copies sharing a program directory made that unanswerable
 *
 * The result was a launcher announcing "native worker already running" while
 * the interface, looking at the same installation's database, said nothing was
 * there that could open a browser. Both were reading real signals; only one of
 * them was reading the right one.
 *
 * The heartbeat is the right one. It is per-installation by construction --
 * each writes to its own database -- and it is exactly what
 * `browserWorkerPresent` answers for the interface, so the launcher and the
 * screen can no longer disagree.
 */
import { closePool, workers as workersRepo } from '@xbam/database';
import { loadEnv } from '@xbam/shared';

loadEnv();

try {
  const present = await workersRepo.browserWorkerPresent();
  process.exitCode = present ? 0 : 1;
} catch {
  // Unreachable database, wrong port, a stack still starting. Not knowing is
  // not the same as knowing there is none, and the caller is told so: starting
  // a second worker because the database was briefly unreachable is worse than
  // leaving one out.
  process.exitCode = 2;
} finally {
  await closePool().catch(() => undefined);
}
