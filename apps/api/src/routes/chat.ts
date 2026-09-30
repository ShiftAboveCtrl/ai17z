import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '@xbam/shared';
import { agents as agentsRepo, chat as chatRepo, type UserRow } from '@xbam/database';
import { collectDiagnostics } from '@xbam/tools';
import { addressedAgents, changeTargets, changesSince, confirmChange, declineChange, saveFromChat, undoChange } from '@xbam/runtime';
import { handler, params, parseBody, parseQuery, requireUser } from '../http';

/**
 * Owner chat. Every route is owner scoped: a conversation id from somebody
 * else's installation is Not Found, never Forbidden, so ids cannot be probed.
 * Answers are written by the worker; these routes only record what the owner
 * said and read back what is there.
 */

async function owned(user: UserRow, id: string) {
  const conversation = await chatRepo.getConversation(user.id, id);
  if (!conversation) throw new NotFoundError('Conversation');
  return conversation;
}

/**
 * Whether an agent can answer at all, in the words the chat header shows.
 *
 * Read once when a conversation opens, never per message: a turn must not
 * wait on diagnostics nobody asked for.
 */
async function readiness(agentId: string) {
  const d = await collectDiagnostics(agentId).catch(() => null);
  if (!d) return { state: 'UNKNOWN' as const, detail: 'Its state could not be read.' };
  const primary = d.models.find((m) => m.role === 'primary');
  // A role with no row at all is as unset as one with an empty model.
  if (!primary?.configured) {
    return { state: 'NOT_CONFIGURED' as const, detail: 'No model is set up, so it cannot answer yet.', fixAt: `/agents/${agentId}#intelligence` };
  }
  if (!d.agent.canWork) return { state: 'DEGRADED' as const, detail: `It can talk here, but is not working on its own: ${d.agent.reason ?? d.agent.state}.` };
  const failing = [...d.browser, ...d.radar, ...d.providers, ...d.knowledge].filter((p) => p.state === 'FAILING');
  if (failing.length > 0) return { state: 'DEGRADED' as const, detail: `${failing.length} part${failing.length === 1 ? '' : 's'} failing. Ask it what is broken.` };
  return { state: 'HEALTHY' as const, detail: 'Working.' };
}

const Create = z.object({
  agentIds: z.array(z.string().uuid()).min(1).max(chatRepo.MAX_ROOM_AGENTS),
  title: z.string().trim().max(120).optional(),
});

const Post = z.object({
  content: z.string().trim().min(1).max(8_000),
  /** Who should answer in a room. Absent reads @names in the message, then everybody. */
  to: z.union([z.literal('ALL'), z.array(z.string().uuid()).max(chatRepo.MAX_ROOM_AGENTS)]).optional(),
});

const Save = z.object({
  messageId: z.string().uuid().nullable().default(null),
  content: z.string().trim().min(1).max(20_000),
  agentIds: z.array(z.string().uuid()).min(1).max(chatRepo.MAX_ROOM_AGENTS),
  target: z.enum(['MEMORY', 'KNOWLEDGE']),
  about: z.enum(['WORLD', 'SELF']).default('WORLD'),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/chat/conversations',
    handler(async (request) => {
      const user = await requireUser(request);
      const query = parseQuery(z.object({ archived: z.enum(['true', 'false']).optional(), agentId: z.string().uuid().optional() }), request);
      return {
        conversations: await chatRepo.listConversations(user.id, { archived: query.archived === 'true', agentId: query.agentId ?? null }),
      };
    }),
  );

  app.post(
    '/api/chat/conversations',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(Create, request);
      const agentIds = [...new Set(body.agentIds)];
      const agents = [];
      for (const id of agentIds) {
        const agent = await agentsRepo.getAgent(id);
        if (!agent) throw new NotFoundError('Agent');
        if (agent.ownerId !== user.id) throw new ForbiddenError('That agent belongs to another owner.');
        agents.push(agent);
      }
      const kind = agents.length > 1 ? 'ROOM' : 'AGENT';
      const conversation = await chatRepo.createConversation({
        ownerId: user.id,
        kind,
        title: body.title || (kind === 'ROOM' ? agents.map((a) => a.name).join(', ') : `With ${agents[0]!.name}`),
        agentIds,
      });
      return { conversation };
    }),
  );

  app.get(
    '/api/chat/conversations/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const conversation = await owned(user, params(request).id!);
      const [participants, messages, saves] = await Promise.all([
        chatRepo.participants(conversation.id),
        chatRepo.listMessages(conversation.id),
        chatRepo.savesFor(conversation.id),
      ]);
      return { conversation, participants, messages, saves };
    }),
  );

  // Separate from the conversation, which is polled while answers are written.
  app.get(
    '/api/chat/conversations/:id/readiness',
    handler(async (request) => {
      const user = await requireUser(request);
      const conversation = await owned(user, params(request).id!);
      const participants = await chatRepo.participants(conversation.id);
      return {
        agents: await Promise.all(participants.map(async (p) => ({ agentId: p.agentId, ...(await readiness(p.agentId)) }))),
      };
    }),
  );

  app.patch(
    '/api/chat/conversations/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(z.object({ title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() }), request);
      const conversation = await chatRepo.updateConversation(user.id, params(request).id!, body);
      if (!conversation) throw new NotFoundError('Conversation');
      return { conversation };
    }),
  );

  app.delete(
    '/api/chat/conversations/:id',
    handler(async (request) => {
      const user = await requireUser(request);
      if (!(await chatRepo.deleteConversation(user.id, params(request).id!))) throw new NotFoundError('Conversation');
      return { deleted: true };
    }),
  );

  app.post(
    '/api/chat/conversations/:id/clear',
    handler(async (request) => {
      const user = await requireUser(request);
      await owned(user, params(request).id!);
      return { cleared: await chatRepo.clearMessages(user.id, params(request).id!) };
    }),
  );

  app.post(
    '/api/chat/conversations/:id/messages',
    handler(async (request) => {
      const user = await requireUser(request);
      const conversation = await owned(user, params(request).id!);
      if (conversation.archivedAt) throw new ValidationError('This conversation is archived. Unarchive it to keep talking.');
      const body = parseBody(Post, request);
      const participants = await chatRepo.participants(conversation.id);
      if (participants.length === 0) throw new ValidationError('Nobody is left in this conversation to answer.');
      const ordinary = addressedAgents(body.content, participants, body.to ?? null);
      // A change nobody was named for is asked about once, never applied to everybody.
      const targeting = changeTargets(body.content, participants, body.to ?? null, ordinary);
      if (targeting.clarification) {
        const posted = await chatRepo.postOwnerMessage({ conversationId: conversation.id, content: body.content, answerers: [] });
        const notice = await chatRepo.postNotice(conversation.id, targeting.clarification);
        return { ...posted, notice };
      }
      if (targeting.answerers.length === 0) throw new ValidationError('None of the agents named are in this conversation.');
      return chatRepo.postOwnerMessage({ conversationId: conversation.id, content: body.content, answerers: targeting.answerers });
    }),
  );

  app.post(
    '/api/chat/conversations/:id/stop',
    handler(async (request) => {
      const user = await requireUser(request);
      await owned(user, params(request).id!);
      return { stopped: await chatRepo.cancelPending(user.id, params(request).id!) };
    }),
  );

  app.post(
    '/api/chat/messages/:id/retry',
    handler(async (request) => {
      const user = await requireUser(request);
      const message = await chatRepo.requeueAnswer(user.id, params(request).id!);
      if (!message) throw new NotFoundError('An answer that can be tried again');
      return { message };
    }),
  );

  // Changes an agent made to itself because its owner asked in chat.
  app.get(
    '/api/agents/:id/changes',
    handler(async (request) => {
      const user = await requireUser(request);
      const query = parseQuery(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), request);
      const changes = await changesSince(params(request).id!, user.id, new Date(Date.now() - query.days * 86_400_000).toISOString());
      return { changes };
    }),
  );

  for (const [verb, act] of [
    ['confirm', confirmChange],
    ['decline', declineChange],
    ['undo', undoChange],
  ] as const) {
    app.post(
      `/api/agent-changes/:id/${verb}`,
      handler(async (request) => {
        const user = await requireUser(request);
        return act(params(request).id!, user.id);
      }),
    );
  }

  app.post(
    '/api/chat/conversations/:id/saves',
    handler(async (request) => {
      const user = await requireUser(request);
      const body = parseBody(Save, request);
      const saves = await saveFromChat({ ownerId: user.id, conversationId: params(request).id!, ...body });
      return { saves };
    }),
  );
}
