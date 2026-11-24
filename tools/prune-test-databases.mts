#!/usr/bin/env node
import { closePool } from '@xbam/database';
import { pruneTestDatabases } from '../tests/support/db';

try {
  await pruneTestDatabases();
  process.stdout.write('Abandoned integration databases pruned.\n');
} finally {
  await closePool();
}
