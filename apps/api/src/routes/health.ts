import type { FastifyInstance } from 'fastify';
import type { HealthComponent, HealthReport } from '@xbam/shared/contracts';
import { buildVersion, describeVersion, nowIso } from '@xbam/shared';
import {
  accounts as accountsRepo,
  jobs as jobsRepo,
  pingDatabase,
  providers as providersRepo,
  users as usersRepo,
  workers as workersRepo,
  WORKER_PRESENT_SECONDS,
} from '@xbam/database';
import { getAdapter } from '@xbam/models';
import { browserEnabled } from '@xbam/browser';
import { getChannelAdapter, isChannelImplemented } from '@xbam/channels';
import { handler } from '../http';

/**
 * Whether any account has a browser a worker is still reporting on.
 *
 * The worker republishes its tabs every ten seconds; anything older than the
 * presence window describes a browser that is no longer there. This is the same
 * rule the account screen applies to the same snapshot, and there is one of it.
 */
async function browserRunning(): Promise<boolean> {
  return accountsRepo.anyFreshBrowserSession(WORKER_PRESENT_SECONDS);
}

/**
 * Component health. Optional components (local model servers, external channels)
 * report their own state but never make the platform itself look unhealthy.
 */
async function collect(): Promise<HealthReport> {
  const checkedAt = nowIso();
  const components: HealthComponent[] = [];

  // Which version this is. Without it, "have you updated?" and "which version
  // has the bug?" are both unanswerable, and both get asked constantly.
  components.push({
    name: 'API',
    status: 'healthy',
    detail: `Serving requests, ${describeVersion()}`,
    optional: false,
    kind: 'core',
    checkedAt,
  });

  const db = await pingDatabase();
  components.push({
    name: 'Database',
    status: db.ok ? 'healthy' : 'offline',
    detail: db.detail,
    optional: false,
    kind: 'core',
    checkedAt,
  });

  if (db.ok) {
    try {
      const counts = await jobsRepo.countJobsByStatus();
      const stuck = counts.RETRYABLE_FAILURE ?? 0;
      const review = (counts.REVIEW_REQUIRED ?? 0) + (counts.WAITING_FOR_APPROVAL ?? 0);
      components.push({
        name: 'Queue',
        status: 'healthy',
        detail: `${review} awaiting a person, ${stuck} retrying`,
        optional: false,
        kind: 'core',
        checkedAt,
      });
    } catch (error) {
      components.push({ name: 'Queue', status: 'degraded', detail: (error as Error).message, optional: false, kind: 'core', checkedAt });
    }

    // Whether anything is running that can actually do the work.
    //
    // Nothing here mentioned workers at all, so a stack whose worker had died
    // reported healthy: the API was serving, the database was up, the queue was
    // empty because nothing was claiming from it, and the account still said
    // CONNECTED because the process that would have noticed otherwise was the
    // one that was gone. This installation ran that way for four and a half
    // hours. A worker is not optional -- without one an agent does nothing at
    // all -- so its absence makes the platform offline rather than degraded.
    try {
      const present = await workersRepo.present();
      const browserCapable = present.filter((w) => w.browserCapable).length;
      components.push({
        name: 'Worker',
        status: present.length === 0 ? 'offline' : 'healthy',
        detail:
          present.length === 0
            ? `Nothing has checked in for ${WORKER_PRESENT_SECONDS} seconds. Jobs will queue and nothing will run them.`
            : `${present.length} running, ${browserCapable} of them able to drive a browser`,
        optional: false,
        kind: 'core',
        checkedAt,
      });
    } catch (error) {
      components.push({
        name: 'Worker',
        status: 'degraded',
        detail: (error as Error).message,
        optional: false,
        kind: 'core',
        checkedAt,
      });
    }

    for (const owner of await usersRepo.listUsers()) {
      for (const credential of await providersRepo.listProviders(owner.id)) {
        if (!credential.enabled) continue;
        const adapter = getAdapter(credential.provider);
        const usable = !adapter.requiresApiKey || credential.hasKey;
        // A provider that was tested and failed is offline, not unknown.
        const status = !usable
          ? 'degraded'
          : credential.lastStatus === 'healthy'
            ? 'healthy'
            : credential.lastStatus
              ? 'offline'
              : 'unknown';
        components.push({
          name: `${credential.label} (${credential.provider})`,
          status,
          detail: usable ? (credential.lastStatus ?? 'Not tested yet') : 'No API key stored',
          optional: true,
          kind: 'provider',
          checkedAt,
        });
      }
      for (const account of await accountsRepo.listAccounts(owner.id)) {
        if (!account.enabled) continue;
        // Channels without a browser session have nothing to connect; an enabled
        // mock account is ready by definition and should not read as degraded.
        const sessionless = isChannelImplemented(account.channel) && !getChannelAdapter(account.channel).requiresBrowser;
        components.push({
          name: `${account.channel} @${account.handle}`,
          status: sessionless
            ? 'healthy'
            : account.status === 'CONNECTED'
              ? 'healthy'
              : account.status === 'ERROR'
                ? 'offline'
                : 'degraded',
          detail: sessionless ? 'No session required' : (account.lastHealthStatus ?? account.status),
          optional: true,
          kind: 'account',
          checkedAt,
        });
      }
    }
  }

  // The API owns no browsers, so it cannot count its own sessions and must not
  // try. `activeSessionCount()` in this process is structurally always zero,
  // and reporting that as "healthy, 0 live sessions" said nothing true about
  // any browser anywhere. What the worker publishes is the only evidence there
  // is, and a snapshot nobody has refreshed describes a browser that has closed.
  components.push({
    name: 'Browser',
    status: !browserEnabled() ? 'offline' : (await browserRunning()) ? 'healthy' : 'degraded',
    detail: !browserEnabled()
      ? 'Disabled by configuration'
      : (await browserRunning())
        ? 'A worker is reporting live tabs'
        : 'No worker has reported a live browser recently',
    optional: true,
    kind: 'browser',
    checkedAt,
  });

  const required = components.filter((c) => !c.optional);
  const status = required.some((c) => c.status === 'offline')
    ? 'offline'
    : required.some((c) => c.status === 'degraded')
      ? 'degraded'
      : 'healthy';

  return { status, components, checkedAt };
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health/live', async (_request, reply) => reply.send({ ok: true, data: { alive: true } }));
  app.get('/api/health', handler(async () => collect()));
}
