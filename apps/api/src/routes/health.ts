import type { FastifyInstance } from 'fastify';
import type { HealthComponent, HealthReport } from '@xbam/shared/contracts';
import { nowIso } from '@xbam/shared';
import { accounts as accountsRepo, jobs as jobsRepo, pingDatabase, providers as providersRepo, users as usersRepo } from '@xbam/database';
import { getAdapter } from '@xbam/models';
import { browserEnabled, activeSessionCount } from '@xbam/browser';
import { handler } from '../http';

/**
 * Component health. Optional components (local model servers, external channels)
 * report their own state but never make the platform itself look unhealthy.
 */
async function collect(): Promise<HealthReport> {
  const checkedAt = nowIso();
  const components: HealthComponent[] = [];

  components.push({ name: 'API', status: 'healthy', detail: 'Serving requests', optional: false, checkedAt });

  const db = await pingDatabase();
  components.push({
    name: 'Database',
    status: db.ok ? 'healthy' : 'offline',
    detail: db.detail,
    optional: false,
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
        checkedAt,
      });
    } catch (error) {
      components.push({ name: 'Queue', status: 'degraded', detail: (error as Error).message, optional: false, checkedAt });
    }

    for (const owner of await usersRepo.listUsers()) {
      for (const credential of await providersRepo.listProviders(owner.id)) {
        if (!credential.enabled) continue;
        const adapter = getAdapter(credential.provider);
        const usable = !adapter.requiresApiKey || credential.hasKey;
        components.push({
          name: `${credential.label} (${credential.provider})`,
          status: usable ? (credential.lastStatus === 'healthy' ? 'healthy' : 'unknown') : 'degraded',
          detail: usable ? (credential.lastStatus ?? 'Not tested yet') : 'No API key stored',
          optional: true,
          checkedAt,
        });
      }
      for (const account of await accountsRepo.listAccounts(owner.id)) {
        if (!account.enabled) continue;
        components.push({
          name: `${account.channel} @${account.handle}`,
          status:
            account.status === 'CONNECTED' ? 'healthy' : account.status === 'ERROR' ? 'offline' : 'degraded',
          detail: account.lastHealthStatus ?? account.status,
          optional: true,
          checkedAt,
        });
      }
    }
  }

  components.push({
    name: 'Browser',
    status: browserEnabled() ? 'healthy' : 'offline',
    detail: browserEnabled() ? `${activeSessionCount()} live session(s)` : 'Disabled by configuration',
    optional: true,
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
