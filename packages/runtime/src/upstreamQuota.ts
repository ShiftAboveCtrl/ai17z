import { upstreamQuota as quotaRepo } from '@xbam/database';
import { MachineQuotaCoordinator, type QuotaCoordinator, type QuotaWindow } from '@xbam/upstream';
import { logger } from '@xbam/shared';

const log = logger.child({ mod: 'upstream-quota' });

/**
 * The coordinator an installation actually runs with.
 *
 * Two budgets with two different shapes, and one of them cannot live where the
 * other does:
 *
 *   an **installation's** allowance -- a per-key quota, an account limit -- is
 *     shared by this installation's processes and by nothing else, so it lives
 *     in this installation's database, where a transaction can make the sum and
 *     the spend one act;
 *   a **machine's** allowance -- an endpoint counting by source address -- is
 *     shared by every AI17Z on the machine, which have separate databases and no
 *     table in common, so it lives in files they can all reach.
 *
 * Routing on the window's own scope rather than on the shape of the key, so a
 * budget cannot end up in the wrong place because somebody changed a prefix.
 *
 * ### Where this lives, and why not in packages/upstream
 *
 * `packages/upstream` is a package about asking outside services. Giving it a
 * dependency on the database would make it a package about AI17Z, and the point
 * of the injected coordinator is that the runtime supplies the policy while the
 * scheduler stays reusable. The machine half has no such problem -- it needs
 * only the filesystem -- so it stays over there.
 */
export class InstallationQuotaCoordinator implements QuotaCoordinator {
  private readonly machine = new MachineQuotaCoordinator();

  /** What is genuinely being coordinated, for the health screen. */
  describe(): { installation: string; machine: string } {
    return {
      installation: "this installation's processes, through its database",
      machine: this.machine.describeScope(),
    };
  }

  private isMachine(windows: QuotaWindow[]): boolean {
    // Grouped by scope before it arrives, so they agree; the first is the answer
    // and a mixture would be a caller bug rather than something to average.
    return windows[0]?.scope === 'MACHINE';
  }

  async reserve(input: {
    key: string;
    windows: QuotaWindow[];
    weight: number;
    now: number;
  }): Promise<{ granted: true } | { granted: false; retryAfterMs: number; window: string }> {
    if (this.isMachine(input.windows)) return this.machine.reserve(input);
    try {
      return await quotaRepo.reserve({
        quotaKey: input.key,
        windows: input.windows.map((window) => ({
          capacity: window.capacity,
          intervalMs: window.intervalMs,
          label: window.label,
        })),
        weight: input.weight,
      });
    } catch (error) {
      // A database that cannot answer must not become a way to ignore a limit.
      // Refusing briefly is wrong in the safe direction; granting would let an
      // outage turn into an endpoint complaint.
      log.warn('could not reserve upstream quota', {
        key: input.key,
        message: error instanceof Error ? error.message : String(error),
      });
      return { granted: false, retryAfterMs: 500, window: 'a budget that could not be read' };
    }
  }

  async blockUntil(input: { key: string; until: number; why: string }): Promise<void> {
    // Recorded in both places. A 429 is about the endpoint, and which of our
    // budgets we happened to be spending does not change who has to hear it.
    await this.machine.blockUntil(input).catch(() => undefined);
    await quotaRepo
      .blockUntil({ quotaKey: input.key, until: new Date(input.until), why: input.why })
      .catch((error: unknown) => {
        log.warn('could not record an upstream block', {
          key: input.key,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async blockedFor(input: { key: string; now: number }): Promise<number> {
    const [machine, installation] = await Promise.all([
      this.machine.blockedFor(input).catch(() => 0),
      quotaRepo.blockedFor(input.key).catch(() => 0),
    ]);
    // The longer of the two: either one saying wait is a reason to wait.
    return Math.max(machine, installation);
  }
}
