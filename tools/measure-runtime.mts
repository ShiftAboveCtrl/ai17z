#!/usr/bin/env tsx
/**
 * Measures what an AI17Z runtime actually needs, so a plan can be priced
 * against a number rather than against a feeling.
 *
 * The confidential floor is two vCPUs and eight gigabytes, because that is the
 * smallest confidential VM either provider sells. So the useful question is
 * not "will AI17Z fit in a VM" but "how many of one owner's agents fit in that
 * floor", and the only honest way to answer it is to run the thing and watch.
 *
 * What it measures, per scenario: resident memory of every AI17Z process, the
 * database's own size, and how those move as agents are added. What it does
 * not measure is anything it did not run, and the report says which is which.
 *
 *   npx tsx tools/measure-runtime.mts                     every scenario it can
 *   npx tsx tools/measure-runtime.mts --scenario idle
 *   npx tsx tools/measure-runtime.mts --json
 *
 * It reads. It starts no browser, calls no model and sends nothing: a
 * measurement harness that spent money to produce a number would be a bad
 * trade for a number that moves with somebody's API bill.
 */
import { execFileSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { query } from '@xbam/database';
import { HOURS_PER_MONTH, SMALLEST_CONFIDENTIAL_VCPUS } from '@xbam/shared';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const only = ((): string | undefined => {
  const at = argv.indexOf('--scenario');
  return at >= 0 ? argv[at + 1] : undefined;
})();

interface Reading {
  what: string;
  /** Null where it could not be measured, which is never reported as zero. */
  value: number | null;
  unit: string;
  how: string;
}

const readings: Reading[] = [];
const record = (what: string, value: number | null, unit: string, how: string): void =>
  void readings.push({ what, value, unit, how });

/**
 * Resident memory of the AI17Z processes, from the operating system.
 *
 * `ps` on a Unix host, `Get-CimInstance` on Windows. Measured rather than
 * asked of the process itself, because a process reporting its own heap is not
 * reporting what a hypervisor has to allocate for it.
 */
function processMemoryMb(): {
  total: number | null;
  processes: { name: string; rssMb: number; production: boolean }[];
} {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
      const raw = JSON.parse(out) as unknown;
      const rows = (Array.isArray(raw) ? raw : [raw]) as { WorkingSetSize: number; CommandLine?: string }[];
      // Only this project's processes. Somebody else's node is not AI17Z.
      const mine = rows.filter((r) => (r.CommandLine ?? '').includes('XBAM') || (r.CommandLine ?? '').includes('ai17z'));
      const processes = mine.map((r) => ({
        ...label(r.CommandLine ?? 'node'),
        rssMb: Math.round(r.WorkingSetSize / (1024 * 1024)),
      }));
      // Only what a production runtime would have. See `label`.
      return { total: processes.filter((p) => p.production).reduce((n, p) => n + p.rssMb, 0), processes };
    }
    const out = execFileSync('ps', ['-eo', 'rss,args'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const processes = out
      .split('\n')
      .slice(1)
      .filter((line) => /tsx|apps\/(api|worker)|ai17z/i.test(line) && !/measure-runtime/.test(line))
      .map((line) => {
        const [rss, ...rest] = line.trim().split(/\s+/);
        return { ...label(rest.join(' ')), rssMb: Math.round(Number(rss) / 1024) };
      })
      .filter((p) => Number.isFinite(p.rssMb));
    return { total: processes.filter((p) => p.production).reduce((n, p) => n + p.rssMb, 0), processes };
  } catch {
    return { total: null, processes: [] };
  }
}

/**
 * A short name for a process, and whether a production runtime would have it.
 *
 * `tsx watch` supervisors exist only in development, and there are two of them
 * at about 70 MB each. Pricing a confidential VM against a figure that
 * includes them overstates what a tenant needs by some 140 MB, which is the
 * sort of error that then sets a plan price.
 */
function label(commandLine: string): { name: string; production: boolean } {
  const watcher = /cli\.mjs["']?\s+watch/.test(commandLine);
  if (/apps[/\\]worker/.test(commandLine)) return { name: watcher ? 'worker watcher' : 'worker', production: !watcher };
  if (/apps[/\\]api/.test(commandLine)) return { name: watcher ? 'api watcher' : 'api', production: !watcher };
  if (/vite|apps[/\\]web/.test(commandLine)) return { name: 'web', production: false };
  if (/vitest/.test(commandLine)) return { name: 'vitest', production: false };
  if (/preflight\.cjs/.test(commandLine)) {
    /*
      tsx launches the real process through its preflight shim, so this command
      line names the shim rather than the app it is running. It is still the
      app: the watcher above is the parent, and this is the thing doing the
      work, which is what a production runtime runs directly.
    */
    return { name: 'runtime', production: true };
  }
  return { name: 'node', production: false };
}

async function measureDatabase(): Promise<void> {
  try {
    const [size] = await query<{ bytes: string; name: string }>(
      'SELECT pg_database_size(current_database())::text AS bytes, current_database() AS name',
    );
    record(
      'Database on disk',
      size ? Math.round(Number(size.bytes) / (1024 * 1024)) : null,
      'MB',
      `pg_database_size on ${size?.name ?? 'the current database'}`,
    );

    const [counts] = await query<{ agents: string; memories: string; events: string; jobs: string; actions: string }>(
      `SELECT (SELECT count(*) FROM agents)::text AS agents,
              (SELECT count(*) FROM memories)::text AS memories,
              (SELECT count(*) FROM events)::text AS events,
              (SELECT count(*) FROM jobs)::text AS jobs,
              (SELECT count(*) FROM actions)::text AS actions`,
    );
    if (counts) {
      record('Agents', Number(counts.agents), 'rows', 'a count, so the size above has something to be a size of');
      record('Memories', Number(counts.memories), 'rows', 'a count');
      record('Events', Number(counts.events), 'rows', 'a count');
      record('Jobs', Number(counts.jobs), 'rows', 'a count');
      record('Actions', Number(counts.actions), 'rows', 'a count');
    }

    /*
      Per-agent cost is the number that decides how many agents share a
      runtime, and it is only meaningful once there is more than one agent to
      divide by. Reported as absent rather than as a guess otherwise.
    */
    const agents = Number(counts?.agents ?? 0);
    const dbMb = size ? Number(size.bytes) / (1024 * 1024) : null;
    if (agents > 0 && dbMb !== null) {
      record('Database per agent', Math.round((dbMb / agents) * 10) / 10, 'MB', `${dbMb.toFixed(0)}MB across ${agents} agents`);
    } else {
      record('Database per agent', null, 'MB', 'there are no agents on this installation to divide by');
    }
  } catch (error) {
    record('Database on disk', null, 'MB', `the database could not be read: ${(error as Error).message.split('\n')[0]}`);
  }
}

function measureProcesses(): void {
  const { total, processes } = processMemoryMb();
  const live = processes.filter((p) => p.production);
  const dev = processes.filter((p) => !p.production);
  record(
    'AI17Z resident memory',
    total,
    'MB',
    processes.length === 0
      ? 'no AI17Z process was running'
      : live.map((p) => `${p.name} ${p.rssMb}MB`).join(', ') +
        (dev.length > 0 ? `; left out as development only: ${dev.map((p) => `${p.name} ${p.rssMb}MB`).join(', ')}` : ''),
  );
  if (live.length === 0) {
    record(
      'Runtime memory while working',
      null,
      'MB',
      'nothing was running, so this is unmeasured rather than small. Start the api and worker and run this again.',
    );
  }
}

function measureMachine(): void {
  record('This machine', Math.round(totalmem() / (1024 * 1024)), 'MB', 'totalmem, for context on what the figures above are a fraction of');
  record(
    'Confidential floor',
    SMALLEST_CONFIDENTIAL_VCPUS,
    'vCPU',
    'the smallest confidential VM either provider sells, which is what a tenant costs whether it needs it or not',
  );
}

function report(): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), readings }, null, 2)}\n`);
    return;
  }
  const width = Math.max(...readings.map((r) => r.what.length));
  process.stdout.write('\nWhat an AI17Z runtime needs, measured on this machine\n\n');
  for (const r of readings) {
    const value = r.value === null ? 'not measured' : `${r.value} ${r.unit}`;
    process.stdout.write(`  ${r.what.padEnd(width)}  ${value}\n`);
    process.stdout.write(`  ${' '.repeat(width)}  ${r.how}\n\n`);
  }
  const unmeasured = readings.filter((r) => r.value === null).length;
  process.stdout.write(
    unmeasured > 0
      ? `${unmeasured} reading(s) could not be taken. Absent is not zero, and a plan priced from this would be priced from a gap.\n\n`
      : `Every reading was taken. ${HOURS_PER_MONTH} hours is the month these are priced against.\n\n`,
  );
}

async function main(): Promise<void> {
  if (!only || only === 'machine') measureMachine();
  if (!only || only === 'processes' || only === 'idle') measureProcesses();
  if (!only || only === 'database') await measureDatabase();
  report();
  process.exit(0);
}

void main();
