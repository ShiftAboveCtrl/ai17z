import { closePool, users } from '@xbam/database';
import { createLogger, envString, errorMessage, loadEnv } from '@xbam/shared';
import { bootstrapRuntime } from '@xbam/runtime';
import { importAi4cz, type ImportReport } from './import';

const log = createLogger('import-ai4cz');

function arg(name: string): string | undefined {
  const prefixed = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefixed));
  return match?.slice(prefixed.length);
}

function render(report: ImportReport): string {
  const lines = [
    '',
    'AI4CZ IMPORT',
    '',
    `${report.styleMemories} style memories imported`,
    `${report.conversationTurns} conversation turns imported`,
    `${report.conversationsCreated} conversations linked`,
    `${report.eventArchiveMemories} archived inbound records imported`,
    `${report.historicalEvents} historical events normalised`,
    `${report.seenMentionLedger} already-seen mentions recorded`,
    `${report.postedSignatures} historical action signatures recognised`,
    '',
    `${report.malformedSkipped} malformed records skipped`,
    '',
    `${report.secretsImported} secrets imported`,
    '',
  ];
  if (report.credentialLocations.length > 0) {
    lines.push('CREDENTIALS FOUND IN THE LEGACY PROJECT (not imported, rotate these):');
    for (const path of report.credentialLocations) lines.push(`  ai4cz/${path}`);
    lines.push('');
  }
  for (const note of report.notes) lines.push(note);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  loadEnv();
  const legacyDir = arg('legacy-dir') ?? envString('AI4CZ_LEGACY_DIR', '');
  if (!legacyDir) {
    throw new Error('Set AI4CZ_LEGACY_DIR in .env, or pass --legacy-dir=<path>.');
  }
  const dryRun = process.argv.includes('--dry-run');

  const owners = await users.listUsers();
  const email = arg('owner-email');
  const owner = email ? owners.find((u) => u.email.toLowerCase() === email.toLowerCase()) : owners[0];
  if (!owner) {
    throw new Error(
      owners.length === 0
        ? 'No owner account exists yet. Open XBAM and create one first.'
        : `No owner matches ${email}. Known owners: ${owners.map((u) => u.email).join(', ')}`,
    );
  }

  if (!dryRun) await bootstrapRuntime();
  const report = await importAi4cz({ legacyDir, ownerId: owner.id, dryRun });
  process.stdout.write(render(report));
  if (report.agentId) process.stdout.write(`Agent: ${report.agentId}\n\n`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    log.error('import failed', { message: errorMessage(error) });
    await closePool().catch(() => undefined);
    process.exit(1);
  });
