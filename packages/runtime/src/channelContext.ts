import { resolve } from 'node:path';
import type { Account, CapacityClass } from '@xbam/shared/contracts';
import { createLogger, envString, PipelineError } from '@xbam/shared';
import { accounts as accountsRepo, cadences, farcasterSigners, type XSignal } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { resolveProfileDir } from '@xbam/browser';
import type { ChannelContext } from '@xbam/channels';
import { agentBotToken } from './telegramBotGuard';
import { capacityClassForEvent, checkReadCapacity, notePushback, noteRead } from './capacity';
import { msUntilAwake } from './cadence';

/**
 * Pushback from a Farcaster node, told by the code its client gave the error.
 * classifyXSignal reads X's own sentences, which say nothing about a node.
 */
function farcasterSignal(error: unknown): XSignal | null {
  return error instanceof PipelineError && error.reason === 'farcaster_rate_limited' ? 'RATE_LIMITED' : null;
}

export function storageDir(): string {
  return resolve(envString('AI17Z_STORAGE_DIR', './storage'));
}
import type { JobBundle } from './loadJob';

/** Builds the adapter context for an account, including its browser session config. */
export async function buildChannelContext(account: Account, jobId: string | null, readClass: CapacityClass = 'DIRECT'): Promise<ChannelContext> {
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
          // Through the resolver, never the stored value. Reading the row
          // directly was the shortest path to opening a browser wherever some
          // other machine happened to say.
          profileDir: resolveProfileDir(account.id, session.profileDir),
          cdpUrl: session.cdpUrl,
        }
      : null,
    storageDir: storageDir(),
    logger: createLogger('channel', { channel: account.channel, account: account.handle }),
    jobId,
    // Opened per call and checked against the notification bot every time, so a
    // context that is logged or kept holds no token.
    ...(account.channel === 'telegram' ? { botToken: () => agentBotToken(account.id) } : {}),
    ...(account.channel === 'farcaster' ? {
      signerKey: () => farcasterSigners.getDecryptedSigner(account.id),
      beforeRead: async () => {
        const config = await cadences.activeCadence(account.id);
        const quiet = msUntilAwake(config.quietHours, new Date());
        if (quiet > 0) throw PipelineError.retryable('quiet_hours', 'This account is within its quiet hours.', { retryAfterMs: quiet });
        const verdict = await checkReadCapacity(account.id, readClass);
        if (!verdict.allowed) throw PipelineError.retryable('account_capacity', verdict.message, {
          retryAfterMs: verdict.retryAfterMs ?? 10 * 60_000,
        });
      },
      afterRead: async (error?: unknown) => {
        await noteRead(account.id, readClass);
        const signal = farcasterSignal(error);
        if (signal) await notePushback(account.id, readClass, signal, (error as PipelineError).message);
      },
    } : {}),
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
  return buildChannelContext(account, bundle.job.id, capacityClassForEvent(bundle.event.type));
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
