import { rm } from 'node:fs/promises';
import { createLogger, envInt, errorMessage } from '@xbam/shared';
import {
  accountCredentials,
  accountLease,
  accounts as accountsRepo,
  browserTasks,
  ops,
  type BrowserTaskRow,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import {
  captureScreenshot,
  closeSession,
  resolveProfileDir,
  leaseSession,
  shutdownBrowser,
  runBrowserPreflight,
  safeUrl,
  sessionIdentity,
} from '@xbam/browser';
import { buildChannelContext, ingestNormalizedEvent, storageDir } from '@xbam/runtime';
import { startLoop } from './loop';

const log = createLogger('browser-tasks');

/**
 * How long an open sign-in window is watched before it is called abandoned.
 * Generous: a person may have to find a password manager, a phone, or a key.
 */
const SIGN_IN_WINDOW_MS = envInt('AI17Z_SIGNIN_WINDOW_MS', 15 * 60_000);

/**
 * Executes the browser intents recorded by the API.
 *
 * The worker is the only process that opens a browser, which is what makes
 * "connect", "test session", and "open sign-in window" safe to expose as
 * buttons: they cannot collide with a running job over the same profile.
 */
export class BrowserTaskRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs = envInt('AI17Z_BROWSER_TASK_POLL_MS', 2_000);

  constructor(readonly workerId: string) {}

  start(): void {
    if (this.timer) return;
    this.timer = startLoop('browser-tasks', this.intervalMs, () => this.tick());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const task = await browserTasks.claimBrowserTask(this.workerId);
      if (!task) return;
      log.info('running browser task', { kind: task.kind, accountId: task.accountId });
      try {
        // Preflight belongs to the machine, not an account, so it takes no lease.
        if (task.accountId === null) {
          await browserTasks.finishBrowserTask(task.id, 'COMPLETED', await this.executeSystem(task));
          return;
        }

        // Same profile, same rule: one operation at a time.
        const accountId = task.accountId;
        const outcome = await accountLease.withAccountLease(
          { accountId, workerId: this.workerId, reason: `browser task ${task.kind}`, ttlMs: 11 * 60_000 },
          () => this.execute(task),
        );
        if (!outcome.held) {
          await browserTasks.finishBrowserTask(
            task.id,
            'FAILED',
            null,
            `The account is busy with ${outcome.heldBy?.reason ?? 'another operation'}. Try again once it finishes.`,
          );
          return;
        }
        await browserTasks.finishBrowserTask(task.id, 'COMPLETED', outcome.value);
      } catch (error) {
        const message = errorMessage(error);
        log.warn('browser task failed', { kind: task.kind, message });
        await browserTasks.finishBrowserTask(task.id, 'FAILED', null, message);
        if (task.accountId === null) return;
        await accountsRepo
          .updateAccount(task.accountId, {
            status: 'ERROR',
            lastError: message.slice(0, 500),
            lastHealthStatus: message.slice(0, 200),
            touchHealthCheck: true,
          })
          .catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  /** Machine-level checks that belong to no account. */
  private async executeSystem(task: BrowserTaskRow): Promise<Record<string, unknown>> {
    if (task.kind === 'PREFLIGHT') {
      const report = await runBrowserPreflight();
      return report as unknown as Record<string, unknown>;
    }
    return { detail: `${task.kind} needs an account.` };
  }

  /**
   * Copies the identity of the browser now serving an account into the session
   * row, so diagnostics can show the executable, version and pid.
   */
  private async recordIdentityFor(accountId: string): Promise<void> {
    const identity = sessionIdentity(accountId);
    if (!identity) return;
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

  private async execute(task: BrowserTaskRow): Promise<Record<string, unknown>> {
    const account = await accountsRepo.requireAccount(task.accountId!);
    const adapter = getChannelAdapter(account.channel);
    const ctx = await buildChannelContext(account, null);
    // Never trust a path written by a worker on another filesystem.
    const profileDir = resolveProfileDir(account.id, ctx.session?.profileDir);
    const mode = ctx.session?.mode ?? 'MANAGED';
    const channel = ctx.session?.channel ?? null;
    const engine = ctx.session?.engine ?? 'GOOGLE_CHROME';

    switch (task.kind) {
      case 'CONNECT': {
        const result = await adapter.connect(ctx);
        // Whatever the adapter just used, record what it actually was. A claim
        // of "real Chrome" that nobody can check is a claim taken on trust.
        await this.recordIdentityFor(account.id);
        await accountsRepo.updateAccount(account.id, {
          status: result.status,
          lastHealthStatus: result.detail.slice(0, 200),
          lastError: result.status === 'CONNECTED' ? null : result.detail.slice(0, 500),
          touchHealthCheck: true,
          ...(result.remoteAccountId ? { remoteAccountId: result.remoteAccountId } : {}),
        });
        await accountsRepo.upsertBrowserSession({
          accountId: account.id,
          mode,
          channel,
          profileDir,
          cdpUrl: ctx.session?.cdpUrl ?? null,
          status: result.status,
          lastError: result.status === 'CONNECTED' ? null : result.detail,
        });
        return { status: result.status, detail: result.detail, handle: result.handle ?? null };
      }

      case 'HEALTH_CHECK': {
        const health = await adapter.healthCheck(ctx);
        // Distinguishing these two matters: an expired session means the profile
        // is fine and someone needs to sign in again, while NEEDS_AUTH means
        // there was never a session to begin with.
        const signedOut = account.status === 'CONNECTED' ? 'SESSION_EXPIRED' : 'NEEDS_AUTH';

        // Who it is signed in as, checked against who this account says it is.
        //
        // A mismatch is not cosmetic. Mention search runs `@handle`, the
        // engagement heuristic decides "addressed to this account" from it, and
        // own-thread tracking follows it -- so an account whose stored handle
        // is not the signed-in one searches for somebody else's mentions and
        // never recognises being spoken to. Nothing else would ever notice:
        // every poll succeeds, and every poll finds nothing.
        const live = health.handle?.replace(/^@+/, '').toLowerCase() ?? null;
        const stored = account.handle?.replace(/^@+/, '').toLowerCase() ?? null;
        const mismatched = Boolean(live && stored && live !== stored);
        // Adopt the live handle when this account has never had a real one.
        const adopt = Boolean(live && !stored);

        await accountsRepo.updateAccount(account.id, {
          status: health.authenticated
            ? mismatched
              ? 'ERROR'
              : 'CONNECTED'
            : health.status === 'offline'
              ? 'ERROR'
              : signedOut,
          ...(adopt ? { handle: health.handle!.replace(/^@+/, '') } : {}),
          lastHealthStatus: mismatched
            ? `Signed in as @${live}, but this account is set up as @${stored}.`
            : health.detail.slice(0, 200),
          lastError: mismatched
            ? `This browser is signed in as @${live}, and the account is configured as @${stored}. ` +
              `Everything that looks for mentions searches for @${stored}, so nothing will be found. ` +
              `Either sign in as @${stored}, or connect @${live} as its own account.`
            : health.status === 'healthy'
              ? null
              : health.detail.slice(0, 500),
          touchHealthCheck: true,
        });
        await accountsRepo.upsertBrowserSession({
          accountId: account.id,
          mode,
          channel,
          profileDir,
          cdpUrl: ctx.session?.cdpUrl ?? null,
          status: health.status,
          lastError: health.status === 'healthy' ? null : health.detail,
        });
        return { status: health.status, detail: health.detail, authenticated: health.authenticated, handle: health.handle ?? null };
      }

      case 'OPEN_AUTH': {
        // Opens a real window on the account profile and leaves it open so the
        // person signs in themselves. This path touches nothing in it and never
        // reads a credential -- typing stored details is CREDENTIAL_SIGN_IN, a
        // different task, so that the two can never be confused for each other.
        //
        // Launching a browser on a cold profile is slow enough to look broken,
        // so the state is written before the launch rather than after it.
        await accountsRepo.updateAccount(account.id, {
          status: 'STARTING_BROWSER',
          lastHealthStatus: 'Starting a browser.',
          lastError: null,
          challengeKind: null,
          touchHealthCheck: true,
        });

        const session = await leaseSession({ accountId: account.id, engine, mode, profileDir, cdpUrl: ctx.session?.cdpUrl ?? null, channel, headless: false });
        try {
          await session.page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 });
        } finally {
          await session.release();
        }

        // Record what actually launched, whichever task opened it.
        await this.recordIdentityFor(account.id);

        const deadline = new Date(Date.now() + SIGN_IN_WINDOW_MS);
        await accountsRepo.updateAccount(account.id, {
          status: 'AWAITING_LOGIN',
          lastHealthStatus: 'Waiting for you to sign in.',
          authStartedAt: new Date().toISOString(),
          authDeadlineAt: deadline.toISOString(),
          touchHealthCheck: true,
        });
        return {
          detail: 'A browser window is open on the sign-in page. Sign in there; this page follows along on its own.',
          deadline: deadline.toISOString(),
        };
      }

      case 'CANCEL_AUTH': {
        // Closes the window and puts the account back where it was, rather than
        // leaving it in a step that is no longer happening.
        await closeSession(account.id).catch(() => undefined);
        await accountsRepo.updateAccount(account.id, {
          status: 'NEEDS_AUTH',
          lastHealthStatus: 'Sign-in cancelled.',
          authStartedAt: null,
          authDeadlineAt: null,
          challengeKind: null,
          touchHealthCheck: true,
        });
        return { detail: 'Sign-in cancelled and the window closed.' };
      }

      case 'CREDENTIAL_SIGN_IN': {
        // The opt-in path. Everything about it is explicit: an owner stored
        // details, an owner pressed the button, and the task that does it has
        // its own name so that opening a window and typing into one are never
        // the same operation.
        if (!adapter.signInWithCredentials) {
          throw new Error(`The ${adapter.displayName} channel cannot sign in with stored details.`);
        }

        // Read here rather than carried in the task. `browser_tasks.params` is
        // persisted in the clear and shown in the panel's task history, so a
        // password must never travel that way.
        const login = await accountCredentials.getDecryptedLogin(account.id);
        if (!login) {
          throw new Error(
            'No sign-in details are stored for this account. Add them in the session panel, or use Open sign-in and sign in yourself.',
          );
        }

        // Written before the launch, for the same reason OPEN_AUTH does it: a
        // cold profile takes long enough that saying nothing looks broken.
        await accountsRepo.updateAccount(account.id, {
          status: 'STARTING_BROWSER',
          lastHealthStatus: 'Starting a browser to sign in.',
          lastError: null,
          challengeKind: null,
          authStartedAt: new Date().toISOString(),
          touchHealthCheck: true,
        });

        const { observation, filled } = await adapter.signInWithCredentials(ctx, login);
        await this.recordIdentityFor(account.id);

        if (observation.state === 'SIGNED_IN') {
          await accountsRepo.updateAccount(account.id, {
            status: 'CONNECTED',
            lastHealthStatus: 'Signed in with the stored details.',
            lastError: null,
            authStartedAt: null,
            authDeadlineAt: null,
            challengeKind: null,
            touchHealthCheck: true,
          });
          return { state: observation.state, detail: 'Signed in.', filled };
        }

        if (observation.state === 'CHALLENGE') {
          // Exactly where a hand sign-in ends up, and for the same reason. The
          // window is left open on whatever X is asking for, nothing further is
          // typed, and the watcher does not poll this state.
          await ops.createDiagnostic({
            accountId: account.id,
            channel: account.channel,
            kind: 'auth_challenge',
            url: null,
            message: `${observation.detail} AI17Z stopped and left the window open.`,
          });
          await accountsRepo.updateAccount(account.id, {
            status: 'CHALLENGE_REQUIRES_USER',
            challengeKind: observation.challengeKind ?? 'unknown',
            lastHealthStatus: observation.detail.slice(0, 200),
            authDeadlineAt: null,
            touchHealthCheck: true,
          });
          return { state: observation.state, detail: observation.detail, filled };
        }

        if (observation.state === 'UNREACHABLE') {
          await accountsRepo.updateAccount(account.id, {
            status: 'NEEDS_AUTH',
            lastError: null,
            lastHealthStatus: 'The sign-in window went away before it finished.',
            authStartedAt: null,
            authDeadlineAt: null,
            touchHealthCheck: true,
          });
          return { state: observation.state, detail: observation.detail, filled };
        }

        // Still on the form: either X did not accept what was stored, or it is
        // taking longer than this task waits. Neither is a failure worth
        // throwing over -- the window is open, so it becomes an ordinary
        // sign-in with a deadline and the watcher carries it from here.
        const deadline = new Date(Date.now() + SIGN_IN_WINDOW_MS);
        await accountsRepo.updateAccount(account.id, {
          status: 'AWAITING_LOGIN',
          lastHealthStatus: observation.detail.slice(0, 200),
          authDeadlineAt: deadline.toISOString(),
          touchHealthCheck: true,
        });
        return {
          state: observation.state,
          detail: observation.detail,
          filled,
          deadline: deadline.toISOString(),
        };
      }

      case 'SCREENSHOT': {
        const session = await leaseSession({ accountId: account.id, engine, mode, profileDir, cdpUrl: ctx.session?.cdpUrl ?? null, channel, headless: true });
        try {
          const shot = await captureScreenshot(session.page, storageDir(), 'manual_capture');
          if (!shot) return { detail: 'Could not capture a screenshot from the current page.' };
          const artifact = await ops.createArtifact({
            kind: 'SCREENSHOT',
            accountId: account.id,
            mimeType: 'image/png',
            relPath: shot.relPath,
            bytes: shot.bytes,
            meta: { url: shot.url },
          });
          await ops.createDiagnostic({
            accountId: account.id,
            channel: account.channel,
            kind: 'manual_capture',
            url: safeUrl(session.page),
            message: 'Manual screenshot requested from the session panel.',
            artifactId: artifact.id,
          });
          return { artifactId: artifact.id, url: shot.url, detail: 'Screenshot captured.' };
        } finally {
          await session.release();
        }
      }

      case 'DISCONNECT': {
        await adapter.disconnect(ctx);
        // Severing the account forgets the password with it. Storing one is a
        // decision about a connection, so it does not outlive the connection.
        const forgotten = await accountCredentials.clearCredentials(account.id);
        await accountsRepo.updateAccount(account.id, { status: 'DISCONNECTED', lastHealthStatus: 'Disconnected' });
        return {
          detail: forgotten
            ? 'Browser session closed and the stored sign-in details deleted.'
            : 'Browser session closed.',
          credentialsCleared: forgotten,
        };
      }

      case 'SHUTDOWN_BROWSER': {
        // What "stop the agent" has to mean: the window goes, and its renderers
        // with it. Detaching leaves a signed-in Chrome sitting on the desktop.
        const outcome = await shutdownBrowser(account.id, profileDir);
        await accountsRepo.updateAccount(account.id, {
          // The account is still connected in the sense that matters: the
          // session lives in the profile and comes back on the next launch.
          lastHealthStatus: outcome.detail.slice(0, 200),
          touchHealthCheck: true,
        });
        await accountsRepo.recordBrowserTabs(account.id, []).catch(() => undefined);
        return outcome as unknown as Record<string, unknown>;
      }

      case 'CLEAR': {
        // Removes the stored profile entirely, which signs the account out.
        await closeSession(account.id).catch(() => undefined);
        await rm(profileDir, { recursive: true, force: true });
        await accountsRepo.clearBrowserSession(account.id);
        // And any stored sign-in details with it. Leaving a password behind
        // after a button labelled "Clear session" is the kind of surplus secret
        // nobody remembers is there; the panel says this will happen.
        const forgotten = await accountCredentials.clearCredentials(account.id);
        await accountsRepo.updateAccount(account.id, {
          status: 'NEEDS_AUTH',
          lastHealthStatus: 'Session cleared',
          lastError: null,
          touchHealthCheck: true,
        });
        return {
          detail: forgotten
            ? 'Stored browser session and sign-in details deleted. Sign in again to reconnect.'
            : 'Stored browser session deleted. Sign in again to reconnect.',
          credentialsCleared: forgotten,
        };
      }

      case 'INGEST': {
        const events = await adapter.ingestEvents(ctx, { limit: 10 });
        let created = 0;
        for (const event of events) {
          const outcome = await ingestNormalizedEvent({ accountId: account.id, event });
          created += outcome.jobs.filter((j) => j.created).length;
        }
        await accountsRepo.updateAccount(account.id, { touchActivity: created > 0, touchHealthCheck: true });
        return { found: events.length, jobsCreated: created };
      }

      default:
        return { detail: `Unknown task kind: ${task.kind}` };
    }
  }
}
