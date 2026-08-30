import type { FastifyInstance } from 'fastify';
import { EasySetup, type RadarSourceKind } from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  browserTasks,
  agents as agentsRepo,
  capabilities as capabilitiesRepo,
  ops,
  pipelines as pipelinesRepo,
  posting as postingRepo,
  providers as providersRepo,
  radar as radarRepo,
  workers as workersRepo,
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
 * What is stopping this agent from running.
 *
 * Each entry names one thing and what to do about it, in a sentence somebody
 * can act on. "Browser context state authentication health failure" is not a
 * sentence somebody can act on.
 */
export interface Blocker {
  what: string;
  fix: string;
  /** Where in the UI the fix lives, when there is a place to send them. */
  where: 'account' | 'models' | 'persona' | 'worker' | 'capabilities' | null;
}

async function preflight(agentId: string): Promise<Blocker[]> {
  const blockers: Blocker[] = [];

  const [persona, policy, pipeline, models, links] = await Promise.all([
    agentsRepo.getActivePersona(agentId),
    agentsRepo.getActivePolicy(agentId),
    pipelinesRepo.getActivePipeline(agentId),
    providersRepo.listModelConfigs(agentId),
    accountsRepo.listAgentAccounts(agentId),
  ]);

  if (!persona) {
    blockers.push({ what: 'This agent has no character yet.', fix: 'Set a name and a personality.', where: 'persona' });
  }
  if (!policy) {
    blockers.push({ what: 'This agent has no rules yet.', fix: 'Finish the setup.', where: 'persona' });
  }
  if (!pipeline) {
    blockers.push({ what: 'This agent has no pipeline.', fix: 'Reopen the agent page, which creates one.', where: null });
  }

  const primary = models.find((m) => m.role === 'primary');
  if (!primary) {
    blockers.push({
      what: 'No AI model is connected.',
      fix: 'Choose a provider and a model.',
      where: 'models',
    });
  } else {
    const credential = await providersRepo.getProvider(primary.providerCredentialId);
    if (!credential?.enabled) {
      blockers.push({
        what: `The ${credential?.provider ?? 'model'} provider is switched off.`,
        fix: 'Turn it back on in Settings, or choose a different one.',
        where: 'models',
      });
    }
  }

  const enabledLinks = links.filter((l) => l.enabled);
  if (enabledLinks.length === 0) {
    blockers.push({
      what: 'No account is connected, so there is nothing for it to read.',
      fix: 'Connect an X account.',
      where: 'account',
    });
  }

  let needsBrowser = false;
  for (const link of enabledLinks) {
    const account = await accountsRepo.getAccount(link.accountId);
    if (!account) continue;
    if (account.channel === 'x') needsBrowser = true;

    // Only a channel that signs in through a browser can be signed out of. The
    // mock channel has no session, and telling somebody to sign in to it is
    // advice they cannot act on.
    const signsIn = getChannelAdapter(account.channel).requiresBrowser;
    if (signsIn && account.status !== 'CONNECTED') {
      blockers.push({
        what:
          account.status === 'NEEDS_AUTH' || account.status === 'SESSION_EXPIRED'
            ? `The ${account.channel.toUpperCase()} session for @${account.handle} has expired.`
            : `@${account.handle} is not connected (${account.status.toLowerCase().replace(/_/g, ' ')}).`,
        fix: 'Sign in again.',
        where: 'account',
      });
    } else if (!signsIn && account.status === 'ERROR') {
      blockers.push({
        what: `@${account.handle} is in an error state: ${account.lastError ?? 'no reason recorded'}.`,
        fix: 'Clear it from the account panel, or connect a different account.',
        where: 'account',
      });
    }

    const grants = await capabilitiesRepo.grantsFor(agentId, link.accountId);
    if (!grants.has('REPLY')) {
      blockers.push({
        what: `This agent is not permitted to reply through @${account.handle}.`,
        fix: 'Grant it the reply capability on the account.',
        where: 'capabilities',
      });
    }
  }

  if (needsBrowser) {
    const workers = await workersRepo.present();
    if (!workers.some((w) => w.browserCapable)) {
      blockers.push({
        what: 'Nothing is running that can open a browser.',
        fix: 'Start the worker on the machine with Chrome (npm run dev:worker).',
        where: 'worker',
      });
    }
  }

  return blockers;
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
