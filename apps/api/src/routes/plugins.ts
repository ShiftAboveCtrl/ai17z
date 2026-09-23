import type { FastifyInstance } from 'fastify';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  capabilityInvocations,
  ops,
  plugins as pluginsRepo,
} from '@xbam/database';
import type { UserRow } from '@xbam/database';
import {
  installFromRegistry,
  installPlugin,
  pauseState,
  pluginPanels,
  pluginViews,
  registryAddress,
  registryCatalog,
  registryDetail,
  registryKeyState,
  registryUpdates,
  setPluginEnabled,
  setRegistryAddress,
  setRegistryKey,
  uninstallPlugin,
} from '@xbam/runtime';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { handler, params, parseBody, requireUser } from '../http';

/** The same ownership check every agent route makes, made the same way. */
async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

/**
 * Plugins, as the owner reaches them.
 *
 * Every route here is a view over or a write into the canonical capability
 * system. Nothing invokes anything: an agent uses a Plugin by choosing one of
 * its capabilities through the ordinary loop, and these routes exist so an
 * owner can decide what is on the menu.
 *
 * A secret never comes back out of here. The registry key is reported as
 * present with its last four characters and nothing else, exactly as a
 * provider key is, and a Plugin's own secrets are reported as a list of which
 * keys are filled.
 */
export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  /** Everything installed, for one agent, with that agent's decisions in it. */
  app.get(
    '/api/agents/:id/plugins',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);

      const links = await accountsRepo.listAgentAccounts(agent.id).catch(() => []);
      const paused = (await pauseState().catch(() => ({ paused: false }))).paused;
      /*
        The registry is asked only when the caller says to.

        Drawing this screen must not wait on somebody else's server: a
        registry that is slow, unreachable or not configured would otherwise
        make the Plugins page slow, unreachable or broken. `?updates=1` is the
        explicit ask, and without it the view says nothing about updates
        rather than claiming there are none.
      */
      const wantsUpdates = (request.query as { updates?: string } | undefined)?.updates === '1';
      const found = wantsUpdates ? await registryUpdates().catch(() => null) : null;
      const plugins = await pluginViews({
        agentId: agent.id,
        accountId: links[0]?.accountId ?? null,
        paused,
        ...(found?.ok ? { updates: found.updates } : {}),
      });
      return { plugins, checkedForUpdates: Boolean(found?.ok) };
    }),
  );

  /**
   * One Plugin's own panel, when it declared one.
   *
   * Data rather than markup, and drawn by AI17Z's own components. A Plugin
   * that could hand back HTML would be a Plugin that could put a script on a
   * page holding the owner's provider keys.
   */
  app.get(
    '/api/agents/:id/plugins/panels',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const panels = await pluginPanels();
      const history = await capabilityInvocations.listForAgent(agent.id, 100).catch(() => []);
      return {
        panels: panels.map((panel) => ({
          ...panel,
          // Only the runs the panel asked for, and only this agent's.
          runs: history.filter((row) => panel.runsOf.includes(row.capabilityId)).slice(0, 10),
        })),
      };
    }),
  );

  /** Turn a Plugin on or off for one agent. */
  app.put(
    '/api/agents/:id/plugins/:pluginId',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const pluginId = params(request).pluginId!;

      const body = parseBody(z.object({ enabled: z.boolean() }), request);
      const { changed } = await setPluginEnabled({ agentId: agent.id, pluginId, enabled: body.enabled });
      await ops.audit({
        actorUserId: user.id,
        action: body.enabled ? 'plugin.enabled' : 'plugin.disabled',
        entityType: 'agent',
        entityId: agent.id,
        data: { pluginId, capabilities: changed },
      });
      return { ok: true, changed };
    }),
  );

  /**
   * Configuration an owner supplied for a Plugin.
   *
   * Secrets go in and never come back: the answer says which keys are filled,
   * not what is in them.
   */
  app.put(
    '/api/agents/:id/plugins/:pluginId/config',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const pluginId = params(request).pluginId!;

      const record = await pluginsRepo.getInstalledPlugin(pluginId);
      if (!record) throw new NotFoundError('Plugin');

      const body = parseBody(
        z
          .object({
            /*
              A partial update, deliberately.

              A key left out is left alone and an explicit null removes one.
              Replacing the whole object instead would mean a screen saving
              only the credential silently emptied every other field, and the
              symptom is a Plugin that stops working for a reason nothing on
              the page mentions.
            */
            config: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
              .default({}),
            secrets: z.record(z.string(), z.string().max(4_000)).default({}),
          })
          .strict(),
        request,
      );

      // Only keys the manifest declared. A Plugin that could be handed values
      // it never asked for is a Plugin that can be used to store things.
      const declared = new Map(record.manifest.config.map((field) => [field.key, field]));
      const config: Record<string, unknown> = { ...(await pluginsRepo.getPluginConfig(agent.id, pluginId)) };
      const touched: string[] = [];
      for (const [key, value] of Object.entries(body.config)) {
        const field = declared.get(key);
        if (!field || field.secret) continue;
        touched.push(key);
        if (value === null) delete config[key];
        else config[key] = value;
      }
      // A key the manifest no longer declares is dropped on the way through,
      // so an update that removes a field does not leave its value behind for
      // a later version of the Plugin to find.
      for (const key of Object.keys(config)) {
        if (!declared.has(key)) delete config[key];
      }
      await pluginsRepo.setPluginConfig(agent.id, pluginId, config);

      for (const [key, value] of Object.entries(body.secrets)) {
        const field = declared.get(key);
        if (!field?.secret) continue;
        if (value) await pluginsRepo.setPluginSecret(agent.id, pluginId, key, value);
        else await pluginsRepo.clearPluginSecret(agent.id, pluginId, key);
      }

      await ops.audit({
        actorUserId: user.id,
        action: 'plugin.configured',
        entityType: 'agent',
        entityId: agent.id,
        // The keys that were set, never the values.
        data: { pluginId, keys: touched, secrets: Object.keys(body.secrets) },
      });
      return {
        ok: true,
        config,
        secretsPresent: await pluginsRepo.pluginSecretKeys(agent.id, pluginId),
      };
    }),
  );

  /** Install from a manifest the owner supplies directly. */
  app.post(
    '/api/plugins/install',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(
        z
          .object({
            manifest: z.string().min(2).max(200_000),
            /*
              Set only after the owner has been shown what a new version asks
              for that the installed one did not. It is a separate call
              rather than a flag the first request may carry, so that the
              sentences describing the expansion have to have been rendered
              before anything can acknowledge them.
            */
            acknowledgeExpansion: z.boolean().default(false),
          })
          .strict(),
        request,
      );
      const done = await installPlugin({
        raw: body.manifest,
        source: 'LOCAL',
        ...(body.acknowledgeExpansion ? { acknowledgeExpansion: true } : {}),
      });
      if (!done.ok) return { ok: false, why: done.why, needsAcknowledgement: done.needsAcknowledgement ?? [] };
      await ops.audit({
        actorUserId: user.id,
        action: 'plugin.installed',
        entityType: 'plugin',
        entityId: done.plugin.id,
        data: { source: 'LOCAL', version: done.plugin.version, publisher: done.plugin.publisher },
      });
      return { ok: true, plugin: { id: done.plugin.id, version: done.plugin.version } };
    }),
  );

  /** Install from the official registry, by id. */
  app.post(
    '/api/plugins/registry/install',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(
        z
          .object({
            id: z.string().min(3).max(64),
            acknowledgeExpansion: z.boolean().default(false),
          })
          .strict(),
        request,
      );
      const before = await pluginsRepo.getInstalledPlugin(body.id);
      const done = await installFromRegistry(body.id, {
        ...(body.acknowledgeExpansion ? { acknowledgeExpansion: true } : {}),
      });
      if (!done.ok) return { ok: false, why: done.why, needsAcknowledgement: done.needsAcknowledgement ?? [] };
      await ops.audit({
        actorUserId: user.id,
        // An update and a first install are different things to have done,
        // and an audit trail that calls both "installed" cannot answer when a
        // Plugin's version changed.
        action: before ? 'plugin.updated' : 'plugin.installed',
        entityType: 'plugin',
        entityId: done.installedId,
        data: {
          source: 'AI17Z_REGISTRY',
          version: done.version,
          ...(before ? { from: before.version, acknowledgedExpansion: body.acknowledgeExpansion } : {}),
        },
      });
      return { ok: true, plugin: { id: done.installedId, version: done.version } };
    }),
  );

  app.delete(
    '/api/plugins/:pluginId',
    handler(async (request) => {
      const user = await requireUser(request);
      const pluginId = params(request).pluginId!;
      const done = await uninstallPlugin(pluginId);
      if (!done.ok) return { ok: false, why: done.why };
      await ops.audit({
        actorUserId: user.id,
        action: 'plugin.uninstalled',
        entityType: 'plugin',
        entityId: pluginId,
        data: {},
      });
      return { ok: true };
    }),
  );

  /** The catalogue. Public Plugins need no key. */
  app.get(
    '/api/plugins/catalog',
    handler(async (request) => {
      await requireUser(request);
      const search = (request.query as { q?: string } | undefined)?.q;
      const answer = await registryCatalog(search);
      return answer.ok ? { ok: true, plugins: answer.plugins } : { ok: false, why: answer.why, needsKey: answer.needsKey ?? false };
    }),
  );

  app.get(
    '/api/plugins/catalog/:pluginId',
    handler(async (request) => {
      await requireUser(request);
      const pluginId = params(request).pluginId!;
      const answer = await registryDetail(pluginId);
      if (!answer.ok) return { ok: false, why: answer.why, needsKey: answer.needsKey ?? false };
      // The manifest text is handed on so the screen can show what is about to
      // be approved. It is the same bytes the hash is over.
      return { ok: true, listing: answer.listing, manifest: answer.manifest, manifestSha256: answer.manifestSha256 };
    }),
  );

  app.get(
    '/api/plugins/updates',
    handler(async (request) => {
      await requireUser(request);
      const answer = await registryUpdates();
      return answer.ok ? { ok: true, updates: answer.updates } : { ok: false, why: answer.why };
    }),
  );

  /** Where the registry is, and whether a key is stored. Never the key. */
  app.get(
    '/api/plugins/registry',
    handler(async (request) => {
      await requireUser(request);
      const [url, key] = await Promise.all([registryAddress(), registryKeyState()]);
      return { url, key };
    }),
  );

  app.put(
    '/api/plugins/registry',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({
          url: z.string().trim().max(300).nullable().optional(),
          // Absent leaves the stored key alone; null removes it.
          key: z.string().trim().max(500).nullable().optional(),
        }).strict(), request);
      /*
        An address that cannot be used is refused here, with a sentence.

        `registryAddress` already returns null for anything that is not https,
        which meant an owner could type an http address, press Save, watch the
        field go blank and be told nothing at all -- while the unusable value
        sat in the settings table. A control that silently discards what
        somebody typed is worse than one that says no.
      */
      if (body.url) {
        let usable = false;
        try {
          usable = new URL(body.url).protocol === 'https:';
        } catch {
          usable = false;
        }
        if (!usable) {
          return {
            ok: false,
            why: 'A registry address has to be a full https address, such as https://plugins.example.com. A catalogue fetched over http is one somebody on the path chooses.',
          };
        }
      }
      if (body.url !== undefined) await setRegistryAddress(body.url);
      if (body.key !== undefined) await setRegistryKey(body.key);
      await ops.audit({
        actorUserId: user.id,
        action: 'plugin.registry.configured',
        entityType: 'settings',
        entityId: 'plugins.registry',
        // What changed, never what it changed to.
        data: { url: body.url !== undefined, key: body.key !== undefined },
      });
      const [url, key] = await Promise.all([registryAddress(), registryKeyState()]);
      return { ok: true, url, key };
    }),
  );
}
