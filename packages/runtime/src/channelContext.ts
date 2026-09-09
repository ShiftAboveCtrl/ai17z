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
import type { JobBundle } from './loadJob';

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

/**
 * The channel context a pipeline step acts through.
 *
 * Moved here from steps.ts, which was the only reason four unrelated groups of
 * steps had to share a file. An agent with no linked account gets a synthetic
 * one so a dry run has somewhere to act.
 */
export async function adapterContext(bundle: JobBundle) {
  const account =
    bundle.account ?? syntheticAccount({ id: `synthetic-${bundle.agent.id}`, ownerId: bundle.agent.ownerId });
  return buildChannelContext(account, bundle.job.id);
}

/**
 * The context for a post the agent decided to make.
 *
 * There is no remote target to resolve and no conversation to read: the event
 * carries a brief written from the idea backlog. Built here rather than in the
 * adapter because it is the same on every channel, and because sending a
 * browser to a status page that does not exist would be a strange way to find
 * out there is nothing to look at.
 */
