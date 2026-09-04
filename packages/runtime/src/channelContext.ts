import { resolve } from 'node:path';
import type { Account } from '@xbam/shared/contracts';
import { createLogger, envString } from '@xbam/shared';
import { accounts as accountsRepo } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { defaultProfileDir } from '@xbam/browser';
import type { ChannelContext } from '@xbam/channels';

export function storageDir(): string {
  return resolve(envString('AI17Z_STORAGE_DIR', './storage'));
}

/** Builds the adapter context for an account, including its browser session config. */
export async function buildChannelContext(account: Account, jobId: string | null): Promise<ChannelContext> {
  // Only browser channels have a stored session, and synthetic accounts (used by
  // channels that need no connected account at all) have no database row to read.
  const needsSession = getChannelAdapter(account.channel).requiresBrowser && !account.id.startsWith('synthetic-');
  const session = needsSession ? await accountsRepo.getBrowserSession(account.id) : null;
  return {
    account,
    session: session
      ? {
          // The stored engine is the authority. An account written before the
          // engine column existed was mapped from its old mode and channel by
          // migration 0040, so there is always one.
          engine: session.engine ?? 'GOOGLE_CHROME',
          mode: session.mode,
          channel: session.channel ?? 'chromium',
          profileDir: session.profileDir ?? defaultProfileDir(account.id),
          cdpUrl: session.cdpUrl,
        }
      : null,
    storageDir: storageDir(),
    logger: createLogger('channel', { channel: account.channel, account: account.handle }),
    jobId,
  };
}

/**
 * A synthetic account for channels that do not need a real one. The mock channel
 * can run without the operator connecting anything.
 */
export function syntheticAccount(overrides: Partial<Account> & Pick<Account, 'id' | 'ownerId'>): Account {
  return {
    channel: 'mock',
    remoteAccountId: null,
    handle: 'local',
    displayName: 'Local',
    status: 'CONNECTED',
    enabled: true,
    capabilities: [],
    settings: {},
    lastHealthCheckAt: null,
    lastHealthStatus: null,
    lastActivityAt: null,
    lastError: null,
    authStartedAt: null,
    authDeadlineAt: null,
    challengeKind: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
