import type { FastifyInstance } from 'fastify';
import type { HealthComponent, HealthReport } from '@xbam/shared/contracts';
import {
  currentBudget,
  currentPressure,
  describeBudget,
  describeVersion,
  nowIso,
  workerAbsenceSentence,
} from '@xbam/shared';
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
            ? workerAbsenceSentence(WORKER_PRESENT_SECONDS)
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
  // Which part is not ready, rather than one sentence for every reason.
  //
  // A browser that has not started yet and a browser that has gone look
  // identical from here unless somebody asks whether the worker is running --
  // and the worker is the thing that owns browsers. Reported from a real Mac as
  // "the Chrome launcher broke in the update"; it had not, the containers were
  // still rebuilding, and the screen had no way to say so.
  const browserState = await (async (): Promise<{ status: 'healthy' | 'degraded' | 'offline'; detail: string }> => {
    if (!browserEnabled()) return { status: 'offline', detail: 'Disabled by configuration' };
    if (await browserRunning()) return { status: 'healthy', detail: 'Ready. A worker is reporting live tabs.' };

    const workers = await workersRepo.present().catch(() => []);
    if (workers.length === 0) {
      // Degraded rather than offline: nothing is broken, something has not
      // happened yet, and the first start after an update rebuilds every
      // container before the worker exists at all.
      return {
        status: 'degraded',
        detail: 'Starting. No worker has reported in yet — after an update this takes a few minutes while the containers rebuild.',
      };
    }
    return {
      status: 'degraded',
      detail: 'Waiting for Chrome. A worker is running and has not opened a browser yet.',
    };
  })();

  components.push({
    name: 'Browser',
    status: browserState.status,
    detail: browserState.detail,
    optional: true,
    kind: 'browser',
    checkedAt,
  });

  /*
    What this machine can afford, and whether it currently can.

    A row rather than a number buried in diagnostics, because the failure it
    describes is one an owner meets as "my monitors stopped". Chrome runs out
    of memory, AI17Z recycles the tab, and without this the only visible
    evidence is a run of failed polls -- which is what happened on 2026-09-15
    and took a CDP probe to explain.

    It reports what AI17Z decided, not raw operating system numbers: `freemem`
    means different things on different platforms and a precise figure implies
    a precision it does not have. A platform that will not answer is reported
    as running normally rather than as a problem.
  */
  const budget = currentBudget();
  const pressure = currentPressure();
  components.push({
    name: 'Memory',
    status: pressure === 'CRITICAL' ? 'degraded' : 'healthy',
    detail:
      pressure === 'NORMAL'
        ? `Normal. ${describeBudget(budget, pressure)}`
        : pressure === 'PRESSURED'
          ? `Memory is tight, so AI17Z is running less in the background. ${describeBudget(budget, pressure)}`
          : `Memory is very tight, so AI17Z has paused background work to keep the browser alive. ${describeBudget(budget, pressure)}`,
    optional: true,
    kind: 'browser',
    checkedAt,
  });

  // How AI17Z reads X, and what that depends on.
  //
  // Reported from what is already known rather than by probing X: asking the
  // structured reader whether it works means making a request to somebody
  // else's service, and doing that on every health poll is the definition of
  // hammering. So this says what the readers are and what they need -- the
  // browser -- and the readers report their own state the first time something
  // actually uses them.
  //
  // It is a row at all because "learn from this account did nothing" was
  // impossible to diagnose from a screen that never mentioned how X is read.
  components.push({
    name: 'Reading X',
    status: browserState.status === 'healthy' ? 'healthy' : browserState.status === 'offline' ? 'offline' : 'degraded',
    detail:
      browserState.status === 'healthy'
        ? "X is read through the signed-in browser: X's own data first, the rendered page as a fallback."
        : `X is read through the signed-in browser, which is not ready. ${browserState.detail}`,
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
