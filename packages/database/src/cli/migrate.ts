import { loadEnv, createLogger } from '@xbam/shared';
import { appliedMigrations, describeTarget, loadMigrations, migrate } from '../migrator';
import { closePool } from '../pool';

const log = createLogger('migrate-cli');

async function main() {
  loadEnv();
  const command = process.argv[2] ?? 'up';

  // Named before anything happens, and named again in the summary. Which
  // database this is about is the one thing the operator cannot infer from the
  // output, and it is the one that matters.
  const target = describeTarget();
  process.stdout.write(`Database: ${target}
`);

  if (command === 'status') {
    const files = loadMigrations();
    const applied = new Map((await appliedMigrations()).map((m) => [m.name, m]));
    for (const file of files) {
      const row = applied.get(file.name);
      const state = !row ? 'PENDING' : row.checksum === file.checksum ? 'applied' : 'DRIFTED';
      process.stdout.write(`${state.padEnd(8)} ${file.name}\n`);
    }
    return;
  }

  const result = await migrate();
  log.info('migrations complete', {
    target,
    applied: result.applied.length,
    skipped: result.skipped.length,
    drifted: result.drifted,
  });
  if (result.applied.length === 0) process.stdout.write('Database is already up to date.\n');
  else process.stdout.write(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}\n`);
  if (result.drifted.length > 0) {
    process.stderr.write(`WARNING: these applied migrations were edited afterwards: ${result.drifted.join(', ')}\n`);
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
