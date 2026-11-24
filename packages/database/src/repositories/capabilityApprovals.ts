import { canonicalJson, sha256Hex } from '@xbam/shared';
import type { CapabilityApprovalSource, CapabilityApprovalStatus } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, withTransaction } from '../pool';

export interface CapabilityApprovalRow {
  id: string;
  agentId: string;
  capabilityId: string;
  input: unknown;
  inputSha256: string;
  source: CapabilityApprovalSource;
  sourceRef: string;
  status: CapabilityApprovalStatus;
  why: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  jobId: string | null;
  accountId: string | null;
  audience: 'OWNER' | 'PUBLIC';
  origin: { conversationId: string; messageId: string; text: string; ownerId: string | null } | null;
  executionKey: string | null;
  resultReason: string | null;
}

export async function propose(input: Pick<CapabilityApprovalRow,
  'agentId' | 'capabilityId' | 'input' | 'source' | 'sourceRef' | 'why' | 'jobId' | 'accountId' | 'audience' | 'origin'>): Promise<void> {
  await query(`INSERT INTO capability_approvals
    (agent_id,capability_id,input,input_sha256,source,source_ref,why,job_id,account_id,audience,origin)
    VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT (agent_id,capability_id,source,source_ref,input_sha256) DO NOTHING`,
  [input.agentId, input.capabilityId, JSON.stringify(input.input), sha256Hex(canonicalJson(input.input)),
    input.source, input.sourceRef, input.why, input.jobId, input.accountId, input.audience, JSON.stringify(input.origin)]);
}

export async function listForAgent(agentId: string): Promise<CapabilityApprovalRow[]> {
  return mapRows<CapabilityApprovalRow>(await query(
    `SELECT * FROM capability_approvals WHERE agent_id=$1
     ORDER BY (status='PENDING') DESC,(status='APPROVED') DESC,created_at DESC LIMIT 100`, [agentId]));
}

export async function get(id: string, agentId: string): Promise<CapabilityApprovalRow | null> {
  return mapRow<CapabilityApprovalRow>((await query('SELECT * FROM capability_approvals WHERE id=$1 AND agent_id=$2', [id, agentId]))[0]);
}

export async function decide(input: {
  id: string; agentId: string; ownerId: string; decision: 'APPROVE' | 'REJECT'; reason?: string;
}): Promise<void> {
  await withTransaction(async tx => {
    const row = await tx.one(`UPDATE capability_approvals SET
      status=CASE WHEN expires_at<=now() THEN 'EXPIRED' ELSE $4 END,
      decided_by=$3, decided_at=now(), decision_reason=$5
      WHERE id=$1 AND agent_id=$2 AND status='PENDING' RETURNING id,status`,
    [input.id, input.agentId, input.ownerId, input.decision === 'APPROVE' ? 'APPROVED' : 'DENIED', input.reason ?? null]);
    if (!row) return;
    await tx.query(`INSERT INTO audit_events(actor_user_id,action,entity_type,entity_id,data)
      VALUES($1,$2,'capability_approval',$3,$4::jsonb)`,
    [input.ownerId, row.status === 'EXPIRED' ? 'capability.approval.expired'
      : input.decision === 'APPROVE' ? 'capability.approval.approved' : 'capability.approval.denied',
      input.id, JSON.stringify({ agentId: input.agentId })]);
  });
}

export async function expire(): Promise<void> {
  await query(`UPDATE capability_approvals SET status='EXPIRED', result_reason='This proposal expired.'
    WHERE status IN ('PENDING','APPROVED') AND execution_key IS NULL AND expires_at<=now()`);
  // A committed claim is never retaken. A dead worker may have sent a WRITE.
  await query(`UPDATE capability_approvals SET status='FAILED', result_reason='Execution was interrupted. Check the result before proposing another call.'
    WHERE status='APPROVED' AND execution_key IS NOT NULL AND execution_started_at < now()-interval '10 minutes'`);
}

export async function nextApproved(): Promise<CapabilityApprovalRow | null> {
  return mapRow<CapabilityApprovalRow>((await query(`SELECT * FROM capability_approvals
    WHERE status='APPROVED' AND execution_key IS NULL AND expires_at>now() ORDER BY created_at LIMIT 1`))[0]);
}

export async function claim(id: string): Promise<boolean> {
  const rows = await query(`UPDATE capability_approvals SET execution_key=id, execution_started_at=now()
    WHERE id=$1 AND status='APPROVED' AND execution_key IS NULL AND expires_at>now() RETURNING id`, [id]);
  return rows.length === 1;
}

export async function finish(id: string, status: 'DONE' | 'FAILED', reason: string): Promise<void> {
  await query(`UPDATE capability_approvals SET status=$2,result_reason=$3 WHERE id=$1 AND status='APPROVED'`, [id, status, reason]);
}
