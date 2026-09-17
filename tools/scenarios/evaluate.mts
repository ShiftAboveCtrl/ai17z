/**
 * Runs the corpus through the real pipeline and lays the answers out together.
 *
 * The point is the table at the end, not any single row. An agent can answer
 * every message in isolation and still open a third of its replies the same
 * way, end everything on a question, or turn banter into documentation; those
 * are properties you can only see side by side.
 *
 * Everything here is a rehearsal, so nothing is published. Each case goes
 * through `rehearse`, which sets the dry run in one place and reads the job
 * back to check it landed, and then through the ordinary ten steps.
 *
 *   npm run evaluate            against this checkout's database
 *   DATABASE_URL=... npm run evaluate -- --agent <id>
 *
 * `--keep` leaves the rehearsal jobs in place to inspect on the Lab screen.
 */
import { agents as agentsRepo, jobs as jobsRepo, query } from '@xbam/database';
import { bootstrapRuntime, explainRehearsal, rehearse } from '@xbam/runtime';
import { CORPUS } from './corpus.mts';
import { drainAgentJobs } from '../../tests/support/runner';

const args = process.argv.slice(2);
const agentArg = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const keep = args.includes('--keep');
const inProcess = args.includes('--in-process');

/** A reply that stops without a sentence ending is one nobody finished. */
const finished = (text: string) => /[.!?)"'”’…]\s*$/.test(text.trim());

/**
 * A dash used as punctuation, which an agent may never publish.
 *
 * The structural ones stay: a hyphen inside a word, a version, a flag or a URL
 * never has whitespace on both sides.
 */
const rhetoricalDash = (text: string) => /\s[—–]\s|\s--\s|\w\s-\s\w/.test(text);

const HELPDESK = [/great question/i, /hope (this|that) helps/i, /let me know if/i, /feel free to/i, /happy to help/i];

async function main(): Promise<void> {
  const agentId =
    agentArg ??
    (
      await query<{ id: string }>(
        `SELECT id FROM agents WHERE state = 'ACTIVE' ORDER BY created_at LIMIT 1`,
      )
    )[0]?.id;
  if (!agentId) throw new Error('No active agent to evaluate. Pass --agent <id>.');

  const agent = await agentsRepo.getAgent(agentId);
  const cases = only ? CORPUS.filter((entry) => entry.id === only || entry.shape.includes(only)) : CORPUS;
  console.log(`Evaluating ${agent?.name ?? agentId} against ${cases.length} shapes. Nothing is published.\n`);

  const runs: { id: string; shape: string; jobId: string; looksLike: string }[] = [];
  for (const entry of cases) {
    const run = await rehearse({
      agentId,
      subject: {
        channel: 'mock',
        authorHandle: entry.from,
        text: entry.text,
        ...(entry.parent ? { parentText: entry.parent } : {}),
      },
    });
    runs.push({ id: entry.id, shape: entry.shape, jobId: run.jobId, looksLike: entry.looksLike });
    process.stdout.write('.');
  }
  if (inProcess) {
    // Capabilities and tools register on bootstrap, and nothing has done it in
    // this process: without it the pipeline runs against an empty registry.
    await bootstrapRuntime();
    console.log('\nqueued. running them here...\n');
    await drainAgentJobs(agentId, 400);
  } else {
    console.log('\nqueued. waiting for the worker...\n');
  }

  // The worker settles these; this only waits. A rehearsal that never settles
  // is a finding in itself, so the wait is bounded and says so.
  // Already drained when running in process; the loop below then just reads.
  const deadline = inProcess ? Date.now() : Date.now() + 10 * 60_000;
  const settled = new Set<string>();
  while (settled.size < runs.length && Date.now() < deadline) {
    for (const run of runs) {
      if (settled.has(run.jobId)) continue;
      const job = await jobsRepo.getJob(run.jobId);
      if (job && ['DRY_RUN_COMPLETED', 'EXECUTED', 'CANCELLED', 'PERMANENT_FAILURE', 'REVIEW_REQUIRED'].includes(job.status)) {
        settled.add(run.jobId);
      }
    }
    if (settled.size < runs.length) await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const rows: {
    shape: string;
    answer: string;
    chars: number;
    complete: boolean;
    dash: boolean;
    tell: string | null;
    decision: string;
    research: string;
    memories: string;
    status: string;
    looksLike: string;
  }[] = [];

  for (const run of runs) {
    const explained = await explainRehearsal(run.jobId);
    const answer = explained.silence ?? explained.answer ?? '(nothing)';
    const stage = (key: string) => explained.stages.find((entry) => entry.key === key);
    rows.push({
      shape: run.shape,
      answer,
      chars: explained.answer?.length ?? 0,
      complete: explained.silence ? true : finished(answer),
      dash: rhetoricalDash(answer),
      tell: HELPDESK.find((pattern) => pattern.test(answer))?.source ?? null,
      decision: stage('worth')?.detail.slice(0, 60) ?? '',
      research: stage('lookups')?.detail.slice(0, 50) ?? '',
      memories: stage('memory')?.detail.slice(0, 30) ?? '',
      status: explained.status,
      looksLike: run.looksLike,
    });
  }

  for (const row of rows) {
    console.log(`── ${row.shape}  [${row.status}]`);
    console.log(`   wanted : ${row.looksLike}`);
    console.log(`   said   : ${row.answer}`);
    const flags = [
      `${row.chars} chars`,
      row.complete ? 'complete' : 'ENDS MID-THOUGHT',
      row.dash ? 'RHETORICAL DASH' : null,
      row.tell ? `TELL: ${row.tell}` : null,
    ].filter(Boolean);
    console.log(`   ${flags.join(' · ')}`);
    if (row.decision) console.log(`   decided: ${row.decision}`);
    console.log();
  }

  // The distributional checks, which are the reason this runs as a batch.
  const answered = rows.filter((row) => row.chars > 0);
  const openings = answered.map((row) => row.answer.split(/\s+/).slice(0, 2).join(' ').toLowerCase());
  const repeatedOpening = [...new Set(openings)].filter((o) => openings.filter((x) => x === o).length > 1);
  const endsOnQuestion = answered.filter((row) => row.answer.trim().endsWith('?'));

  console.log('─'.repeat(70));
  console.log(`answered ${answered.length} of ${rows.length}; silent on ${rows.length - answered.length}`);
  console.log(`lengths: ${Math.min(...answered.map((r) => r.chars))} to ${Math.max(...answered.map((r) => r.chars))}`);
  console.log(`ends mid-thought: ${rows.filter((r) => !r.complete).length}`);
  console.log(`rhetorical dashes: ${rows.filter((r) => r.dash).length}`);
  console.log(`helpdesk tells: ${rows.filter((r) => r.tell).length}`);
  console.log(`ends on a question: ${endsOnQuestion.length} of ${answered.length}`);
  console.log(`repeated two-word openings: ${repeatedOpening.join(', ') || 'none'}`);

  if (!keep) {
    // The rehearsals are left in the job history either way; this only stops
    // them sitting in a state that looks like it wants something.
    for (const run of runs) {
      await jobsRepo
        .updateJob(run.jobId, { status: 'CANCELLED', lastError: 'Evaluation rehearsal.' })
        .catch(() => undefined);
    }
  }
}

await main();
process.exit(0);
