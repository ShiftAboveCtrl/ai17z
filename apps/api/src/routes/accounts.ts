import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BrowserEngine, CadenceConfig, CreateAccountInput, FarcasterSettings } from '@xbam/shared/contracts';
import { BadRequestError, ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  farcasterSigners,
  browserTasks as browserTasksRepo,
  cadences as cadencesRepo,
  ops,
  type UserRow,
} from '@xbam/database';
import { getChannelAdapter, isChannelImplemented, listChannelAdapters } from '@xbam/channels';
import { closeSession } from '@xbam/browser';
import {
  accountIsWell,
  connectFarcaster,
  allowTelegramGroup,
  connectTelegramGroupAccount,
  disconnectTelegramGroupAccount,
  ensureDefaultRadarSources,
  forgetTelegramGroup,
  reconnectTelegramGroupAccount,
  replaceTelegramGroupToken,
  telegramGroupOverview,
  connectBlueskyAccount,
  disconnectBlueskyAccount,
  reconnectBlueskyAccount,
} from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

async function ownedAccount(accountId: string, user: UserRow) {
  const account = await accountsRepo.getAccount(accountId);
  if (!account) throw new NotFoundError('Account');
  if (account.ownerId !== user.id) throw new ForbiddenError('That account belongs to another owner.');
  return account;
}

async function ownedTelegramAccount(accountId: string, user: UserRow) {
  const account = await ownedAccount(accountId, user);
  if (account.channel !== 'telegram') throw new BadRequestError('This account is not on Telegram.');
  return account;
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts/:id/farcaster/signer', handler(async (request) => {
    const account = await ownedAccount(params(request).id!, await requireUser(request));
    if (account.channel !== 'farcaster') throw new BadRequestError('This account is not on Farcaster.');
    return farcasterSigners.signerPresence(account.id);
  }));
  app.put('/api/accounts/:id/farcaster/signer', handler(async (request) => {
    const account = await ownedAccount(params(request).id!, await requireUser(request));
    const input = parseBody(z.object({ signerKey: z.string().regex(/^(?:0x)?[a-fA-F0-9]{64}$/) }).strict(), request);
    await connectFarcaster(account.id, input.signerKey);
    return farcasterSigners.signerPresence(account.id);
  }));
  app.delete('/api/accounts/:id/farcaster/signer', handler(async (request) => {
    const account = await ownedAccount(params(request).id!, await requireUser(request));
    if (account.channel !== 'farcaster') throw new BadRequestError('This account is not on Farcaster.');
    await farcasterSigners.clearSigner(account.id);
    return farcasterSigners.signerPresence(account.id);
  }));
  app.get(
    '/api/channels',
    handler(async () => ({
      items: listChannelAdapters().map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        capabilities: adapter.capabilities,
        requiresBrowser: adapter.requiresBrowser,
      })),
    })),
  );

  app.get(
    '/api/accounts',
    handler(async (request) => {
      const user = await requireUser(request);
      const list = await accountsRepo.listAccounts(user.id);
      const withSessions = await Promise.all(
        list.map(async (account) => ({
          ...account,
          browserSession: await accountsRepo.getBrowserSession(account.id),
          implemented: isChannelImplemented(account.channel),
        })),
      );
      return { items: withSessions };
    }),
  );

  app.post(
    '/api/accounts',
    handler(async (request) => {
      const user = await requireUser(request);
      const input = parseBody(CreateAccountInput, request);
      if (input.channel === 'telegram') {
        // A Telegram account is made by proving a bot token, never by naming a
        // handle: a row with no working bot is an agent that polls nothing.
        throw new BadRequestError('Link a Telegram bot with its token: POST /api/accounts/telegram.');
      }
      if (input.channel === 'bluesky') {
        // A Bluesky account is made by proving an app password, never by naming
        // a handle: a row with no working sign-in is an account that polls into
        // Bluesky's session limit and does nothing.
        throw new BadRequestError('Link a Bluesky account with its app password: POST /api/accounts/bluesky.');
      }
      const adapter = getChannelAdapter(input.channel);

      // Connecting a handle that is already connected is a thing people do, and
      // a unique-index violation surfacing as "something went wrong" tells them
      // nothing. The existing account is the right answer: accounts are separate
      // from agents precisely so one can be attached to several.
      const existing = await accountsRepo.findByHandle(user.id, input.channel, input.handle);
      if (existing) return existing;

      const account = await accountsRepo.createAccount({
        ownerId: user.id,
        channel: input.channel,
        handle: input.handle,
        displayName: input.displayName || input.handle,
        remoteAccountId: input.remoteAccountId,
        capabilities: [...adapter.capabilities],
        settings: input.settings,
      });
      // The profile directory is keyed by account id, which only exists after insert.
      if (adapter.requiresBrowser) {
        await accountsRepo.upsertBrowserSession({
          accountId: account.id,
          mode: input.browser?.mode ?? 'MANAGED',
          channel: 'chrome',
          engine: 'GOOGLE_CHROME',
          // Null, because the API cannot know. It runs in a container whose
          // working directory is `/app`, so resolving the default here wrote a
          // path that exists on no machine anybody uses -- and a Mac then tried
          // to create `/app`. Where a profile lives is answered by the process
          // that opens the browser, on the machine it opens it on.
          profileDir: null,
          cdpUrl: input.browser?.cdpUrl || null,
        });
      }
      // The monitors an account should have had from the start.
      //
      // These were opt-in, behind a button, because each one costs a page
      // load. What that actually produced was a connected account with
      // nothing searching on its behalf -- the channel poller reads the
      // notifications page and that was all. Safe to do here rather than on
      // connection: the poller only claims sources whose account is
      // CONNECTED, so they sit idle until sign-in finishes.
      await ensureDefaultRadarSources(account.id);
      await ops.audit({ actorUserId: user.id, action: 'account.created', entityType: 'account', entityId: account.id });
      return account;
    }),
  );

  /*
    Linking a Telegram bot, for an agent that works in groups.

    Write-only for the token: it is checked against Telegram, sealed under the
    master key, and never returned. The response is the account row, which has
    never had a secret on it, and the audit row names the account and nothing
    the owner typed. This is not the owner's notification bot, and the same
    token is refused.
  */
  app.post(
    '/api/accounts/telegram',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ token: z.string().trim().min(1).max(200) }).strict(), request);
      const account = await connectTelegramGroupAccount({ ownerId: user.id, token: body.token });
      await ops.audit({
        actorUserId: user.id,
        action: 'account.created',
        entityType: 'account',
        entityId: account.id,
        data: { channel: 'telegram' },
      });
      return account;
    }),
  );

  /*
    Linking a Bluesky account.

    Write-only for the password: what goes in is checked against Bluesky, then
    sealed under the master key, and the response is the account row, which has
    never had a secret on it. The audit row names the account and nothing the
    owner typed.
  */
  app.post(
    '/api/accounts/bluesky',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(
        z.object({
          identifier: z.string().trim().min(1).max(320),
          appPassword: z.string().min(1).max(64),
          serviceUrl: z.string().trim().max(300).nullable().optional(),
        }),
        request,
      );
      const { account, created } = await connectBlueskyAccount({
        ownerId: user.id,
        identifier: body.identifier,
        appPassword: body.appPassword,
        serviceUrl: body.serviceUrl ?? null,
      });
      await ops.audit({
        actorUserId: user.id,
        action: created ? 'account.created' : 'account.reconnected',
        entityType: 'account',
        entityId: account.id,
        data: { channel: 'bluesky' },
      });
      return account;
    }),
  );

  /** Whether a bot is held (never the token), and the groups the owner allowed. */
  app.get(
    '/api/accounts/:id/telegram',
    handler(async (request) => {
      const account = await ownedTelegramAccount(params(request).id!, await requireUser(request));
      return telegramGroupOverview(account.id);
    }),
  );

  /** A new token for the same bot, after /revoke in BotFather. */
  app.put(
    '/api/accounts/:id/telegram/bot',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedTelegramAccount(params(request).id!, user);
      const body = parseBody(z.object({ token: z.string().trim().min(1).max(200) }).strict(), request);
      await replaceTelegramGroupToken(account.id, body.token);
      await ops.audit({ actorUserId: user.id, action: 'account.telegram.token_replaced', entityType: 'account', entityId: account.id });
      return telegramGroupOverview(account.id);
    }),
  );

  /** Allows one group. Takes its chat id, or a message link copied from it. */
  app.put(
    '/api/accounts/:id/telegram/chats',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedTelegramAccount(params(request).id!, user);
      const body = parseBody(z.object({ chat: z.string().trim().min(1).max(300) }).strict(), request);
      const chat = await allowTelegramGroup(account.id, body.chat);
      await ops.audit({
        actorUserId: user.id,
        action: 'account.telegram.chat_allowed',
        entityType: 'account',
        entityId: account.id,
        data: { chatId: chat.chatId },
      });
      return telegramGroupOverview(account.id);
    }),
  );

  app.delete(
    '/api/accounts/:id/telegram/chats/:chatId',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedTelegramAccount(params(request).id!, user);
      const removed = await forgetTelegramGroup(account.id, params(request).chatId!);
      if (removed) {
        await ops.audit({
          actorUserId: user.id,
          action: 'account.telegram.chat_removed',
          entityType: 'account',
          entityId: account.id,
          data: { chatId: params(request).chatId },
        });
      }
      return telegramGroupOverview(account.id);
    }),
  );

  // Cadence: when this account is read from and allowed to act. Versioned, so a
  // change that quietens an agent can be traced to who made it and when.
  app.get(
    '/api/accounts/:id/cadence',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      const [config, versions, state] = await Promise.all([
        cadencesRepo.activeCadence(account.id),
        cadencesRepo.listVersions(account.id),
        cadencesRepo.pollState(account.id),
      ]);
      return {
        config,
        // No versions means nothing has been edited and the defaults are in force.
        customised: versions.length > 0,
        versions,
        state,
      };
    }),
  );

  app.put(
    '/api/accounts/:id/cadence',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      const body = parseBody(
        z.object({ config: CadenceConfig, changeNote: z.string().max(500).default('') }),
        request,
      );
      const version = await cadencesRepo.saveVersion(account.id, body.config, body.changeNote, user.id);
      await ops.audit({
        actorUserId: user.id,
        action: 'account.cadence.saved',
        entityType: 'account',
        entityId: account.id,
        data: { version: version.version },
      });
      return version;
    }),
  );

  app.patch(
    '/api/accounts/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      const body = parseBody(
        z.object({
          displayName: z.string().max(200).optional(),
          enabled: z.boolean().optional(),
          settings: z.record(z.string(), z.unknown()).optional(),
          browser: z
            .object({
              engine: BrowserEngine,
              cdpUrl: z.string().max(500).default(''),
            })
            .optional(),
        }),
        request,
      );
      if (body.browser) {
        // mode and channel are derived from the engine. They stay in the row so
        // older readers keep working, but the engine is what decides anything.
        const engine = body.browser.engine;
        await accountsRepo.upsertBrowserSession({
          accountId: account.id,
          engine,
          mode: engine === 'CUSTOM_CDP' ? 'CDP' : 'MANAGED',
          channel:
            engine === 'GOOGLE_CHROME' ? 'chrome' : engine === 'MICROSOFT_EDGE' ? 'msedge' : 'chromium',
          // Null, because the API cannot know. It runs in a container whose
          // working directory is `/app`, so resolving the default here wrote a
          // path that exists on no machine anybody uses -- and a Mac then tried
          // to create `/app`. Where a profile lives is answered by the process
          // that opens the browser, on the machine it opens it on.
          profileDir: null,
          cdpUrl: body.browser.cdpUrl || null,
        });
        // Configuration changed, so any live context is no longer valid.
        await closeSession(account.id).catch(() => undefined);
      }
      if (account.channel === 'farcaster' && body.settings !== undefined) FarcasterSettings.parse(body.settings);
      if (account.channel === 'farcaster') {
        await farcasterSigners.updateConfiguration(account.id, body);
        return { ...await accountsRepo.requireAccount(account.id), browserSession: null };
      }
      const updated = await accountsRepo.updateAccount(account.id, {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
      });
      return { ...updated, browserSession: await accountsRepo.getBrowserSession(account.id) };
    }),
  );

  /**
   * Stop working this account, and keep everything about it.
   *
   * The half of "I do not want this account any more" that is reversible. The
   * poller and the radar already refuse a disabled account, so this switches
   * that flag, settles the status, closes any live session and cancels the
   * browser work already queued for it -- a task sitting in the queue would
   * otherwise open a window for an account the owner has just switched off.
   *
   * What it does not touch: the registration, its history, its cadence, its
   * capability grants, its links to agents, or anything an agent remembers.
   * Reconnecting is switching it back on.
   */
  app.post(
    '/api/accounts/:id/disconnect',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      await closeSession(account.id).catch(() => undefined);
      await browserTasksRepo.cancelAccountTasks(account.id, 'The account was disconnected.').catch(() => 0);
      if (account.channel === 'farcaster') await farcasterSigners.clearSigner(account.id);
      // The sealed bot token goes with the connection, as the notification bot's does.
      if (account.channel === 'telegram') await disconnectTelegramGroupAccount(account.id);
      // No browser to close, but a session on Bluesky's side to end, so a
      // disconnected account leaves no live token behind.
      if (account.channel === 'bluesky') await disconnectBlueskyAccount(account.id).catch(() => undefined);
      await accountsRepo.disconnectAccount(account.id);
      // Cleared here rather than waiting for the next health sweep, so the
      // warning goes when the owner acts rather than up to a minute later.
      await accountIsWell(account.id).catch(() => undefined);
      return accountsRepo.requireAccount(account.id);
    }),
  );

  /** Switched back on. Nothing is assumed about the session; signing in starts it. */
  app.post(
    '/api/accounts/:id/reconnect',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      // The stored token is tried now, and the account says what came of it.
      if (account.channel === 'telegram') return reconnectTelegramGroupAccount(account.id);
      if (account.channel === 'farcaster') return connectFarcaster(account.id);
      await accountsRepo.reconnectAccount(account.id);
      // Bluesky has no window to sign in through; the stored app password is
      // tried now, and the account says what came of it.
      if (account.channel === 'bluesky') return reconnectBlueskyAccount(account.id);
      return accountsRepo.requireAccount(account.id);
    }),
  );

  /**
   * Remove the registration itself.
   *
   * Every table that references an account either cascades or nulls the column,
   * so the row going is enough to stop the polling, the radar, the sign-in
   * watcher, the queued browser work and the notifications -- and
   * `ON DELETE CASCADE` on `owner_notifications` is what stops the signed-out
   * warning rather than anything remembering to clear it.
   *
   * The live session is closed and the queued work cancelled first anyway,
   * because the worker holds those in memory and a cascade cannot reach a
   * browser that is already open.
   *
   * What survives on purpose: what the agents wrote. `events`, `jobs`,
   * `actions` and memory all null the account column rather than cascade, so
   * removing an account the agent used does not delete the conversations it
   * had. Removing an account is not a way to erase history.
   */
  app.delete(
    '/api/accounts/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const account = await ownedAccount(params(request).id!, user);
      await closeSession(account.id).catch(() => undefined);
      await browserTasksRepo.cancelAccountTasks(account.id, 'The account was removed.').catch(() => 0);
      await accountsRepo.deleteAccount(account.id);
      // Idempotent by construction: a second call finds no account and answers
      // 404 from `ownedAccount`, rather than half-removing anything.
      return { deleted: true, handle: account.handle };
    }),
  );
}
