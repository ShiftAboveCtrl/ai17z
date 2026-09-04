import { createLogger, envBool, envInt, envString, errorMessage, loadEnv } from '@xbam/shared';
import { closePool, migrate, pingDatabase } from '@xbam/database';
import { bootstrapRuntime } from '@xbam/runtime';
import { buildServer } from './server';

loadEnv();
const log = createLogger('api');

async function main(): Promise<void> {
  const ping = await pingDatabase();
  if (!ping.ok) {
    throw new Error(
      `Database is not reachable: ${ping.detail}. Start it with "npm run db:up" and check DATABASE_URL.`,
    );
  }

  // In Docker the API owns migrations so a fresh stack comes up ready to use.
  if (envBool('AI17Z_RUN_MIGRATIONS', false)) {
    const result = await migrate();
    log.info('migrations checked', { applied: result.applied.length });
  }
  await bootstrapRuntime();

  const app = await buildServer();
  const port = envInt('AI17Z_API_PORT', 8787);
  const host = envString('AI17Z_API_HOST', '0.0.0.0');
  await app.listen({ port, host });
  log.info('api listening', { url: `http://localhost:${port}` });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    await app.close().catch((e) => log.warn('server close failed', { message: errorMessage(e) }));
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  log.error('api failed to start', { message: errorMessage(error) });
  await closePool().catch(() => undefined);
  process.exit(1);
});
