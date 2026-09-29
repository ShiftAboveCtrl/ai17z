/**
 * Behavioural test suites an owner ran against an agent. Each case points at
 * the rehearsal job that answered it; verdicts are judged from those jobs when
 * read, never stored.
 */
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export interface TestCaseRecord {
  id: string;
  category: string;
  title: string;
  message: string;
  expect: string;
  checks: Record<string, unknown>;
  jobId: string | null;
  /** Why the case could not be run at all, when it could not. */
  error: string | null;
}

export interface TestSuiteRow {
  id: string;
  agentId: string;
  foundryRunId: string | null;
  requestedBy: string | null;
  cases: TestCaseRecord[];
  createdAt: string;
}

export async function createSuite(input: {
  agentId: string;
  foundryRunId: string | null;
  requestedBy: string | null;
  cases: TestCaseRecord[];
}): Promise<TestSuiteRow> {
  return mapRow<TestSuiteRow>(
    await queryOne(
      `INSERT INTO agent_test_suites (agent_id, foundry_run_id, requested_by, cases)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [input.agentId, input.foundryRunId, input.requestedBy, JSON.stringify(input.cases)],
    ),
  )!;
}

export async function getSuite(id: string): Promise<TestSuiteRow | null> {
  return mapRow<TestSuiteRow>(await queryOne('SELECT * FROM agent_test_suites WHERE id = $1', [id]));
}

export async function listSuites(agentId: string, limit = 10): Promise<TestSuiteRow[]> {
  return mapRows<TestSuiteRow>(
    await query('SELECT * FROM agent_test_suites WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2', [agentId, limit]),
  );
}
