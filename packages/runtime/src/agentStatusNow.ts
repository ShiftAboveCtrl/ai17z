import { jobs as jobsRepo, query } from '@xbam/database';
import { IN_FLIGHT_JOB_STATUSES, type AgentDiagnostics } from '@xbam/shared/contracts';
import { collectDiagnostics } from '@xbam/tools';
import { liveStatus, type LiveStatus } from './liveStatus';

/**
 * What one agent is doing right now, read from stored state.
 *
 * The agent screen and a linked Studio both ask this, so it is assembled in
 * one place: two compositions of the same three reads would agree until one
 * of them learned about a new kind of waiting.
 */
export async function agentStatusNow(agentId: string): Promise<{ status: LiveStatus; diagnostics: AgentDiagnostics; awaitingPeople: number }> {
  const [diagnostics, inFlight, awaitingPeople] = await Promise.all([
    collectDiagnostics(agentId),
    query<{ status: string; current_node_key: string | null; action_type: string }>(
      `SELECT status, current_node_key, action_type FROM jobs
        WHERE agent_id = $1 AND status = ANY($2::text[])`,
      [agentId, [...IN_FLIGHT_JOB_STATUSES]],
    ),
    /*
      Through the one definition, scoped to this agent. A Response Lab
      rehearsal is held in a decision status and publishes nothing, so
      counting the statuses directly said "2 messages are waiting" where the
      inbox offered one.
    */
    jobsRepo.countAwaitingAPerson(agentId),
  ]);
  return {
    status: liveStatus({
      diagnostics,
      inFlight: inFlight.map((row) => ({ status: row.status, currentNodeKey: row.current_node_key, actionType: row.action_type })),
      awaitingPeople,
    }),
    diagnostics,
    awaitingPeople,
  };
}
