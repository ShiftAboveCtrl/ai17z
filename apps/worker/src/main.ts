import { hostname } from 'node:os';
import { createLogger, envInt, envString, errorMessage, loadEnv } from '@xbam/shared';
import {
  accounts as accountsRepo,
  browserTasks,
  closePool,
  content,
  pingDatabase,
  workers as workersRepo,
} from '@xbam/database';
import { JobWorker, capabilitiesFor, type WorkerRole } from '@xbam/jobs';
import { bootstrapRuntime, runJob } from '@xbam/runtime';
import { activeSessionAccountIds, closeAllSessions, sessionIdentity, sessionTabs } from '@xbam/browser';
import { ChannelPoller } from './poller';
import { SignInWatcher } from './signIn';
import { SocialRadar } from './radar';
import { PersonaSyncRunner } from './personaSync';
import { listPersonaSourceAdapters } from '@xbam/persona';
import { BrowserTaskRunner } from './browserTasks';
import { PostScheduler } from './posting';
import { startLoop } from './loop';
import { superviseSession } from '@xbam/browser';

loadEnv();
const log = createLogger('worker');

async function main(): Promise<void> {
  const ping = await pingDatabase();
  if (!ping.ok) throw new Error(`Database is not reachable: ${ping.detail}`);
  log.info('database connected', { detail: ping.detail });

  await bootstrapRuntime();

  const workerId = envString('AI17Z_WORKER_ID', `${hostname()}-${process.pid}`);

  // A containerised worker has no browser and no display, so it must not claim
  // browser-backed work. Run a second worker natively with role=browser for that.
  const role = (envString('AI17Z_WORKER_ROLE', 'all') as WorkerRole) ?? 'all';
  if (!['jobs', 'browser', 'all'].includes(role)) {
    throw new Error(`AI17Z_WORKER_ROLE must be jobs, browser, or all (got "${role}").`);
  }
  const capabilities = capabilitiesFor(role);
  const worker = new JobWorker(
    {
      workerId,
      concurrency: envInt('AI17Z_WORKER_CONCURRENCY', 2),
      pollIntervalMs: envInt('AI17Z_WORKER_POLL_MS', 750),
      leaseMs: envInt('AI17Z_JOB_LEASE_MS', 120_000),
      role,
    },
    (job) => runJob(job, workerId),
  );

  // Channel polling and browser tasks both drive a browser, so they belong to
  // whichever worker can actually open one.
  // Announce what this worker can do before it starts, so the API can tell
  // somebody "nothing here can open a browser" instead of queueing a task that
  // waits for a worker which does not exist.
  const announce = async () => {
    // Availability is answered by the process that would do the work, not by
    // whichever one happens to be asked. The API container has no twscrape and
    // no browser; saying so from there was the wrong answer to the question.
    const tools: Record<string, { available: boolean; detail: string }> = {};
    for (const adapter of listPersonaSourceAdapters()) {
      const state = await adapter.availability().catch(() => null);
      if (state) tools[`persona:${adapter.kind}`] = { available: state.available, detail: state.detail };
    }

    await workersRepo
      .heartbeat({ id: workerId, role, ...capabilities, hostname: hostname(), tools })
      .catch((e) => log.warn('heartbeat failed', { message: errorMessage(e) }));
  };
  await announce();
  const heartbeat = startLoop('heartbeat', 60_000, announce);

  /**
   * Frees browser tasks nothing is going to finish.
   *
   * Runs on every worker, not only browser-capable ones, because the failure
   * that strands an account is a task queued while no browser worker exists —
   * and a sweep that only runs on a browser worker never runs then. Freeing a
   * stuck row needs a database, not a browser.
   */
  const sweep = async () => {
    try {
      const freed = await browserTasks.recoverStaleBrowserTasks();
      if (freed.abandoned > 0 || freed.unclaimed > 0) log.info('freed stuck browser tasks', freed);
    } catch (error) {
      log.warn('browser task sweep failed', { message: errorMessage(error) });
    }
    try {
      // The same shape of problem one table over: an idea is claimed before a
      // post is drafted, and every way that draft can end without publishing
      // used to leave the idea claimed for ever.
      const ideas = await content.reconcileDrafting();
      if (ideas.released > 0 || ideas.discarded > 0 || ideas.used > 0) log.info('reconciled content ideas', { ...ideas });
    } catch (error) {
      log.warn('content idea sweep failed', { message: errorMessage(error) });
    }
  };
  await sweep();
  const sweeper = startLoop('recovery-sweep', 60_000, sweep);

  /**
   * Publishes what each account's three tabs are doing.
   *
   * The API owns no browsers, so this process is the only one that can answer
   * it. Ten seconds is fast enough that a tab someone closed shows as missing
   * before they have finished wondering why nothing arrived, and cheap enough
   * to be a single UPDATE per open browser.
   */
  const published = new Set<string>();
  const publishTabs = async () => {
    const live = new Set(activeSessionAccountIds());
    for (const accountId of live) {
      // Ask before reporting. Publishing the cached tab map says a tab is
      // READY because a handle exists, and a renderer killed for memory leaves
      // exactly that: an open tab that answers nothing. The probe is a trivial
      // evaluation per tab, and anything that fails it is rebuilt here rather
      // than discovered when a mention goes unanswered for four hours.
      const verdict = await superviseSession(accountId).catch(() => null);
      if (verdict && !verdict.usable) {
        log.warn('browser is not usable', { accountId, detail: verdict.detail, remedy: verdict.remedy });
      }
      await accountsRepo.recordBrowserTabs(accountId, sessionTabs(accountId)).catch(() => undefined);
      // Identity alongside the tabs, from the same live session. Recording it
      // only on browser tasks left the account page naming a pid and a port
      // from some earlier browser while the tabs described the current one.
      const identity = sessionIdentity(accountId);
      if (identity) {
        await accountsRepo
          .recordBrowserIdentity({
            accountId,
            executablePath: identity.executablePath,
            browserProduct: identity.product,
            browserVersion: identity.version,
            browserPid: identity.pid,
            cdpProduct: identity.cdpProduct,
            cdpUrl: identity.cdpUrl,
          })
          .catch(() => undefined);
      }
      published.add(accountId);
    }
    // An account whose browser has gone needs one last write, or the page keeps
    // showing three healthy tabs for a browser that closed an hour ago.
    for (const accountId of published) {
      if (live.has(accountId)) continue;
      await accountsRepo.recordBrowserTabs(accountId, sessionTabs(accountId)).catch(() => undefined);
      published.delete(accountId);
    }
  };
  const tabReporter = capabilities.browserCapable ? startLoop('tab-health', 10_000, publishTabs) : null;

  const poller = new ChannelPoller();
  const browserTaskRunner = new BrowserTaskRunner(workerId);
  const signIns = new SignInWatcher();
  const socialRadar = new SocialRadar();
  // Persona syncs run on every worker, not only browser-capable ones: what they
  // need is a command on PATH, which is a different capability from a display.
  const personaSync = new PersonaSyncRunner(workerId);
  personaSync.start();
  // Deciding to post needs a database and a model; only sending it needs a
  // browser, and the job queue routes that to a worker that has one.
  const posts = new PostScheduler();
  posts.start();
  await worker.start();
  if (capabilities.browserCapable) {
    poller.start();
    browserTaskRunner.start();
    signIns.start();
    socialRadar.start();
  }
  log.info('worker ready', { workerId, role, ...capabilities });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    clearInterval(heartbeat);
    clearInterval(sweeper);
    if (tabReporter) clearInterval(tabReporter);
    // Withdraw immediately rather than waiting for the heartbeat to lapse: a
    // clean shutdown knows it is leaving.
    await workersRepo.goodbye(workerId).catch(() => undefined);
    // One last honest snapshot before the browsers go.
    await publishTabs().catch(() => undefined);
    poller.stop();
    browserTaskRunner.stop();
    signIns.stop();
    socialRadar.stop();
    personaSync.stop();
    posts.stop();
    await worker.stop();
    await closeAllSessions().catch((e) => log.warn('browser cleanup failed', { message: errorMessage(e) }));
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  log.error('worker failed to start', { message: errorMessage(error) });
  await closePool().catch(() => undefined);
  process.exit(1);
});
