import { capabilityApprovals as approvals, capabilityInvocations, capabilityPermissions, ops } from '@xbam/database';
import { canonicalJson, createLogger, sha256Hex } from '@xbam/shared';
import { getCapability, invokeCapability } from '@xbam/tools';
import { PAUSE_ALL_SETTING_KEY } from './killSwitch';

const log = createLogger('capability-approvals');

/** Every worker sweeps; every execution still enters invokeCapability. */
export async function sweepCapabilityApprovals(): Promise<void> {
  await approvals.expire();
  const row = await approvals.nextApproved();
  if (!row || !(await approvals.claim(row.id))) return;
  try {
    const capability = getCapability(row.capabilityId);
    const parsed = capability?.input.safeParse(row.input);
    if (!parsed?.success || sha256Hex(canonicalJson(row.input)) !== row.inputSha256 ||
      sha256Hex(canonicalJson(parsed.data)) !== row.inputSha256) {
      await approvals.finish(row.id, 'FAILED', 'The stored call no longer matches its validated input.');
      return;
    }
    const settings = (await capabilityPermissions.listForAgent(row.agentId)).find(p => p.capability_id === row.capabilityId);
    const context = { agentId: row.agentId, jobId: row.jobId, accountId: row.accountId,
      config: settings?.config ?? {}, audience: row.audience, origin: row.origin, logger: log };
    const recheckPermission = async () => {
      const [current, permissions, pause] = await Promise.all([
        approvals.get(row.id, row.agentId), capabilityPermissions.listForAgent(row.agentId),
        ops.getSetting<{ paused?: boolean }>(PAUSE_ALL_SETTING_KEY),
      ]);
      const grant = permissions.find(p => p.capability_id === row.capabilityId);
      context.config = grant?.config ?? {};
      const permission = grant?.permission ?? null;
      return { stored: current?.status === 'APPROVED' && current.executionKey === row.id &&
        Date.parse(current.expiresAt) > Date.now() ? permission : 'DISABLED' as const,
        paused: pause?.paused === true, approved: true };
    };
    const result = await invokeCapability({
      call: { id: row.capabilityId, input: row.input },
      context,
      permission: await recheckPermission(), recheckPermission,
    });
    // Capability errors and outputs may contain private provider content.
    const reason = result.outcome === 'SUCCEEDED' ? 'The approved call completed.'
      : result.outcome === 'REFUSED' ? 'A current permission, readiness or quota gate refused this call.'
        : 'Execution did not complete with a known success. This call will not be retried.';
    await capabilityInvocations.recordInvocation({ agentId: row.agentId, jobId: row.jobId, accountId: row.accountId,
      capabilityId: row.capabilityId, step: 1, outcome: result.outcome, input: row.input,
      output: null, durationMs: result.durationMs, detail: reason }).catch((error: unknown) => {
      // Recording trouble cannot undo a completed effect or justify retrying it.
      log.error('approved capability invocation could not be recorded', {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    });
    await approvals.finish(row.id, result.outcome === 'SUCCEEDED' ? 'DONE' : 'FAILED', reason);
  } catch (error) {
    log.error('approved capability call stopped', { errorClass: error instanceof Error ? error.name : typeof error });
    // Failing closed includes a permission read failure and an unknown WRITE result.
    await approvals.finish(row.id, 'FAILED', 'A required gate or execution record was unavailable. This call will not be retried.');
  }
}
