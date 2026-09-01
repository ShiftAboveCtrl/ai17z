/**
 * Watches a running AI17Z and writes down what it finds.
 *
 * This exists because "it worked while I was looking at it" is not evidence.
 * The failures that matter over a day are not the ones that throw -- they are
 * memory that only goes up, tabs that accumulate one per restart, a queue that
 * grows a little faster than it drains, a browser that reports healthy from a
 * snapshot taken an hour ago. None of those show up in a test run that lasts
 * four minutes.
 *
 * It changes nothing. It reads process tables, the database and the browser's
 * own health rows, on a fixed cadence, and flags a trend rather than a number:
 * 900MB is fine, 900MB that was 300MB six hours ago is not.
 *
 *   npm run soak                 # default: 24 hours, sampled every minute
 *   npm run soak -- --hours 2    # shorter
 *   npm run soak -- --minutes 20 --interval 30
 *
 * Leave it running. It writes a JSON line per sample to
 * storage/soak/<started>.jsonl and a report to storage/soak/<started>.json when
 * it stops, and it prints a line per sample so you can watch it.
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { query, closePool } from '@xbam/database';

const run = promisify(execFile);

interface Sample {
  at: string;
  elapsedMinutes: number;
  /**
   * Resident set size in MB. `chrome` is every Chrome on the machine, not just
   * AI17Z's: separating them means reading two thousand command lines, which
   * takes longer than the sampling interval. It is recorded as context and
   * never flagged, because it moves with whatever the owner is browsing.
   */
  memory: { worker: number; chromeAllOnMachine: number; chromeProcessesAllOnMachine: number };
  /** Targets open in AI17Z's own browsers, asked over CDP. This one is ours. */
  ourTabs: { total: number; byAccount: { handle: string; targets: number }[] };
  db: { connections: number; idleInTransaction: number; longestSeconds: number };
  queue: { unsettled: number; retryable: number; review: number; failedPermanent: number };
  work: { events: number; jobs: number; actions: number; realActions: number };
  browser: { accounts: number; tabs: number; staleSnapshots: number; roles: string[] };
  errors: { last15min: number; distinct: string[] };
}

interface Flag {
  what: string;
  detail: string;
}

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resident memory by process, in MB. Windows and POSIX ask differently. */
async function memory(): Promise<Sample['memory']> {
  const empty = { worker: 0, chromeAllOnMachine: 0, chromeProcessesAllOnMachine: 0 };
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Name node,chrome -ErrorAction SilentlyContinue | ` +
            `ForEach-Object { "$($_.ProcessName)|$($_.WorkingSet64)|$($_.Id)" }`,
        ],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      let node = 0;
      let chrome = 0;
      let chromeCount = 0;
      for (const line of stdout.split(/\r?\n/)) {
        const [name, bytes] = line.split('|');
        if (!name || !bytes) continue;
        const mb = Number(bytes) / (1024 * 1024);
        if (name === 'chrome') {
          chrome += mb;
          chromeCount += 1;
        } else {
          node += mb;
        }
      }
      // Node processes are not separable by name on Windows without reading
      // every command line, which is far too slow to do every minute. The
      // total is what matters for a trend.
      return {
        worker: Math.round(node),
        chromeAllOnMachine: Math.round(chrome),
        chromeProcessesAllOnMachine: chromeCount,
      };
    }

    const { stdout } = await run('ps', ['-eo', 'comm=,rss='], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    let node = 0;
    let chrome = 0;
    let chromeCount = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const [name, rss] = line.trim().split(/\s+/);
      if (!name || !rss) continue;
      const mb = Number(rss) / 1024;
      if (name.toLowerCase().includes('chrome')) {
        chrome += mb;
        chromeCount += 1;
      } else if (name.includes('node')) {
        node += mb;
      }
    }
    return {
      worker: Math.round(node),
      chromeAllOnMachine: Math.round(chrome),
      chromeProcessesAllOnMachine: chromeCount,
    };
  } catch {
    return empty;
  }
}

/**
 * How many targets AI17Z's own browsers are holding open.
 *
 * This is the measurement that matters and the cheap one: a single HTTP call
 * per account against the debugging port it recorded. It is also the failure
 * with history -- a predecessor leaked one tab per poll and reached 253, at
 * which point the account looked broken for a reason nothing reported. Four
 * roles means four tabs; a number that climbs all day is the bug.
 */
async function ourTabs(): Promise<Sample['ourTabs']> {
  const { readFile } = await import('node:fs/promises');
  const accounts = await query<{ id: string; handle: string }>(
    `SELECT id, handle FROM accounts WHERE channel <> 'mock' AND status = 'CONNECTED'`,
  ).catch(() => []);

  const byAccount: { handle: string; targets: number }[] = [];
  for (const account of accounts) {
    try {
      const raw = await readFile(join(process.cwd(), 'storage', 'browser-profiles', account.id, 'ai17z-cdp.json'), 'utf8');
      const cdpUrl = (JSON.parse(raw) as { cdpUrl?: string }).cdpUrl;
      if (!cdpUrl) continue;
      const response = await fetch(`${cdpUrl.replace(/\/$/, '')}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) continue;
      const targets = (await response.json()) as { type?: string }[];
      byAccount.push({ handle: account.handle, targets: targets.filter((t) => t.type === 'page').length });
    } catch {
      // No browser for that account right now. Absence is not a tab leak.
    }
  }
  return { total: byAccount.reduce((t, a) => t + a.targets, 0), byAccount };
}

async function sample(startedAt: number): Promise<Sample> {
  const [db] = await query<{ connections: number; idle_in_transaction: number; longest: number }>(
    `SELECT count(*)::int AS connections,
            count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
            coalesce(max(extract(epoch FROM now() - state_change)), 0)::int AS longest
       FROM pg_stat_activity WHERE datname = current_database()`,
  );

  const [queue] = await query<{ unsettled: number; retryable: number; review: number; permanent: number }>(
    `SELECT count(*) FILTER (WHERE status NOT IN
              ('EXECUTED','DRY_RUN_COMPLETED','CANCELLED','PERMANENT_FAILURE','REVIEW_REQUIRED'))::int AS unsettled,
            count(*) FILTER (WHERE status = 'RETRYABLE_FAILURE')::int AS retryable,
            count(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::int AS review,
            count(*) FILTER (WHERE status = 'PERMANENT_FAILURE')::int AS permanent
       FROM jobs`,
  );

  const [work] = await query<{ events: number; jobs: number; actions: number; real: number }>(
    `SELECT (SELECT count(*)::int FROM events) AS events,
            (SELECT count(*)::int FROM jobs) AS jobs,
            (SELECT count(*)::int FROM actions) AS actions,
            (SELECT count(*)::int FROM actions WHERE dry_run = false) AS real`,
  );

  // Tab health is published by the worker every ten seconds. A snapshot older
  // than ninety seconds means no browser, whatever it says inside.
  // Only accounts that claim to be connected. An account that is disconnected
  // is supposed to have no browser, and reporting its silence as a fault is how
  // a soak report becomes noise nobody reads.
  const sessions = await query<{ handle: string; tabs: unknown; stale: boolean }>(
    `SELECT a.handle, s.tabs, s.updated_at < now() - interval '90 seconds' AS stale
       FROM browser_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE a.status = 'CONNECTED'`,
  );
  let tabs = 0;
  let stale = 0;
  const roles = new Set<string>();
  for (const session of sessions) {
    const list = Array.isArray(session.tabs) ? (session.tabs as { role?: string }[]) : [];
    tabs += list.length;
    for (const tab of list) if (tab.role) roles.add(tab.role);
    if (session.stale) stale += 1;
  }

  const errors = await query<{ type: string; n: number }>(
    `SELECT type, count(*)::int AS n FROM trace_events
      WHERE level = 'error' AND at > now() - interval '15 minutes'
      GROUP BY type ORDER BY 2 DESC LIMIT 5`,
  );

  return {
    at: new Date().toISOString(),
    elapsedMinutes: Math.round((Date.now() - startedAt) / 60_000),
    memory: await memory(),
    ourTabs: await ourTabs(),
    db: {
      connections: db?.connections ?? 0,
      idleInTransaction: db?.idle_in_transaction ?? 0,
      longestSeconds: db?.longest ?? 0,
    },
    queue: {
      unsettled: queue?.unsettled ?? 0,
      retryable: queue?.retryable ?? 0,
      review: queue?.review ?? 0,
      failedPermanent: queue?.permanent ?? 0,
    },
    work: {
      events: work?.events ?? 0,
      jobs: work?.jobs ?? 0,
      actions: work?.actions ?? 0,
      realActions: work?.real ?? 0,
    },
    browser: { accounts: sessions.length, tabs, staleSnapshots: stale, roles: [...roles].sort() },
    errors: { last15min: errors.reduce((t, e) => t + e.n, 0), distinct: errors.map((e) => e.type) },
  };
}

/**
 * Trends, not readings.
 *
 * Compares the last quarter of the run against the first. A single high number
 * is usually nothing; the same number climbing for six hours is the thing worth
 * waking up for.
 */
function judge(samples: Sample[]): Flag[] {
  const flags: Flag[] = [];
  if (samples.length < 4) return flags;

  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const first = samples.slice(0, quarter);
  const last = samples.slice(-quarter);
  const mean = (xs: Sample[], pick: (s: Sample) => number) => xs.reduce((t, s) => t + pick(s), 0) / xs.length;

  const grew = (label: string, pick: (s: Sample) => number, factor: number, floor: number) => {
    const before = mean(first, pick);
    const after = mean(last, pick);
    if (before >= floor && after > before * factor) {
      flags.push({
        what: label,
        detail: `${Math.round(before)} at the start, ${Math.round(after)} at the end`,
      });
    }
  };

  grew('worker memory kept climbing', (s) => s.memory.worker, 1.5, 200);
  grew('tabs accumulated in AI17Z browsers', (s) => s.ourTabs.total, 1.5, 4);
  grew('database connections accumulated', (s) => s.db.connections, 1.5, 5);
  grew('the job queue grew faster than it drained', (s) => s.queue.unsettled, 2, 5);


  const lastSample = samples[samples.length - 1]!;
  if (lastSample.browser.staleSnapshots > 0) {
    flags.push({
      what: 'browser health went stale',
      detail: `${lastSample.browser.staleSnapshots} account(s) publishing nothing for over 90s`,
    });
  }
  if (lastSample.db.idleInTransaction > 0) {
    flags.push({
      what: 'a transaction was left open',
      detail: `${lastSample.db.idleInTransaction} connection(s) idle in transaction, longest ${lastSample.db.longestSeconds}s`,
    });
  }
  const errorSamples = samples.filter((s) => s.errors.last15min > 0).length;
  if (errorSamples > samples.length / 2) {
    flags.push({ what: 'errors were being recorded most of the time', detail: `in ${errorSamples} of ${samples.length} samples` });
  }
  return flags;
}

async function main(): Promise<void> {
  const minutes = process.argv.includes('--minutes') ? arg('minutes', 60) : arg('hours', 24) * 60;
  const intervalSeconds = arg('interval', 60);

  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const dir = join(process.cwd(), 'storage', 'soak');
  await mkdir(dir, { recursive: true });
  const stream = join(dir, `${stamp}.jsonl`);
  const report = join(dir, `${stamp}.json`);

  const samples: Sample[] = [];
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(`soak: ${minutes} minutes, sampling every ${intervalSeconds}s`);
  console.log(`soak: writing ${stream}`);
  console.log('soak: Ctrl-C stops it early and still writes the report.\n');

  while (!stopping && Date.now() - startedAt < minutes * 60_000) {
    let taken: Sample;
    try {
      taken = await sample(startedAt);
    } catch (error) {
      console.log(`  ! sample failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((r) => setTimeout(r, intervalSeconds * 1_000));
      continue;
    }
    samples.push(taken);
    await appendFile(stream, `${JSON.stringify(taken)}\n`, 'utf8').catch(() => undefined);

    console.log(
      `  ${String(taken.elapsedMinutes).padStart(4)}m  ` +
        `node ${String(taken.memory.worker).padStart(5)}MB  ` +
        `ourtabs ${String(taken.ourTabs.total).padStart(3)}  ` +
        `db ${String(taken.db.connections).padStart(3)}  ` +
        `queue ${String(taken.queue.unsettled).padStart(3)}  ` +
        `tabs ${String(taken.browser.tabs).padStart(2)}${taken.browser.staleSnapshots ? ' STALE' : ''}  ` +
        `jobs ${taken.work.jobs}  actions ${taken.work.realActions}` +
        (taken.errors.last15min ? `  errors ${taken.errors.last15min}` : ''),
    );

    const remaining = minutes * 60_000 - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalSeconds * 1_000, remaining)));
  }

  const flags = judge(samples);
  const finished = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    minutesRequested: minutes,
    minutesCompleted: Math.round((Date.now() - startedAt) / 60_000),
    samples: samples.length,
    intervalSeconds,
    stoppedEarly: stopping,
    first: samples[0] ?? null,
    last: samples[samples.length - 1] ?? null,
    flags,
    verdict: flags.length === 0 ? 'NOTHING_FLAGGED' : 'FLAGGED',
  };
  await writeFile(report, JSON.stringify(finished, null, 2), 'utf8');

  console.log(`\nsoak: ${finished.minutesCompleted} minutes, ${samples.length} samples`);
  if (flags.length === 0) {
    console.log('soak: nothing flagged.');
  } else {
    console.log(`soak: ${flags.length} thing(s) flagged:`);
    for (const flag of flags) console.log(`  - ${flag.what} (${flag.detail})`);
  }
  console.log(`soak: report written to ${report}`);
  await closePool();
}

await main();
