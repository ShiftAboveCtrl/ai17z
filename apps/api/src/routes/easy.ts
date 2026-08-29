import type { FastifyInstance } from 'fastify';
import { EasySetup, type RadarSourceKind } from '@xbam/shared/contracts';
import { ForbiddenError, NotFoundError } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  ops,
  posting as postingRepo,
  radar as radarRepo,
  type UserRow,
} from '@xbam/database';
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
