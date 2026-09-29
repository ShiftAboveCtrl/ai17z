/**
 * Owner chat: the owner talking to their actual agent.
 *
 * Not a persona prompt in a chat box. The agent answers with its own persona,
 * identity policy, memories and beliefs, through the prompt engine, the model
 * gateway and the capability loop that everything else uses, and it can look
 * at its own workings through the owner-only `agent.*` capabilities. Nothing
 * here keeps a copy of agent state.
 *
 * ## What a conversation is not
 *
 * It is not memory. Every sentence the owner types stays in the conversation
 * unless the owner saves it (`saveFromChat`), and debugging chatter never
 * becomes part of who the agent is.
 *
 * ## Rooms
 *
 * Several agents, one transcript. Each agent answers with only its own
 * persona, memories, beliefs and capability permissions; what it sees of the
 * others is what they said in the room. Answers are queued only from an owner
 * message and never from an answer, and a room holds at most four agents, so
 * two agents cannot talk to each other for ever.
 *
 * ## Where it runs
 *
 * On the worker, claimed under a lease like every other unit of work. The
 * worker owns the browsers, so a lookup an answer needs can actually happen,
 * and a worker that dies mid-answer leaves it to be taken again.
 */
import {
  agents as agentsRepo,
  chat as chatRepo,
  knowledge as knowledgeRepo,
  memories as memoriesRepo,
  ops,
  prompts as promptsRepo,
  stances as stancesRepo,
  type ChatMessage,
  type ChatParticipant,
} from '@xbam/database';
import { NotFoundError, ValidationError, createLogger, errorMessage } from '@xbam/shared';
import type { PolicyConfig } from '@xbam/shared/contracts';
import { StanceContext } from '@xbam/shared/contracts';
import { assemblePrompt, CHAT_TEMPLATE_KEY } from '@xbam/prompts';
import { generate, type GenerateResult } from '@xbam/models';
import { retrieveMemories, looksLikeSecret } from '@xbam/memory';
import { runCapabilityLoop } from './capabilityLoop';
import { capabilitySettings } from './capabilityPermissions';
import { pauseState } from './killSwitch';
import { checkBudget } from './policyGate';
import { validateOutput } from './validator';
import { indexSource } from './knowledge';

const log = createLogger('owner-chat');

/** Long enough for a lookup and a few model calls; a worker that dies is retaken after it. */
export const CHAT_LEASE_MS = 3 * 60_000;

/** How much of the conversation an answer is written against. */
const TRANSCRIPT_MESSAGES = 16;
const TRANSCRIPT_CHARS_EACH = 1_200;

/**
 * Which agents an owner message is for.
 *
 * One agent's conversation is always that agent. In a room the owner names
 * who should answer: "all", a list, or an @name in the message. A message
 * that names nobody is for everybody, bounded by the room size.
 */
export function addressedAgents(
  content: string,
  participants: Pick<ChatParticipant, 'agentId' | 'name' | 'slug'>[],
  to: 'ALL' | string[] | null,
): string[] {
  if (participants.length <= 1) return participants.map((p) => p.agentId);
  if (to === 'ALL') return participants.map((p) => p.agentId);
  if (Array.isArray(to) && to.length > 0) {
    const wanted = new Set(to);
    return participants.filter((p) => wanted.has(p.agentId)).map((p) => p.agentId);
  }
  const lower = content.toLowerCase();
  const named = participants.filter((p) => {
    const handles = [p.slug, p.name.replace(/\s+/g, '')].map((h) => `@${h.toLowerCase()}`);
    return handles.some((h) => new RegExp(`${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).test(lower));
  });
  return (named.length > 0 ? named : participants).map((p) => p.agentId);
}

/** The conversation before this answer, as the prompt engine reads a thread. */
function transcriptFor(
  messages: ChatMessage[],
  answer: ChatMessage,
  names: Map<string, string>,
): { thread: { role: 'INBOUND' | 'OUTBOUND'; authorHandle: string; text: string }[]; question: string } {
  const own = messages.findIndex((m) => m.id === answer.id);
  const before = (own === -1 ? messages : messages.slice(0, own)).filter(
    (m) => m.status === 'DONE' && m.content.trim().length > 0 && m.authorKind !== 'NOTICE',
  );
  const questionIndex = before.findIndex((m) => m.id === answer.answers);
  const question = questionIndex === -1 ? '' : before[questionIndex]!.content;
  const thread = before
    .filter((m) => m.id !== answer.answers)
    .slice(-TRANSCRIPT_MESSAGES)
    .map((m) => ({
      role: m.agentId === answer.agentId ? ('OUTBOUND' as const) : ('INBOUND' as const),
      authorHandle: m.authorKind === 'OWNER' ? 'Owner' : (names.get(m.agentId ?? '') ?? 'Another agent'),
      text: m.content.slice(0, TRANSCRIPT_CHARS_EACH),
    }));
  return { thread, question };
}

/**
 * The owner's policy, shaped for a private conversation.
 *
 * Length, link, hashtag and mention rules fit a public post and would cut an
 * owner's answer in half. Identity, disclosure, banned phrases, emoji and
 * addresses are unchanged, because those are about what the agent is rather
 * than where it is speaking.
 */
export function chatPolicy(policy: PolicyConfig): PolicyConfig {
  return {
    ...policy,
    output: {
      ...policy.output,
      maxCharacters: 6_000,
      minCharacters: 1,
      forbidLinks: false,
      forbidHashtags: false,
      forbidMentionsOfOthers: false,
    },
  };
}

function trimForEvidence(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= 4_000) return value;
  return { truncated: true, preview: text.slice(0, 4_000) };
}

export interface ChatTurnOutcome {
  status: 'DONE' | 'FAILED';
  content: string;
  evidence: Record<string, unknown>;
  error: string | null;
}

/** Writes one agent's answer. Never throws: a failure is an answer that says so. */
export async function writeAnswer(answer: ChatMessage): Promise<ChatTurnOutcome> {
  const failed = (error: string, evidence: Record<string, unknown> = {}): ChatTurnOutcome => ({
    status: 'FAILED',
    content: '',
    evidence,
    error,
  });
  try {
    if (!answer.agentId) return failed('That agent no longer exists.');
    const conversation = await chatRepo.conversationById(answer.conversationId);
    if (!conversation) return failed('The conversation was deleted.');
    const agent = await agentsRepo.getAgent(answer.agentId);
    if (!agent) return failed('That agent no longer exists.');
    const [persona, policyRow, template, participants, messages] = await Promise.all([
      agentsRepo.getActivePersona(agent.id),
      agentsRepo.getActivePolicy(agent.id),
      promptsRepo.getActiveTemplate(CHAT_TEMPLATE_KEY),
      chatRepo.participants(conversation.id),
      chatRepo.listMessages(conversation.id, 400),
    ]);
    if (!persona) return failed(`${agent.name} has no persona yet, so there is nobody to answer. Set one up on its page.`);
    if (!policyRow) return failed(`${agent.name} has no policy, so there is nothing to check an answer against.`);
    if (!template) return failed('The owner chat prompt is missing. Restarting AI17Z restores it.');
    const policy = policyRow.config as PolicyConfig;

    const names = new Map(participants.map((p) => [p.agentId, p.name]));
    const { thread, question } = transcriptFor(messages, answer, names);
    if (!question.trim()) return failed('There is no question for this answer any more.');

    const budget = await checkBudget(agent.id, policy);
    if (!budget.allow) return failed(budget.message ?? 'This agent is over its model budget for now.');

    // Only this agent's own memories and beliefs, whoever else is in the room.
    const [retrieved, stanceRows] = await Promise.all([
      retrieveMemories({
        agentId: agent.id,
        policy: policy.memory,
        conversationId: null,
        remoteHandle: null,
        accountId: null,
        incomingText: question,
      }).catch(() => ({ memories: [], byScope: {}, terms: [] })),
      stancesRepo.relevantTo(agent.id, question, 4).catch(() => []),
    ]);
    const stance = StanceContext.parse({
      relevant: stanceRows.map((s) => ({
        subject: s.subject,
        position: s.position,
        summary: s.summary,
        confidence: s.confidence,
        heldSince: s.createdAt,
      })),
    });

    const others = participants.filter((p) => p.agentId !== agent.id).map((p) => p.name);
    const prompt = assemblePrompt({
      layers: template.layers,
      templateKey: template.templateKey,
      templateVersion: template.version,
      persona,
      policy,
      context: {
        targetRef: null,
        targetUrl: null,
        targetAuthorHandle: 'Owner',
        conversationRef: null,
        incomingText: question,
        parentText: null,
        thread,
        conversation: null,
        meta: { stance },
      } as never,
      memories: retrieved.memories,
      channelName: 'AI17Z',
      toolDescriptions: [],
      memoryCharBudget: policy.memory.retrieval.totalCharBudget,
      actionType: 'CHAT',
      room: conversation.kind === 'ROOM' ? { others } : null,
    });

    let last: GenerateResult | null = null;
    const settings = await capabilitySettings(agent.id);
    /*
      The loop runs whether or not the owner turned it on for public replies.
      That switch is about what an agent may reach for while answering
      strangers; here the owner is asking about the agent itself, and each
      capability is still subject to its own permission.
    */
    const loop = await runCapabilityLoop({
      agentId: agent.id,
      jobId: null,
      accountId: null,
      messages: prompt.messages,
      task: question,
      generate: async (messagesSoFar) => {
        last = await generate({
          agentId: agent.id,
          jobId: null,
          purpose: 'CHAT',
          messages: messagesSoFar,
          promptLayers: prompt.layers,
          promptText: prompt.promptText,
          maxCalls: 1,
        });
        return last.text;
      },
      permissions: settings.permissions,
      configs: settings.configs,
      paused: (await pauseState().catch(() => ({ paused: false }))).paused,
      audience: 'OWNER',
    });

    const validated = validateOutput(loop.answer, chatPolicy(policy), null, [persona.biography, persona.customInstructions].join('\n'));
    const model = last as GenerateResult | null;
    const evidence = {
      model: model ? { provider: model.provider, model: model.model, role: model.role, latencyMs: model.latencyMs } : null,
      offered: loop.shortlist.offered.map((c) => c.id),
      capabilities: loop.steps.map((s) => ({
        id: s.capabilityId,
        outcome: s.outcome,
        detail: s.detail,
        durationMs: s.durationMs,
        output: trimForEvidence(s.output),
      })),
      memories: retrieved.memories.slice(0, 12).map((m) => ({
        id: m.memoryId,
        scope: m.scope,
        text: (m.summary ?? m.content).slice(0, 240),
        source: m.origin?.path ?? null,
      })),
      beliefs: stance.relevant.map((s) => s.subject),
      usedLiveState: loop.steps.some((s) => s.outcome === 'SUCCEEDED'),
      exhausted: loop.exhausted,
      corrections: validated.violations.map((v) => v.message),
    };
    if (!validated.ok) {
      return failed(
        `AI17Z held this answer back: ${validated.violations.map((v) => v.message).join(' ')}`,
        evidence,
      );
    }
    return { status: 'DONE', content: validated.output, evidence, error: null };
  } catch (error) {
    log.warn('chat answer failed', { answerId: answer.id, message: errorMessage(error) });
    return failed(errorMessage(error));
  }
}

/**
 * One claimed answer, written and settled. Returns whether there was one, so
 * the worker loop can keep going while there is more to answer.
 */
export async function answerNextChatTurn(workerId: string): Promise<boolean> {
  const answer = await chatRepo.claimNextAnswer(workerId, CHAT_LEASE_MS);
  if (!answer) return false;
  const outcome = await writeAnswer(answer);
  const settled = await chatRepo.settleAnswer(answer.id, workerId, outcome);
  if (!settled) log.warn('chat answer was taken over before it settled', { answerId: answer.id });
  return true;
}

/** Answers what is waiting, a few at a time, for the worker's loop. */
export async function sweepOwnerChat(workerId: string, max = 4): Promise<number> {
  let answered = 0;
  while (answered < max && (await answerNextChatTurn(workerId))) answered += 1;
  return answered;
}

// ── Saving ───────────────────────────────────────────────────────────────────

export interface SaveRequest {
  ownerId: string;
  conversationId: string;
  messageId: string | null;
  content: string;
  /** Which agents to give it to. Each must be in the conversation. */
  agentIds: string[];
  /**
   * MEMORY puts it in each agent's own memory, as something about the world
   * (KNOWLEDGE scope) or about itself (PERSONA scope). KNOWLEDGE makes it a
   * knowledge source each chosen agent reads, which is how a room's shared
   * conclusion reaches the agents the owner picked and nobody else.
   */
  target: 'MEMORY' | 'KNOWLEDGE';
  about?: 'WORLD' | 'SELF';
}

/**
 * Keeps something from a conversation, because the owner asked.
 *
 * The only path from a conversation into durable memory. Refuses anything that
 * looks like a secret, since memory is rendered into prompts that go to a
 * model provider.
 */
export async function saveFromChat(request: SaveRequest) {
  const conversation = await chatRepo.getConversation(request.ownerId, request.conversationId);
  if (!conversation) throw new NotFoundError('Conversation');
  const content = request.content.trim();
  if (!content) throw new ValidationError('There is nothing to save.');
  if (content.length > 20_000) throw new ValidationError('That is too long to save as one memory.');
  const secret = looksLikeSecret(content);
  if (secret) throw new ValidationError(`That looks like it contains a secret (${secret}), so it was not saved.`);
  const members = new Set((await chatRepo.participants(conversation.id)).map((p) => p.agentId));
  const agentIds = [...new Set(request.agentIds)].filter((id) => members.has(id));
  if (agentIds.length === 0) throw new ValidationError('Choose at least one agent in this conversation to save it to.');

  const saves = [];
  for (const agentId of agentIds) {
    if (request.target === 'MEMORY') {
      const written = await memoriesRepo.writeMemory({
        agentId,
        scope: request.about === 'SELF' ? 'PERSONA' : 'KNOWLEDGE',
        memoryType: 'FACT',
        content,
        summary: null,
        importance: 0.7,
        pinned: false,
      });
      saves.push(
        await chatRepo.recordSave({
          conversationId: conversation.id,
          messageId: request.messageId,
          agentId,
          target: 'MEMORY',
          memoryId: written.memory.id,
          knowledgeSourceId: null,
          content,
          savedBy: request.ownerId,
        }),
      );
    } else {
      const source = await knowledgeRepo.createSource({
        agentId,
        name: `From ${conversation.kind === 'ROOM' ? 'the room' : 'chat'}: ${conversation.title || 'untitled'}`.slice(0, 120),
        kind: 'TEXT',
        location: content,
      });
      await indexSource(source);
      saves.push(
        await chatRepo.recordSave({
          conversationId: conversation.id,
          messageId: request.messageId,
          agentId,
          target: 'KNOWLEDGE',
          memoryId: null,
          knowledgeSourceId: source.id,
          content,
          savedBy: request.ownerId,
        }),
      );
    }
    await ops.audit({
      actorUserId: request.ownerId,
      action: 'chat.saved',
      entityType: 'agent',
      entityId: agentId,
      data: { agentId, conversationId: conversation.id, target: request.target },
    });
  }
  return saves;
}
