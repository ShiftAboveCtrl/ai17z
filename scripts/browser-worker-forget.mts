/**
 * Forgets this installation's browser worker, after the launcher has killed it.
 *
 * The worker says goodbye when it exits on its own. Stopping kills its process
 * tree instead, so its heartbeat stayed fresh for up to ninety seconds, and an
 * update that stops and starts again inside that window asked "is a native
 * worker present?", heard yes, and started none. Measured on an installation:
 * updated, reported ready, and running no worker able to open its Chrome.
 *
 * Run only after the kill, so it can never forget a worker that is alive.
 * Exits 0 on success and 2 if the database could not be asked; the caller
 * treats either as done, because stopping must always be able to finish.
 */
import { closePool, workers as workersRepo } from '@xbam/database';
import { loadEnv } from '@xbam/shared';

loadEnv();

try {
  await workersRepo.forgetBrowserWorkers();
  process.exitCode = 0;
} catch {
  // A database already stopped has no heartbeat to be misread. Said by exit
  // code, not by a thrown error, so stopping still finishes.
  process.exitCode = 2;
} finally {
  await closePool().catch(() => undefined);
}
