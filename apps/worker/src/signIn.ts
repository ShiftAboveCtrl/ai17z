import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { accounts as accountsRepo, ops } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { buildChannelContext } from '@xbam/runtime';
import { startLoop } from './loop';

const log = createLogger('sign-in');

/**
 * Watches sign-ins that a person is completing in an open browser window.
 *
 * A sign-in used to end the moment the window opened: the account was marked
 * NEEDS_AUTH and whoever opened it had to remember to come back and press Test
 * session. This follows it instead, so the account arrives at CONNECTED,
 * CHALLENGE_REQUIRES_USER, or TIMEOUT on its own and the screen says which.
 *
 * The watcher only ever looks. When the service asks for a code, a CAPTCHA, a
 * key, or confirmation that the sign-in was really the owner, the wait stops and
 * the window is left exactly as it is for the person to finish. Nothing here
 * types into, clicks through, or dismisses a security challenge.
 */
export class SignInWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /**
   * Slow on purpose. Each check drives a real browser page, and a person typing
   * a password does not need to be watched more often than this.
   */
  private readonly intervalMs = envInt('AI17Z_SIGNIN_POLL_MS', 4_000);

  /**
   * Set the moment shutdown begins, and read before anything is written.
   *
   * Stopping used to clear the interval and return, leaving a check already in
   * flight against a browser the shutdown was about to close. Observed on a
   * Mac: an account sat in AWAITING_LOGIN with the Chrome window still open, an
   * `ai17z restart` arrived, and nine milliseconds after SIGTERM the account
   * was marked NEEDS_AUTH -- "The sign-in window was closed before it
   * finished." Nobody had closed anything. `closeAllSessions()` detached CDP
   * under the running check, the adapter correctly read that as UNREACHABLE,
   * and the watcher wrote it down.
   */
  private stopping = false;
  /** A check already running, so stopping can wait for it rather than race it. */
  private inFlight: Promise<void> | null = null;

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = startLoop('sign-in', this.intervalMs, () => this.tick());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Awaited, so the browsers are not pulled out from under a check that is
    // halfway through reading a page.
    await this.inFlight?.catch(() => undefined);
  }

  async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    const work = (async () => {
      for (const account of await accountsRepo.accountsAwaitingSignIn()) {
        if (this.stopping) return;
        await this.check(account.id).catch((error) =>
          log.warn('sign-in check failed', { accountId: account.id, message: errorMessage(error) }),
        );
      }
    })();
    this.inFlight = work;
    try {
      await work;
    } finally {
      this.inFlight = null;
      this.running = false;
    }
  }

  private async check(accountId: string): Promise<void> {
    const account = await accountsRepo.getAccount(accountId);
    if (!account) return;

    // The deadline is checked before the browser is touched, so an abandoned
    // window is closed out even if the page itself has stopped responding.
    if (account.authDeadlineAt && new Date(account.authDeadlineAt).getTime() <= Date.now()) {
      await accountsRepo.updateAccount(accountId, {
        status: 'TIMEOUT',
        lastHealthStatus: 'Nobody finished signing in before the window expired.',
        authStartedAt: null,
        authDeadlineAt: null,
        touchHealthCheck: true,
      });
      log.info('sign-in timed out', { handle: account.handle });
      return;
    }

    const adapter = getChannelAdapter(account.channel);
    if (!adapter.observeAuth) return;

    const ctx = await buildChannelContext(account, null);
    const seen = await adapter.observeAuth(ctx);

    switch (seen.state) {
      case 'SIGNED_IN':
        await accountsRepo.updateAccount(accountId, {
          status: 'CONNECTED',
          lastHealthStatus: 'Signed in.',
          lastError: null,
          authStartedAt: null,
          authDeadlineAt: null,
          challengeKind: null,
          touchHealthCheck: true,
          ...(seen.handle ? { displayName: account.displayName } : {}),
        });
        log.info('sign-in completed', { handle: account.handle });
        return;

      case 'CHALLENGE':
        // Terminal for the watcher. The window stays open and untouched.
        if (account.status !== 'CHALLENGE_REQUIRES_USER') {
          await ops.createDiagnostic({
            accountId,
            channel: account.channel,
            kind: 'auth_challenge',
            url: null,
            message: `${seen.detail} AI17Z stopped and left the window open.`,
          });
        }
        await accountsRepo.updateAccount(accountId, {
          status: 'CHALLENGE_REQUIRES_USER',
          challengeKind: seen.challengeKind ?? 'unknown',
          lastHealthStatus: seen.detail.slice(0, 200),
          // The wait is over as far as automation is concerned; the deadline is
          // cleared so a person is not timed out while answering a challenge.
          authDeadlineAt: null,
          touchHealthCheck: true,
        });
        log.info('sign-in needs the account owner', { handle: account.handle, kind: seen.challengeKind });
        return;

      case 'AUTHENTICATING':
        await this.progress(account.status, accountId, 'AUTHENTICATING', seen.detail);
        return;

      case 'AWAITING_LOGIN':
        await this.progress(account.status, accountId, 'AWAITING_LOGIN', seen.detail);
        return;

      case 'UNREACHABLE':
        // Not while this worker is going down. A browser closed by our own
        // shutdown is indistinguishable from one somebody closed, and telling
        // an owner mid-sign-in that their window was closed -- when it is still
        // open on their screen, and it was a restart that did it -- is a worse
        // answer than saying nothing and finding out on the way back up.
        if (this.stopping) {
          log.info('sign-in check interrupted by shutdown; leaving the status alone', {
            handle: account.handle,
          });
          return;
        }
        // Almost always somebody closing the window rather than a fault. Saying
        // ERROR implies something broke and needs fixing; nothing did, and the
        // way forward is simply to open sign-in again.
        await accountsRepo.updateAccount(accountId, {
          status: 'NEEDS_AUTH',
          lastError: null,
          lastHealthStatus: 'The sign-in window was closed before it finished.',
          authStartedAt: null,
          authDeadlineAt: null,
          touchHealthCheck: true,
        });
        log.info('sign-in window went away', { handle: account.handle });
        return;
    }
  }

  /** Writes a step of the sign-in, skipping the write when nothing changed. */
  private async progress(
    current: string,
    accountId: string,
    status: 'AWAITING_LOGIN' | 'AUTHENTICATING',
    detail: string,
  ): Promise<void> {
    if (current === status) return;
    await accountsRepo.updateAccount(accountId, {
      status,
      lastHealthStatus: detail.slice(0, 200),
      touchHealthCheck: true,
    });
  }
}
