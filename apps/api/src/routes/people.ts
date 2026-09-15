import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequestError, ForbiddenError, NotFoundError } from '@xbam/shared';
import { bridgesFor } from '@xbam/runtime';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  browserTasks as browserTasksRepo,
  mentions as mentionsRepo,
  ops,
  relationships as relationshipsRepo,
  xAccountObservations,
  type UserRow,
  type XAccountObservationRow,
} from '@xbam/database';
import { handler, params, requireUser } from '../http';

/**
 * Who the agent has been talking to, and who they actually are.
 *
 * Three different things are on this screen and keeping them apart is the whole
 * design, because conflating them is how a product starts asserting things it
 * has not established:
 *
 * - **What passed between us.** Relationship memory. Derived from replies the
 *   agent actually published and messages it actually received.
 * - **Where their attention leads.** The bridge score, which is about where the
 *   agent's own attention might go next and is explicitly not a ranking of
 *   people.
 * - **What their account says.** An observation, read from X when somebody
 *   asked for it, carrying when it was read and what the reader could not see.
 *
 * The third is new here and is deliberately the only one that needs asking for.
 * A screen that read X to fill in a hundred cards would cost a browser request
 * per card against the session the agent needs for its actual work -- so the
 * list shows what has already been read, and reading somebody is an action an
 * owner takes.
 *
 * Nothing on this screen publishes anything. The one POST records an intent to
 * *read*, which the worker executes through the X intelligence layer -- a layer
 * with no post, like, follow or message anywhere in it.
 */

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

async function linkedAccount(agentId: string) {
  const links = await accountsRepo.listAgentAccounts(agentId);
  return links[0]?.accountId ?? null;
}

const Handle = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@+/, ''))
  .refine((value) => /^[A-Za-z0-9_]{1,15}$/.test(value), 'That is not an X handle.');

/**
 * An observation, as a screen needs it.
 *
 * The whole row is not sent: `observations` carries example posts and ranked
 * term counts, which belong on a person's own card rather than on every row of
 * a list. What travels here is enough to say whether somebody has been read,
 * when, and what was found.
 */
function summarise(row: XAccountObservationRow) {
  const observations = row.observations as {
    sampleSize?: number;
    confident?: boolean;
    topics?: { term: string; count: number }[];
    postsPerDay?: number | null;
  };
  return {
    handle: row.handle,
    userId: row.userId || null,
    displayName: row.displayName,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    followers: row.followers,
    following: row.following,
    posts: row.posts,
    verified: row.verified,
    protected: row.protected,
    outcome: row.outcome,
    detail: row.detail,
    backend: row.backend,
    observedAt: row.observedAt,
    gaps: row.gaps,
    sampleSize: observations.sampleSize ?? 0,
    confident: observations.confident ?? false,
    topics: (observations.topics ?? []).slice(0, 5),
    postsPerDay: observations.postsPerDay ?? null,
  };
}

export async function peopleRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Everybody this agent knows, with whatever has been read about them.
   *
   * Ordered by the bridge score, which is the existing answer to "where might
   * this agent's attention go next". The observation is attached where one
   * exists and is absent where nobody has looked -- absent, not empty, so the
   * card can offer to look rather than implying there was nothing to find.
   */
  app.get(
    '/api/agents/:id/people',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const accountId = await linkedAccount(agent.id);
      if (!accountId) {
        return {
          ok: false as const,
          reason: 'This agent has no connected account, so it has spoken to nobody.',
          items: [],
        };
      }

      const bridges = await bridgesFor(agent.id, accountId, { ownerUserId: user.id });
      const known = await relationshipsRepo.listForAgent(agent.id, { limit: 200 });
      const byHandle = new Map(known.map((row) => [row.handle.toLowerCase(), row]));

      // One query for every observation on the screen. Asking per card would be
      // a smaller version of the mistake this table exists to prevent.
      const observations = await xAccountObservations.findManyByHandle(
        user.id,
        bridges.map((bridge) => bridge.handle),
      );

      return {
        ok: true as const,
        items: bridges.map((bridge) => {
          const relationship = byHandle.get(bridge.handle.toLowerCase());
          const observed = observations.get(bridge.handle.toLowerCase());
          return {
            handle: bridge.handle,
            bridge,
            relationship: relationship
              ? {
                  displayName: relationship.displayName,
                  userId: relationship.remoteUserId,
                  familiarity: relationship.familiarity,
                  disposition: relationship.disposition,
                  inboundCount: relationship.inboundCount,
                  outboundCount: relationship.outboundCount,
                  lastInteractionAt: relationship.lastInteractionAt,
                  ownerNote: relationship.ownerNote,
                }
              : null,
            // Null means nobody has looked, which is a different thing from a
            // look that found nothing.
            observed: observed ? summarise(observed) : null,
          };
        }),
      };
    }),
  );

  /**
   * One person: what passed between us, and what their account says.
   *
   * The two halves are returned separately and are never merged. What the agent
   * knows about somebody comes from conversations it actually had; what their
   * timeline says is an observation of a public account. A screen that blended
   * them would let "they post about Solana" become "we discussed Solana", which
   * is a claim the agent would then make out loud.
   */
  app.get(
    '/api/agents/:id/people/:handle',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const handle = Handle.parse(params(request).handle ?? '');
      const accountId = await linkedAccount(agent.id);

      const [relationship, observed, said] = await Promise.all([
        relationshipsRepo.find({ agentId: agent.id, channel: 'x', handle }),
        xAccountObservations.find({ ownerUserId: user.id, handle }),
        // Out of the inbox read model rather than a query of its own: it
        // already knows whether a mention produced a reply, and a second
        // answer to that question would drift from the first.
        mentionsRepo.listMentions({ agentId: agent.id, accountId, authorHandle: handle, limit: 25 }),
      ]);

      const callbacks = relationship ? await relationshipsRepo.listCallbacks(relationship.id) : [];

      return {
        handle,
        relationship: relationship
          ? {
              id: relationship.id,
              displayName: relationship.displayName,
              userId: relationship.remoteUserId,
              familiarity: relationship.familiarity,
              familiarityPinned: relationship.familiarityPinned,
              disposition: relationship.disposition,
              interactionCount: relationship.interactionCount,
              inboundCount: relationship.inboundCount,
              outboundCount: relationship.outboundCount,
              lastInteractionAt: relationship.lastInteractionAt,
              summary: relationship.summary,
              ownerNote: relationship.ownerNote,
              // What the agent and this person have actually discussed. Never
              // filled from a timeline read: this renders in a prompt as "You
              // have discussed ...", and a public topic is not a conversation.
              topics: relationship.topics,
              callbacks: callbacks.map((row) => ({ label: row.label, detail: row.detail, uses: row.useCount })),
            }
          : null,
        observed: observed
          ? {
              ...summarise(observed),
              bannerUrl: observed.bannerUrl,
              location: observed.location,
              website: observed.website,
              joinedAt: observed.joinedAt,
              // The full reading, examples included. This is the one place it
              // is worth the bytes.
              observations: observed.observations,
            }
          : null,
        /** What this agent has seen them say, and whether it answered. */
        said: said.map((row) => ({
          eventId: row.eventId,
          type: row.type,
          text: row.text,
          url: row.url,
          occurredAt: row.occurredAt,
          state: row.state,
          decision: row.decision,
          replyText: row.replyText,
          replyUrl: row.replyUrl,
          repliedAt: row.repliedAt,
          foundBy: row.foundBy,
        })),
      };
    }),
  );

  /**
   * Ask AI17Z to read somebody's account.
   *
   * Recorded, not performed: the API owns no browser. The worker claims this
   * and reads through the X intelligence layer, and the screen follows the
   * observation row.
   *
   * This is the only write on the People screen and it writes an intent to
   * read. There is no path from here to a follow, a like, a reply or a message
   * -- not by configuration and not by argument -- because the layer it ends up
   * in has none of those in it.
   */
  app.post(
    '/api/agents/:id/people/:handle/read',
    handler(async (request) => {
      const user = await requireUser(request);
      const agent = await ownedAgent(params(request).id!, user);
      const handle = Handle.parse(params(request).handle ?? '');
      const body = z
        .object({
          posts: z.number().int().min(0).max(200).optional(),
          refresh: z.boolean().optional(),
        })
        .parse(request.body ?? {});

      const owned = await accountsRepo.listAccounts(user.id);
      const reader = owned.find((a) => a.channel === 'x' && a.enabled) ?? null;
      if (!reader) {
        throw new BadRequestError(
          'AI17Z reads X through a signed-in browser, so it needs one of your X accounts connected first. ' +
            'Connect an account, sign in to it, and try again.',
        );
      }

      const task = await browserTasksRepo.enqueueBrowserTask({
        accountId: reader.id,
        kind: 'READ_X_ACCOUNT',
        requestedBy: user.id,
        params: {
          handle,
          ownerUserId: user.id,
          agentId: agent.id,
          ...(body.posts === undefined ? {} : { posts: body.posts }),
          ...(body.refresh ? { refresh: true } : {}),
        },
      });

      await ops.audit({
        actorUserId: user.id,
        action: 'people.read.requested',
        entityType: 'agent',
        entityId: agent.id,
        data: { handle, refresh: body.refresh === true },
      });

      return { queued: true, taskId: task.id, handle };
    }),
  );

  /**
   * Forget that somebody was looked up.
   *
   * A record of who an owner was curious about is theirs to delete. Nothing
   * else goes with it: the relationship is what passed between the agent and
   * them and is a different record with a different reason to exist.
   */
  app.delete(
    '/api/agents/:id/people/:handle',
    handler(async (request) => {
      const user = await requireUser(request);
      await ownedAgent(params(request).id!, user);
      const handle = Handle.parse(params(request).handle ?? '');
      const existing = await xAccountObservations.find({ ownerUserId: user.id, handle });
      if (!existing) throw new NotFoundError('Observation');
      await xAccountObservations.forget(user.id, existing.id);
      return { forgotten: true, handle };
    }),
  );
}
