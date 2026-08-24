import type { FastifyInstance } from 'fastify';
import { InjectMockEventInput } from '@xbam/shared/contracts';
import { BadRequestError, ForbiddenError, NotFoundError, newId } from '@xbam/shared';
import { agents as agentsRepo, type UserRow } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { handler, parseBody, requireUser } from '../http';

async function ownedAgent(agentId: string, user: UserRow) {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new NotFoundError('Agent');
  if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
  return agent;
}

/**
 * Injects an event on the mock channel.
 *
 * This is how the whole pipeline is exercised with no external service, and how
 * the first-run flow lets someone watch an agent think before connecting
 * anything real.
 */
export async function mockRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/mock/inject',
    handler(async (request) => {
      const user = await requireUser(request);
      const input = parseBody(InjectMockEventInput, request);
      const agent = await ownedAgent(input.agentId, user);
      if (agent.state === 'PAUSED') {
        throw new BadRequestError('This agent is paused. Resume it before injecting events.');
      }
      const remoteEventId = input.remoteEventId ?? `mock-${newId()}`;
      const conversationRef = input.conversationRef || remoteEventId;

      return ingestNormalizedEvent({
        accountId: input.accountId ?? null,
        onlyAgentId: agent.id,
        dryRun: input.dryRun,
        event: {
          channel: 'mock',
          type: 'MENTION',
          remoteEventId,
          remoteMessageId: remoteEventId,
          remoteAuthorId: `mock-user-${input.authorHandle.toLowerCase()}`,
          remoteAuthorHandle: input.authorHandle,
          remoteAuthorDisplayName: input.authorHandle,
          remoteConversationId: conversationRef,
          parentRemoteMessageId: null,
          remoteUrl: `mock://message/${remoteEventId}`,
          text: input.text,
          occurredAt: new Date().toISOString(),
          raw: { parentText: input.parentText, injectedBy: user.id },
        },
      });
    }),
  );
}
