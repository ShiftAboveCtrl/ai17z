import type { FastifyInstance } from 'fastify';
import { EasySetup, type RadarSourceKind } from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import { ensureAgentPipeline, ensureDefaultRadarSources, startPreflight as preflight } from '@xbam/runtime';
import {
  accounts as accountsRepo,
  browserTasks,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  ops,
  posting as postingRepo,
  radar as radarRepo,
  type UserRow,
} from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { postIntervalSeconds, readEasyView, toPersona, toPolicy, toRadarSourceKinds } from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * Easy Mode over the wire.
 *
 * One resource, two directions, and no storage of its own. GET reads the
 * agent's real persona, policy, posting schedule, and radar sources and reports
 * what Easy Mode makes of them — including a list of anything it cannot show.
 * PUT projects Easy answers back onto those same documents, cutting ordinary
 * versions that the Advanced screens then display and can edit.
 *
 * There is no easy_setup table. That is the point: an agent configured here and
 * an agent configured in Advanced are the same agent, described twice.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

/** The account an agent reads and acts through, when it has exactly one. */
async function primaryAccountId(agentId: string): Promise<string | null> {
  const links = await accountsRepo.listAgentAccounts(agentId);
  return links.find((l) => l.enabled)?.accountId ?? links[0]?.accountId ?? null;
}

export async function easyRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/easy',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);

      const [persona, policy, schedule, accountId] = await Promise.all([
        agentsRepo.getActivePersona(agent.id),
        agentsRepo.getActivePolicy(agent.id),
        postingRepo.getSchedule(agent.id),
        primaryAccountId(agent.id),
      ]);
      if (!persona || !policy) {
        // A draft agent has no versions yet. Saying so is better than inventing
        // an Easy view of nothing.
        return { ready: false, view: null, accountId, detail: 'This agent has no persona or policy yet.' };
      }

      const sources = accountId ? await radarRepo.listSources(accountId) : [];
      const view = readEasyView({
        persona,
        policy: policy.config,
        postIntervalSeconds: schedule?.enabled ? schedule.intervalSeconds : null,
        radarSourceKinds: sources.filter((s) => s.enabled).map((s) => s.kind),
      });

      return {
        ready: true,
        view,
        accountId,
        posting: schedule
          ? { nextPostAt: schedule.nextPostAt, lastPostAt: schedule.lastPostAt, lastReason: schedule.lastReason }
          : null,
      };
    }),
  );

  app.put(
    '/api/agents/:id/easy',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const setup = parseBody(EasySetup, request);

      const [existingPersona, existingPolicy, accountId] = await Promise.all([
        agentsRepo.getActivePersona(agent.id),
        agentsRepo.getActivePolicy(agent.id),
        primaryAccountId(agent.id),
      ]);

      // Everything Easy Mode does not name is carried through from what is
      // already there, so opening this screen on a carefully configured agent
      // edits eleven fields and leaves the rest exactly as they were.
      const persona = toPersona(setup, existingPersona ?? undefined);
      const policy = toPolicy(setup, existingPolicy?.config);

      const personaVersion = await agentsRepo.savePersonaVersion(agent.id, persona, user.id);
      const policyVersion = await agentsRepo.savePolicyVersion(agent.id, policy, 'Easy Mode', user.id);

      const interval = postIntervalSeconds(setup);
      await postingRepo.setSchedule({
        agentId: agent.id,
        accountId,
        enabled: interval !== null,
        intervalSeconds: interval ?? 21_600,
      });

      // Turning posting on has to grant the permission that lets it happen.
      //
      // Capabilities are deliberately separate from what an agent attempts, and
      // linking an account grants only READ, GENERATE and the reply action. So
      // an agent could have posting enabled, a schedule, a backlog of ideas and
      // no way to use any of it -- the scheduler came due, found no permission,
      // and wrote its reason into a column nobody reads. It looked exactly like
      // an agent that had nothing to say.
      if (interval !== null && accountId) {
        await capabilitiesRepo.grant(agent.id, accountId, 'POST');
      }

      // Radar sources belong to the account, so an agent with none connected
      // simply has nothing to turn on yet.
      let sourceKinds: RadarSourceKind[] = [];
      if (accountId) {
        sourceKinds = toRadarSourceKinds(setup);
        const wanted = new Set<RadarSourceKind>(sourceKinds);
        for (const kind of wanted) {
          await radarRepo.upsertSource({ accountId, kind, enabled: true, label: 'Easy Mode' });
        }
        // Sources Easy Mode manages but did not ask for are switched off rather
        // than deleted: a keyword or tracked account added in Advanced is not
        // Easy Mode's to remove.
        const managed: RadarSourceKind[] = ['notifications', 'mention_search', 'reply_search', 'own_threads'];
        for (const source of await radarRepo.listSources(accountId)) {
          if (!managed.includes(source.kind)) continue;
          if (wanted.has(source.kind)) continue;
          if (!source.enabled) continue;
          await radarRepo.upsertSource({
            accountId,
            kind: source.kind,
            target: source.target,
            enabled: false,
            label: source.label,
          });
        }
      }

      await ops.audit({
        actorUserId: user.id,
        action: 'agent.easy.saved',
        entityType: 'agent',
        entityId: agent.id,
        data: {
          personaVersion: personaVersion.version,
          policyVersion: policyVersion.version,
          automation: policy.automation.mode,
          posting: interval,
          sources: sourceKinds,
        },
      });

      return {
        personaVersion: personaVersion.version,
        policyVersion: policyVersion.version,
        postIntervalSeconds: interval,
        radarSourceKinds: sourceKinds,
      };
    }),
  );
}


/**
 * Starting an agent, with the checks done before rather than after.
 *
 * The alternative is activating an agent that immediately fails on its first
 * job and reports it as an error nobody asked for. Refusing up front, with the
 * one thing that needs fixing, is the better shape.
 */
export async function easyStartRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/agents/:id/preflight',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const blockers = await preflight(agent.id);
      return { ready: blockers.length === 0, blockers };
    }),
  );

  app.post(
    '/api/agents/:id/start',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      // The same for the monitors, and for the same reason: an account
      // connected before these were a default has none, and would go on
      // watching one surface out of five for ever. Creating only what is
      // absent, so a source somebody switched off stays off.
      for (const link of await accountsRepo.listAgentAccounts(agent.id)) {
        await ensureDefaultRadarSources(link.accountId);
      }

      // Agents that arrived without one heal here rather than staying stuck.
      //
      // Import creates the stock pipeline now, but that does nothing for an
      // agent already imported -- and "this agent has no pipeline" is not a
      // decision anybody can usefully make, it is a row that should exist.
      // Doing it on start rather than on read keeps GET requests from writing,
      // and start is exactly when somebody is asking for the agent to work.
      await ensureAgentPipeline(agent.id);
      const blockers = await preflight(agent.id);
      if (blockers.length > 0) return { started: false, blockers, state: agent.state };

      const updated = await agentsRepo.updateAgent(agent.id, { state: 'ACTIVE', lastError: null });
      await ops.audit({ actorUserId: user.id, action: 'agent.started', entityType: 'agent', entityId: agent.id });
      return { started: true, blockers: [], state: updated.state };
    }),
  );

  /**
   * Stopping an agent, all the way down.
   *
   * Pausing used to set a state and leave a signed-in Chrome on the desktop
   * with three tabs polling nothing. Stop now also queues a browser shutdown
   * per account, which closes the window and its renderers — gracefully first,
   * so the session is flushed to the profile and comes straight back on start.
   *
   * The API owns no browsers, so it records the intent and the worker does it.
   * A browser AI17Z did not start is only detached from.
   */
  app.post(
    '/api/agents/:id/stop',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const updated = await agentsRepo.updateAgent(agent.id, { state: 'PAUSED' });

      const closing: { handle: string; queued: boolean; detail: string }[] = [];
      for (const link of await accountsRepo.listAgentAccounts(agent.id)) {
        const account = await accountsRepo.getAccount(link.accountId);
        if (!account || !getChannelAdapter(account.channel).requiresBrowser) continue;
        try {
          await browserTasks.enqueueBrowserTask({
            accountId: account.id,
            kind: 'SHUTDOWN_BROWSER',
            requestedBy: user.id,
            params: {},
          });
          closing.push({ handle: account.handle, queued: true, detail: 'Closing the browser.' });
        } catch (error) {
          // One account already busy must not stop the agent being stopped.
          closing.push({
            handle: account.handle,
            queued: false,
            detail: error instanceof Error ? error.message : 'Could not queue a browser shutdown.',
          });
        }
      }

      await ops.audit({
        actorUserId: user.id,
        action: 'agent.stopped',
        entityType: 'agent',
        entityId: agent.id,
        data: { browsers: closing.length },
      });
      return { state: updated.state, closing };
    }),
  );

  /** Kept for anything that only wants the state change. */
  app.post(
    '/api/agents/:id/pause',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const updated = await agentsRepo.updateAgent(agent.id, { state: 'PAUSED' });
      await ops.audit({ actorUserId: user.id, action: 'agent.paused', entityType: 'agent', entityId: agent.id });
      return { state: updated.state };
    }),
  );
}
