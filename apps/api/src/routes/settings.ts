import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ops, users as usersRepo } from '@xbam/database';
import { envBool, envString } from '@xbam/shared';
import { setUpdatesEnabled, skipVersion, updateState } from '@xbam/runtime';
import { handler, parseBody, parseQuery, requireUser } from '../http';

const APPEARANCE_KEY = 'appearance';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/settings',
    handler(async (request) => {
      await requireUser(request);
      return {
        appearance: (await ops.getSetting(APPEARANCE_KEY)) ?? { motion: 'full', density: 'comfortable' },
        system: {
          // Whether a master key is configured, never the key itself.
          masterKeyConfigured: Boolean(process.env.XBAM_MASTER_KEY),
          browserEnabled: envBool('AI17Z_BROWSER_ENABLED', true),
          browserHeadless: envBool('AI17Z_BROWSER_HEADLESS', false),
          storageDir: envString('AI17Z_STORAGE_DIR', './storage'),
          nodeVersion: process.version,
        },
      };
    }),
  );

  app.put(
    '/api/settings/appearance',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(
        z.object({
          motion: z.enum(['full', 'reduced']).default('full'),
          density: z.enum(['comfortable', 'compact']).default('comfortable'),
        }),
        request,
      );
      await ops.setSetting(APPEARANCE_KEY, body);
      return body;
    }),
  );

  /**
   * What has been done to this installation, and by whom.
   *
   * This route is named for the audit log and returned the AI4CZ import
   * history, which is a different thing entirely. Nothing called either, so
   * nothing broke when they were separated; what changed is that the
   * fifty-three places that write an audit row are finally readable. The
   * import history had no caller and no screen either way, and is read from
   * the database by whoever is running an import.
   *
   * It matters more since Telegram became a command surface: a paired chat can
   * pause every agent and approve what they send, and "remote control of
   * somebody's accounts is worth a row" is only true if somebody can read it.
   */
  app.get(
    '/api/audit',
    handler(async (request) => {
      await requireUser(request);
      const query = parseQuery(
        z.object({ action: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }),
        request,
      );
      const [items, actions] = await Promise.all([
        ops.listAuditEvents({
          ...(query.action ? { action: query.action } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
        }),
        ops.auditActions(),
      ]);
      return { items, actions };
    }),
  );

  app.get(
    '/api/tools',
    handler(async (request) => {
      await requireUser(request);
      return { items: await ops.listTools() };
    }),
  );

  app.get(
    '/api/users',
    handler(async (request) => {
      await requireUser(request);
      return { items: await usersRepo.listUsers() };
    }),
  );

  /**
   * Whether there is a newer AI17Z.
   *
   * Answered from a cache that is at most six hours old, so opening a screen
   * does not send a request. Never throws on a failed check: an installation
   * with no internet gets `error` filled in and a screen that says so, which is
   * more use than one that quietly shows nothing.
   */
  app.get(
    '/api/updates',
    handler(async (request) => {
      await requireUser(request);
      return updateState();
    }),
  );

  /** Ask now, because somebody pressed the button. */
  app.post(
    '/api/updates/check',
    handler(async (request) => {
      await requireUser(request);
      return updateState({ refresh: true });
    }),
  );

  /**
   * Never mention this version again.
   *
   * Distinct from closing the card, which is "not now". Both answers exist
   * because they are different answers, and an update people cannot dismiss is
   * one they learn to ignore in a worse way.
   */
  app.post(
    '/api/updates/skip',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(z.object({ version: z.string().min(1).max(64) }), request);
      await skipVersion(body.version);
      return updateState();
    }),
  );

  /**
   * Stop checking entirely.
   *
   * The check is the only outbound request AI17Z makes that is not something an
   * agent was asked to do, so it is the one thing somebody might reasonably
   * want silent. Off means no request at all, not a request whose answer is
   * hidden.
   */
  app.put(
    '/api/updates/enabled',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(z.object({ enabled: z.boolean() }), request);
      await setUpdatesEnabled(body.enabled);
      return updateState();
    }),
  );
}
