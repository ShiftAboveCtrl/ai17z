import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ops, prompts as promptsRepo, users as usersRepo } from '@xbam/database';
import { envBool, envString } from '@xbam/shared';
import { handler, parseBody, requireUser } from '../http';

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

  app.get(
    '/api/prompt-templates',
    handler(async (request) => {
      await requireUser(request);
      return { items: await promptsRepo.listTemplates() };
    }),
  );

  app.get(
    '/api/audit',
    handler(async (request) => {
      await requireUser(request);
      return { items: await ops.listImportRuns() };
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
}
