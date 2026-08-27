import { createLogger, envInt, errorMessage } from '@xbam/shared';
import { accounts as accountsRepo, ops } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { buildChannelContext } from '@xbam/runtime';

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

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const account of await accountsRepo.accountsAwaitingSignIn()) {
        await this.check(account.id).catch((error) =>
          log.warn('sign-in check failed', { accountId: account.id, message: errorMessage(error) }),
        );
      }
    } finally {
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
        await accountsRepo.updateAccount(accountId, {
          status: 'ERROR',
          lastError: seen.detail.slice(0, 500),
          lastHealthStatus: 'The sign-in window could not be read.',
          authStartedAt: null,
          authDeadlineAt: null,
          touchHealthCheck: true,
        });
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
