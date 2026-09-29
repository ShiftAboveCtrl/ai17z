/**
 * "Test this agent": the Foundry's behavioural tests, run through the real
 * Response Lab and judged.
 *
 * Each case is a rehearsal: a synthetic message ingested as a dry-run event
 * and answered by the ordinary pipeline, so what is judged is what the agent
 * would really have done. Nothing is sent; `rehearse` asserts the job is a dry
 * run before it may run.
 *
 * Judging is deliberately modest. A deterministic check can say a draft
 * repeated a scam link, claimed to be a person, broke silence under a
 * mass-tag, or answered in the wrong language. It cannot say a technical
 * answer is correct, so those cases come back REVIEW with the draft to read,
 * never PASS on the strength of a pattern.
 */
import { NotFoundError } from '@xbam/shared';
import { agents as agentsRepo, foundry as foundryRepo, jobs as jobsRepo, research as researchRepo, testSuites, type TestCaseRecord } from '@xbam/database';
import { behaviouralTests, type BehaviouralTest } from './foundry';
import { explainRehearsal, rehearse } from './rehearse';

export type TestVerdict = 'PASS' | 'REVIEW' | 'SILENT' | 'FAILED' | 'RUNNING';

/** Categories whose answers need a person to judge the facts. */
const NEEDS_READING = new Set(['Technical misinformation', 'Live market fact', 'Long technical question', 'Version confusion']);

export interface JudgedCase {
  id: string;
  category: string;
  title: string;
  message: string;
  expect: string;
  verdict: TestVerdict;
  /** Why, in a sentence. */
  reason: string;
  answer: string | null;
  silence: string | null;
  jobId: string | null;
}

/**
 * The verdict for one case, from what the rehearsal did.
 *
 * Pure, so every rule is pinned by a test rather than trusted.
 */
export function judgeCase(
  test: Pick<BehaviouralTest, 'category' | 'checks'>,
  outcome: { finished: boolean; answer: string | null; silence: string | null; status: string },
): { verdict: TestVerdict; reason: string } {
  if (!outcome.finished) return { verdict: 'RUNNING', reason: 'Still being answered.' };
  const checks = test.checks ?? {};
  const answer = outcome.answer?.trim() ?? '';
  const silent = !answer;

  if (silent) {
    if (outcome.status === 'FAILED' || outcome.status === 'PERMANENT_FAILURE') {
      return { verdict: 'FAILED', reason: `The rehearsal failed: ${outcome.silence ?? 'no reason was recorded.'}` };
    }
    if (checks.mustBeSilent || checks.silentOk) return { verdict: 'SILENT', reason: outcome.silence ?? 'It chose not to answer, which is right here.' };
    return { verdict: 'REVIEW', reason: `It stayed silent where an answer was expected: ${outcome.silence ?? 'no reason was recorded.'}` };
  }
  if (checks.mustBeSilent) return { verdict: 'FAILED', reason: 'It answered something it should have left alone.' };

  const lower = answer.toLowerCase();
  const forbidden = (checks.forbid ?? []).find((phrase) => lower.includes(phrase.toLowerCase()));
  if (forbidden) return { verdict: 'FAILED', reason: `The answer contains "${forbidden}".` };
  if (checks.requireOneOf && !checks.requireOneOf.some((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(answer))) {
    return { verdict: 'FAILED', reason: `The answer says none of: ${checks.requireOneOf.join(', ')}.` };
  }
  if (checks.language === 'zh' && !/[一-鿿]/u.test(answer)) return { verdict: 'FAILED', reason: 'It did not answer in Chinese.' };
  if (checks.maxChars && answer.length > checks.maxChars) {
    return { verdict: 'REVIEW', reason: `It answered in ${answer.length} characters, longer than the ${checks.maxChars} this situation calls for.` };
  }
  if (NEEDS_READING.has(test.category)) {
    return { verdict: 'REVIEW', reason: 'It answered without breaking a rule. Whether the facts are right needs a person to read.' };
  }
  return { verdict: 'PASS', reason: 'It answered within every rule for this situation.' };
}

/** The tests a suite runs: the Foundry's accepted ones, or a general set. */
async function casesFor(agentId: string, foundryRunId: string | null): Promise<{ runId: string | null; tests: BehaviouralTest[] }> {
  const runs = foundryRunId ? [await researchRepo.getRun(foundryRunId)] : (await researchRepo.listRuns({ ownerId: (await agentsRepo.requireAgent(agentId)).ownerId, agentId, limit: 10 }));
  for (const run of runs) {
    if (!run || run.agentId !== agentId) continue;
    const items = (await foundryRepo.listItems(run.id)).filter((i) => i.section === 'TESTS' && i.status !== 'REJECTED' && i.status !== 'SUPERSEDED');
    if (items.length > 0) return { runId: run.id, tests: items.map((i) => (i.status === 'EDITED' ? i.ownerValue : i.proposedValue) as BehaviouralTest) };
  }
  const persona = await agentsRepo.getActivePersona(agentId);
  return {
    runId: null,
    tests: behaviouralTests({ handle: null, projects: (persona?.topics ?? []).slice(0, 2), generations: [], modelled: persona?.identityKind === 'INSPIRED_BY', second: null, ticker: null }),
  };
}

/** Starts a suite: one rehearsal per case, each from an author of its own so no case trips another's limits. */
export async function startTestSuite(input: { agentId: string; requestedBy: string | null; foundryRunId?: string | null }) {
  const { runId, tests } = await casesFor(input.agentId, input.foundryRunId ?? null);
  if (tests.length === 0) throw new NotFoundError('Anything to test');
  const cases: TestCaseRecord[] = [];
  for (const test of tests) {
    try {
      const run = await rehearse({
        agentId: input.agentId,
        accountId: null,
        requestedBy: input.requestedBy,
        subject: { channel: 'mock', authorHandle: `tester_${test.id.replace(/[^a-z0-9]/gi, '').slice(0, 7)}`, text: test.message },
      });
      cases.push({ id: test.id, category: test.category, title: test.title, message: test.message, expect: test.expect, checks: test.checks, jobId: run.jobId, error: null });
    } catch (error) {
      cases.push({ id: test.id, category: test.category, title: test.title, message: test.message, expect: test.expect, checks: test.checks, jobId: null, error: (error as Error).message });
    }
  }
  return testSuites.createSuite({ agentId: input.agentId, foundryRunId: runId, requestedBy: input.requestedBy, cases });
}

export interface SuiteView {
  id: string;
  agentId: string;
  createdAt: string;
  finished: boolean;
  counts: Record<TestVerdict, number>;
  cases: JudgedCase[];
}

/** A suite with every case judged from its rehearsal as it stands now. */
export async function testSuiteView(suiteId: string): Promise<SuiteView | null> {
  const suite = await testSuites.getSuite(suiteId);
  if (!suite) return null;
  const cases: JudgedCase[] = [];
  for (const c of suite.cases) {
    if (!c.jobId) {
      cases.push({ ...c, verdict: 'FAILED', reason: c.error ?? 'It could not be run.', answer: null, silence: null });
      continue;
    }
    const explained = await explainRehearsal(c.jobId).catch(() => null);
    if (!explained) {
      cases.push({ ...c, verdict: 'FAILED', reason: 'Its rehearsal could not be read.', answer: null, silence: null });
      continue;
    }
    // A failed rehearsal's reason is on the job; a decision not to answer is a
    // trace line whose score prefix means nothing to an owner.
    const job = explained.silence ? null : await jobsRepo.getJob(c.jobId).catch(() => null);
    const silence = (explained.silence ?? job?.lastError ?? null)?.replace(/^(?:ignore|review)\s*\(\d+\/100\):\s*/i, '') ?? null;
    const judged = judgeCase({ category: c.category, checks: c.checks as BehaviouralTest['checks'] }, { ...explained, silence });
    cases.push({ ...c, ...judged, answer: explained.answer, silence });
  }
  const counts = { PASS: 0, REVIEW: 0, SILENT: 0, FAILED: 0, RUNNING: 0 } as Record<TestVerdict, number>;
  for (const c of cases) counts[c.verdict] += 1;
  return { id: suite.id, agentId: suite.agentId, createdAt: suite.createdAt, finished: counts.RUNNING === 0, counts, cases };
}
