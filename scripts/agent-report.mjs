#!/usr/bin/env node
/**
 * What the agent actually did, read back out of its own trace.
 *
 * Every number here already existed. The pipeline records the queries research
 * sent, what came back, how engagement was decided, what the quality gate
 * scored, and how long each model call took -- and none of it was reachable
 * without writing SQL against a running instance, so nobody looked. An agent
 * that cannot be read is an agent that gets tuned by guessing.
 *
 * Read-only. Safe against a live instance.
 *
 *   node scripts/agent-report.mjs                 the last 7 days
 *   node scripts/agent-report.mjs --days 1
 *   node scripts/agent-report.mjs --queries       every research query, verbatim
 *   node scripts/agent-report.mjs --json          for piping somewhere else
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const days = Number(value('days', '7'));
const asJson = flag('json');
const showQueries = flag('queries');

/** DATABASE_URL from the environment, else the one in .env, else the default. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(resolve(root, '.env'), 'utf8');
    const line = env.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    if (line) return line.replace(/^\s*DATABASE_URL\s*=\s*/, '').trim().replace(/^["']|["']$/g, '');
  } catch {
    /* no .env: fall through */
  }
  return 'postgres://xbam:xbam@localhost:55432/xbam';
}

const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const since = `now() - interval '${Number.isFinite(days) ? days : 7} days'`;

/** A bar that survives a terminal with no colour. */
const bar = (n, max, width = 24) => '#'.repeat(Math.max(0, Math.round((n / (max || 1)) * width)));
const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '0%');
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const report = {};

  report.outcomes = await q(`
    select status, count(*)::int as n
    from jobs where created_at > ${since}
    group by 1 order by 2 desc`);

  report.blocked = await q(`
    select status, coalesce(last_error, '(none recorded)') as reason, count(*)::int as n
    from jobs
    where created_at > ${since} and status in ('REVIEW_REQUIRED','PERMANENT_FAILURE','FAILED')
    group by 1,2 order by 3 desc limit 15`);

  report.research = await q(`
    select
      count(*)::int as total,
      count(*) filter (where message like 'Nothing%')::int as declined,
      count(*) filter (where message not like 'Nothing%')::int as ran,
      count(*) filter (where jsonb_typeof(data->'failed') = 'array' and jsonb_array_length(data->'failed') > 0)::int as with_failures
    from trace_events where type = 'RESEARCH_DONE' and at > ${since}`);

  report.lookups = await q(`
    select
      l->>'kind' as kind,
      l->>'query' as query,
      case when jsonb_typeof(t.data->'findings') = 'array' then jsonb_array_length(t.data->'findings') else 0 end::int as findings,
      t.at
    from trace_events t, jsonb_array_elements(t.data->'lookups') l
    where t.type = 'RESEARCH_DONE' and t.at > ${since}
      -- A trace that recorded no lookups stores null here, not an empty array,
      -- and jsonb_array_elements refuses a scalar rather than yielding nothing.
      and jsonb_typeof(t.data->'lookups') = 'array'
    order by t.at desc`);

  report.quality = await q(`
    select
      count(*)::int as scored,
      round(avg((data->>'voice')::numeric))::int as avg_voice,
      round(avg((data->>'generic')::numeric))::int as avg_generic,
      count(*) filter (where (data->>'repetition')::numeric > 0)::int as repetitive,
      count(*) filter (where data->>'outcome' <> 'accept')::int as not_accepted
    from trace_events where type = 'QUALITY_SCORED' and at > ${since}`);

  report.engagement = await q(`
    select data->>'decision' as decision, count(*)::int as n
    from trace_events where type = 'ENGAGEMENT_DECIDED' and at > ${since}
    group by 1 order by 2 desc`);

  report.latency = await q(`
    select purpose,
           count(*)::int as calls,
           round(avg(latency_ms))::int as avg_ms,
           round(percentile_cont(0.95) within group (order by latency_ms))::int as p95_ms,
           max(latency_ms)::int as max_ms
    from model_calls where created_at > ${since}
    group by 1 order by 2 desc`);

  report.slowest = await q(`
    select j.id, j.status,
           round(extract(epoch from (j.executed_at - j.created_at)))::int as seconds
    from jobs j
    where j.executed_at is not null and j.created_at > ${since}
    order by 3 desc limit 5`);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const line = (s = '') => console.log(s);
  const heading = (s) => {
    line();
    line(s);
    line('-'.repeat(s.length));
  };

  line(`AI17Z agent report -- last ${days} day(s)`);

  heading('Where work ended up');
  const totalJobs = report.outcomes.reduce((a, r) => a + r.n, 0);
  const maxJobs = Math.max(...report.outcomes.map((r) => r.n), 1);
  for (const r of report.outcomes) {
    line(`  ${pad(r.status, 20)} ${pad(r.n, 5)} ${pad(pct(r.n, totalJobs), 5)} ${bar(r.n, maxJobs)}`);
  }
  line(`  ${pad('total', 20)} ${totalJobs}`);

  if (report.blocked.length) {
    heading('What stopped a reply going out');
    for (const r of report.blocked) line(`  ${pad(r.n, 4)} ${pad(r.status, 18)} ${r.reason.slice(0, 88)}`);
  }

  const res = report.research[0] ?? { total: 0, declined: 0, ran: 0 };
  heading('Research');
  line(`  decided ${res.total} times: looked something up ${res.ran} (${pct(res.ran, res.total)}),`);
  line(`  decided nothing was needed ${res.declined} (${pct(res.declined, res.total)})`);
  const empty = report.lookups.filter((l) => l.findings === 0).length;
  if (report.lookups.length) {
    line(`  ${report.lookups.length} lookups, ${empty} of them came back with nothing`);
  }

  if (report.lookups.length) {
    heading(showQueries ? 'Every query it sent' : 'Recent queries (--queries for all)');
    for (const l of showQueries ? report.lookups : report.lookups.slice(0, 12)) {
      const mark = l.findings === 0 ? '  (nothing found)' : '';
      line(`  ${pad(l.kind, 7)} ${JSON.stringify(l.query)}${mark}`);
    }
  }

  const qual = report.quality[0];
  if (qual?.scored) {
    heading('Quality gate');
    line(`  scored ${qual.scored}, average voice ${qual.avg_voice}, average generic ${qual.avg_generic}`);
    line(`  ${qual.repetitive} scored as repeating earlier replies`);
    line(`  ${qual.not_accepted} were not accepted first time`);
  }

  if (report.engagement.length) {
    heading('Engagement decisions');
    for (const r of report.engagement) line(`  ${pad(r.decision, 12)} ${r.n}`);
  }

  if (report.latency.length) {
    heading('Model latency');
    line(`  ${pad('purpose', 18)} ${pad('calls', 7)} ${pad('avg', 9)} ${pad('p95', 9)} max`);
    for (const r of report.latency) {
      line(`  ${pad(r.purpose, 18)} ${pad(r.calls, 7)} ${pad(r.avg_ms + 'ms', 9)} ${pad(r.p95_ms + 'ms', 9)} ${r.max_ms}ms`);
    }
  }

  if (report.slowest.length) {
    heading('Slowest replies, start to published');
    for (const r of report.slowest) line(`  ${pad(r.seconds + 's', 8)} ${r.id}`);
  }

  line();
}

main()
  .catch((error) => {
    console.error(`\nCould not read the database.\n  ${error.message}`);
    console.error(`\nTried: ${databaseUrl().replace(/:\/\/[^@]*@/, '://***@')}`);
    console.error('Set DATABASE_URL, or run this from an installation directory with a .env.\n');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
