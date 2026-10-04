import { cpus, freemem, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';
import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { hosting } from '@xbam/database';
import {
  HEARTBEAT_EVERY_SEC,
  capacityFrom,
  daemonTick,
  hostMayAcceptTenants,
  thumbprintOf,
  type DaemonState,
  type MachineReport,
} from '@xbam/runtime';
import { PROVIDER_TIERS_ENABLED } from '@xbam/shared/contracts';
import { findBrowser } from '@xbam/browser';
import { startLoop } from './loop';

const log = createLogger('host-agent');

/**
 * What a machine says about itself when it is holding tenants.
 *
 * In the worker because the worker is the process that owns machines: it owns
 * the browsers already, and a guest is the same kind of thing. The API owns no
 * browsers and cannot measure a host any more than it can ask one whether
 * Chrome is alive.
 *
 * It is **off unless a host id is configured**, and that is deliberate rather
 * than a convenience. Every AI17Z installation runs this worker, and a host
 * agent that enabled itself would turn every laptop running the product into a
 * machine advertising capacity to a control plane. A host is a machine somebody
 * decided to offer.
 *
 * Three things it does and does not do.
 *
 * **Every number is measured, never configured.** `capacityFrom` subtracts the
 * host's own overhead from what the operating system reports, and a machine too
 * small to hold anything is refused with the figures rather than advertised
 * with zero slots. No capacity number in this product comes from a plan.
 *
 * **A revoked host stops.** It does not back off and try again later, because
 * a machine taken out of service that keeps calling home is indistinguishable
 * from one that was not taken out of service.
 *
 * **It accepts no work it cannot hold.** A tier that may not hold tenants is
 * refused here as well as in the scheduler, so a host whose provider tier was
 * widened in the database without the requirements being met does not quietly
 * start taking customers.
 *
 * It provisions nothing. Guests are `microVm.ts`, and nothing in this
 * repository has booted one: this agent reports a machine and applies no
 * assignment, which is why `acceptWork` is read and logged rather than acted
 * on.
 */
export class HostAgent {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickMs = envInt('AI17Z_HOST_HEARTBEAT_MS', HEARTBEAT_EVERY_SEC * 1_000);
  private readonly hostId = process.env.AI17Z_HOST_ID?.trim() ?? '';
  private stopped = false;

  /** Whether this installation was asked to be a host at all. */
  get configured(): boolean {
    return this.hostId.length > 0;
  }

  start(): void {
    if (this.timer) return;
    if (!this.configured) {
      // Said once, at debug level, because this is the ordinary case on every
      // installation and a warning about it would be noise on all of them.
      log.debug('host agent not configured', { detail: 'AI17Z_HOST_ID is unset, so this machine offers no capacity.' });
      return;
    }
    log.info('host agent starting', { hostId: this.hostId, everySec: Math.round(this.tickMs / 1_000) });
    // OPTIONAL rather than ESSENTIAL: a machine under memory pressure should
    // keep answering mentions and stop advertising how much room it has.
    this.timer = startLoop('host-agent', this.tickMs, () => this.tick(), 'OPTIONAL');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const host = await hosting.getHost(this.hostId);
      if (!host) {
        // Not a reason to retry for ever: a configured id that names nothing is
        // a configuration mistake, and saying so once is more use than saying
        // it every thirty seconds.
        log.warn('host agent stopping', { hostId: this.hostId, detail: 'No host node has that id.' });
        this.stopped = true;
        this.stop();
        return;
      }

      const decision = daemonTick(stateOf(host.state));
      if (!decision.keepRunning) {
        log.warn('host agent stopping', { hostId: this.hostId, detail: decision.detail });
        this.stopped = true;
        this.stop();
        return;
      }
      if (!decision.heartbeat) return;

      const report = await measure();
      const capacity = capacityFrom(report);
      if (!capacity.ok) {
        // Reported rather than rounded up to an offer of nothing. A host
        // advertising zero slots looks like a host that is full.
        log.warn('this machine cannot hold a runtime', { hostId: this.hostId, detail: capacity.why });
        return;
      }

      await hosting.heartbeat({
        id: this.hostId,
        capacity: capacity.capacity,
        // The heartbeat wants a string. "unknown" is a worse answer than a
        // version and a much better one than nothing, because a host whose
        // version nobody can read is a host that must not be given work for a
        // version it may not have.
        agentVersion: process.env.AI17Z_VERSION?.trim() || 'unknown',
      });

      const provider = await hosting.getProvider(host.providerId);
      const mayHold = provider ? hostMayAcceptTenants(provider.tier, PROVIDER_TIERS_ENABLED) : false;

      log.debug('host agent reported', {
        hostId: this.hostId,
        state: host.state,
        // Logged rather than acted on. Applying an assignment means booting a
        // guest, and nothing here has booted one.
        acceptWork: decision.acceptWork && mayHold,
        runtimeSlots: capacity.capacity.runtimeSlots,
        browserSlots: capacity.capacity.browserSlots,
        detail: mayHold ? decision.detail : 'This provider tier may not hold tenants yet.',
      });
    } catch (error) {
      log.warn('host agent tick failed', { hostId: this.hostId, message: errorMessage(error) });
    } finally {
      this.running = false;
    }
  }

  /**
   * The thumbprint this machine would enrol under.
   *
   * Exposed so a person offering a host can read it off this machine and
   * compare it with what the control plane recorded. Two independent sightings
   * of one identity, which is the rule the browser identity already follows.
   */
  static thumbprintFor(publicKeyJwk: Parameters<typeof thumbprintOf>[0]): string {
    return thumbprintOf(publicKeyJwk);
  }
}

function stateOf(state: string): DaemonState {
  if (state === 'REVOKED') return 'REVOKED';
  if (state === 'DRAINING') return 'DRAINING';
  if (state === 'ACTIVE') return 'ENROLLED';
  return 'OFFERING';
}

/**
 * Measures the machine, and says so honestly when it cannot.
 *
 * `freemem` is deliberately not used for the memory figure. What a host may
 * offer is a property of the machine rather than of whatever is running on it
 * this second, and a capacity that moved with free memory would make a host's
 * advertised size depend on when the heartbeat happened to land. Free memory is
 * the pressure question and `throttleFor` already answers it.
 */
async function measure(): Promise<MachineReport> {
  const browser = await browserPresent();
  return {
    totalMemoryMb: Math.floor(totalmem() / (1024 * 1024)),
    cpuCores: cpus().length,
    freeDiskGb: await freeDiskGb(),
    browserPresent: browser,
    region: process.env.AI17Z_HOST_REGION?.trim() || 'unset',
    runtimeVersions: [process.env.AI17Z_VERSION?.trim() || 'unknown'],
  };
}

/**
 * Free disk where this installation keeps its data.
 *
 * Zero when it cannot be read, which refuses the host rather than letting it
 * advertise room nobody measured. `statfs` is not available on every platform
 * and version, so the failure is expected rather than exceptional.
 */
async function freeDiskGb(): Promise<number> {
  const where = process.env.AI17Z_DATA_DIR?.trim() || process.cwd();
  try {
    const stats = await statfs(where);
    return Math.floor((Number(stats.bsize) * Number(stats.bavail)) / (1024 * 1024 * 1024));
  } catch (error) {
    log.debug('free disk could not be read', { where, message: errorMessage(error) });
    return 0;
  }
}

/**
 * Whether a real browser is present, asked rather than assumed.
 *
 * `findBrowser` refuses a binary whose version resource does not say Google
 * Chrome even at a Chrome-shaped path, which is exactly the answer wanted here:
 * a host advertising browser slots it cannot fill is worse than one advertising
 * none. A machine with no graphical session is a server, not a broken desktop,
 * and reports no browser slots rather than failing.
 */
async function browserPresent(): Promise<boolean> {
  try {
    const found = await findBrowser('GOOGLE_CHROME');
    // The binary has to say Google Chrome about itself. A Chrome-shaped path
    // holding something else is not a browser slot this host can fill.
    return found.product === 'Google Chrome' && found.executable.length > 0;
  } catch {
    return false;
  }
}

/** Unused free memory, for a log line only. Never for capacity. */
export function freeMemoryMb(): number {
  return Math.floor(freemem() / (1024 * 1024));
}
