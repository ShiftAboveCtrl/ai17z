import { useState } from 'react';
import type { CapabilityApprovalStatus, CapabilityApprovalSource } from '@xbam/shared/contracts';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import { ApiError, post } from '@app/lib/api';
import { EmptyState, RetryablePanel, Working } from '@app/components/ui';
import { Card, Panel } from './shared';

interface Approval {
  id: string;
  capabilityId: string;
  source: CapabilityApprovalSource;
  status: CapabilityApprovalStatus;
  why: string;
  expiresAt: string;
  resultReason: string | null;
  inputPreview: string;
  inputTruncated: boolean;
}

const statuses: Record<CapabilityApprovalStatus, string> = {
  PENDING: 'Awaiting your decision', APPROVED: 'Approved, waiting for the worker', DENIED: 'Rejected',
  EXPIRED: 'Expired', DONE: 'Completed', FAILED: 'Stopped permanently',
};
const sources: Record<CapabilityApprovalSource, string> = { GOAL_PLAN: 'Goal plan', OWNER_CHAT: 'Owner chat', REPLY: 'Reply' };

export function CapabilityApprovals({ agentId }: { agentId: string }) {
  const path = `/api/agents/${agentId}/mind/capability-approvals`;
  const queue = useResource<Approval[]>(path);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = queue.data?.some(row => row.status === 'APPROVED') ?? false;
  const waitingSeconds = useElapsed(waiting);
  const loadingSeconds = useElapsed(queue.loading);
  usePolling(queue.reload, 5000, waiting);

  const decide = async (id: string, decision: 'APPROVE' | 'REJECT', reason?: string) => {
    setBusy(id);
    setError(null);
    try {
      await post(`${path}/${id}/decision`, { decision, ...(reason ? { reason } : {}) });
      queue.reload();
    } catch (error) {
      setError(error instanceof ApiError && error.status === 409 ? error.message
        : 'The decision could not be saved. Refresh the queue before trying again.');
      queue.reload();
    } finally { setBusy(null); }
  };

  return <Panel title="Capability approvals"
    lede="Approve one saved call or reject it with a reason. Calls expire after 24 hours. Current permissions, availability, quotas and PAUSE ALL still apply. A refusal, including a pause or exhausted quota, permanently stops this call. Ask the agent for a new proposal after resolving the gate."
    action={<button type="button" className="btn-ghost min-h-12" onClick={queue.reload}>Refresh approvals</button>}>
    {queue.loading && !queue.data && <Working label="Loading capability approvals" seconds={loadingSeconds} />}
    {queue.error && <RetryablePanel title="Approvals could not be loaded" detail="Refresh to try again." onRetry={queue.reload} />}
    {error && <p role="alert" className="mb-3 text-bone">{error}</p>}
    {queue.data?.length === 0 && <EmptyState title="No capability approvals" detail="Calls that need your decision will appear here." />}
    <div className="space-y-3" aria-live="polite">
      {queue.data?.map(row => <Card key={row.id} title={row.capabilityId}
        meta={`${sources[row.source]} · ${statuses[row.status]}`}>
        <p className="break-words text-sm text-bone-dim">{row.why}</p>
        <p className="mt-3 text-sm text-bone-dim">Saved call input (secrets redacted)</p>
        <pre className="mt-2 min-w-0 whitespace-pre-wrap break-words text-sm text-bone">{row.inputPreview}</pre>
        {row.inputTruncated && <p className="mt-2 break-words text-sm text-bone-faint">Preview truncated after 12,000 characters.</p>}
        {row.status === 'APPROVED' && <Working label="Waiting for the approved call to settle" seconds={waitingSeconds}
          slowHint="Current gates still apply. Use PAUSE ALL to stop pending execution." />}
        <p className="mt-2 break-words text-sm text-bone-faint">Expires {new Date(row.expiresAt).toLocaleString()}</p>
        {row.resultReason && <p className="mt-2 break-words text-sm text-bone-dim">{row.resultReason}</p>}
        {row.status === 'PENDING' && <div className="mt-3 space-y-3">
          <button type="button" className="btn-ghost min-h-12" disabled={busy !== null}
            onClick={() => void decide(row.id, 'APPROVE')}>{busy === row.id ? 'Saving decision…' : 'Approve this call once'}</button>
          <form aria-label={`Reject ${row.capabilityId}`} onSubmit={event => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
            if (reason) void decide(row.id, 'REJECT', reason);
          }} className="flex min-w-0 flex-col gap-2">
            <label htmlFor={`approval-reason-${row.id}`} className="text-sm text-bone-dim">Reason for rejecting (required)</label>
            <input id={`approval-reason-${row.id}`} name="reason" autoComplete="off" required maxLength={500} pattern=".*\S.*"
              className="field min-h-12 w-full min-w-0 text-base" disabled={busy !== null} />
            <button type="submit" className="btn-ghost min-h-12 self-start" disabled={busy !== null}>Reject call</button>
          </form>
        </div>}
      </Card>)}
    </div>
  </Panel>;
}
