/**
 * Where the time goes, from rows the pipeline already writes.
 *
 * Nothing is instrumented for this and nothing is exported. Every number below
 * is a difference between two timestamps AI17Z already records, which is what
 * makes it safe to run against a real installation: no counters to drift, no
 * agent to slow down, and no data leaving the machine.
 *
 *   npm run latency
 *   DATABASE_URL=postgres://... npm run latency
 *
 * The stages are the ones an owner would name. "Somebody posted" to "the reply
 * was live" is the number that matters; the rest exist to say which part of it
 * to argue with.
 */
import { query } from '@xbam/database';

interface Row extends Record<string, unknown> {
  n: number;
  median: number | null;
  p90: number | null;
}

async function stage(label: string, sql: string): Promise<void> {
  const [row] = await query<Row>(sql);
  if (!row || row.n === 0) {
    console.log(`  ${label.padEnd(38)} no data yet`);
    return;
  }
  const median = row.median === null ? '?' : `${Number(row.median).toFixed(1)}s`;
  const p90 = row.p90 === null ? '?' : `${Number(row.p90).toFixed(1)}s`;
  console.log(`  ${label.padEnd(38)} ${String(row.n).padStart(5)}   median ${median.padStart(9)}   p90 ${p90.padStart(9)}`);
}

const seconds = (expression: string) => `EXTRACT(EPOCH FROM (${expression}))`;

console.log('AI17Z latency, measured from what already happened');
console.log();
console.log(`  ${'stage'.padEnd(38)} ${'count'.padStart(5)}   ${'median'.padStart(16)}   ${'p90'.padStart(13)}`);
console.log(`  ${'-'.repeat(38)} ${'-'.repeat(5)}   ${'-'.repeat(16)}   ${'-'.repeat(13)}`);

await stage(
  'post written -> AI17Z saw it',
  `SELECT count(*)::int AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ${seconds('ingested_at - occurred_at')}) AS median,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY ${seconds('ingested_at - occurred_at')}) AS p90
     FROM events
    WHERE type IN ('MENTION','REPLY') AND occurred_at IS NOT NULL AND ingested_at >= occurred_at`,
);

await stage(
  'saw it -> work queued',
  `SELECT count(*)::int AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ${seconds('j.created_at - e.ingested_at')}) AS median,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY ${seconds('j.created_at - e.ingested_at')}) AS p90
     FROM jobs j JOIN events e ON e.id = j.event_id
    WHERE j.created_at >= e.ingested_at`,
);

await stage(
  'queued -> landed on the platform',
  `SELECT count(*)::int AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ${seconds('a.executed_at - j.created_at')}) AS median,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY ${seconds('a.executed_at - j.created_at')}) AS p90
     FROM actions a JOIN jobs j ON j.id = a.job_id
    WHERE a.status = 'EXECUTED' AND a.dry_run = false AND a.executed_at IS NOT NULL`,
);

await stage(
  'somebody posted -> reply was live',
  `SELECT count(*)::int AS n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY ${seconds('a.executed_at - e.occurred_at')}) AS median,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY ${seconds('a.executed_at - e.occurred_at')}) AS p90
     FROM actions a JOIN jobs j ON j.id = a.job_id JOIN events e ON e.id = j.event_id
    WHERE a.status = 'EXECUTED' AND a.dry_run = false AND a.type = 'REPLY' AND e.occurred_at IS NOT NULL`,
);

console.log();
console.log('  model calls, by what they were for');
console.log();
const calls = await query<{
  role: string;
  purpose: string;
  calls: number;
  median_ms: number;
  p90_ms: number;
  wasted: number;
}>(
  `SELECT coalesce(model_role, '(none)') AS role,
          purpose,
          count(*)::int AS calls,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS median_ms,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms) AS p90_ms,
          count(*) FILTER (WHERE status <> 'SUCCEEDED')::int AS wasted
     FROM model_calls
    WHERE latency_ms > 0
    GROUP BY 1, 2
    ORDER BY count(*) DESC
    LIMIT 12`,
);
for (const row of calls) {
  const median = `${(Number(row.median_ms) / 1000).toFixed(1)}s`;
  const p90 = `${(Number(row.p90_ms) / 1000).toFixed(1)}s`;
  const failed = row.wasted > 0 ? `  ${row.wasted} did not succeed` : '';
  console.log(
    `  ${`${row.role}/${row.purpose}`.padEnd(38)} ${String(row.calls).padStart(5)}   median ${median.padStart(9)}   p90 ${p90.padStart(9)}${failed}`,
  );
}

console.log();
console.log('  Read the whole-reply row first. The rest say which part to argue with.');
process.exit(0);
