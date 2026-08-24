import type { MemoryPolicy } from '@xbam/shared/contracts';
import { createLogger, truncate } from '@xbam/shared';
import { memories as memoriesRepo, observability } from '@xbam/database';
import { extractUserFacts } from './extract';

const log = createLogger('memory-write');

export interface WriteContext {
  agentId: string;
  jobId: string;
  eventId: string;
  accountId: string | null;
  conversationId: string | null;
  remoteHandle: string | null;
  remoteUserId: string | null;
  policy: MemoryPolicy;
}

export interface WriteOutcome {
  threadWritten: number;
  userFactsWritten: number;
  personaWritten: number;
  facts: Array<{ content: string; rule: string }>;
}

function expiryFor(ttlDays: number | null): string | null {
  if (ttlDays === null) return null;
  return new Date(Date.now() + ttlDays * 86_400_000).toISOString();
}

/**
 * Applies the agent memory write policy after a turn completes.
 *
 * Thread memory records what was said. User memory records durable facts about
 * the person, which is what makes recall work across separate conversations,
 * the exact thing the legacy AI4CZ per-thread scheme could not do.
 */
export async function applyWritePolicy(
  ctx: WriteContext,
  turn: { incomingText: string; outgoingText: string },
): Promise<WriteOutcome> {
  const outcome: WriteOutcome = { threadWritten: 0, userFactsWritten: 0, personaWritten: 0, facts: [] };
  const { policy } = ctx;

  if (policy.write.thread.enabled && ctx.conversationId) {
    const handle = ctx.remoteHandle ?? 'them';
    const inbound = await memoriesRepo.writeMemory({
      agentId: ctx.agentId,
      scope: 'THREAD',
      memoryType: 'CONVERSATION_TURN',
      conversationId: ctx.conversationId,
      accountId: ctx.accountId,
      remoteHandle: ctx.remoteHandle,
      remoteUserId: ctx.remoteUserId,
      content: `${handle}: ${turn.incomingText}`,
      importance: 0.4,
      sourceEventId: ctx.eventId,
      sourceJobId: ctx.jobId,
    });
    if (inbound.created) outcome.threadWritten += 1;

    if (turn.outgoingText.trim()) {
      const outbound = await memoriesRepo.writeMemory({
        agentId: ctx.agentId,
        scope: 'THREAD',
        memoryType: 'CONVERSATION_TURN',
        conversationId: ctx.conversationId,
        accountId: ctx.accountId,
        remoteHandle: ctx.remoteHandle,
        remoteUserId: ctx.remoteUserId,
        content: `me: ${turn.outgoingText}`,
        importance: 0.4,
        sourceEventId: ctx.eventId,
        sourceJobId: ctx.jobId,
      });
      if (outbound.created) outcome.threadWritten += 1;
    }
  }

  if (policy.write.user.enabled && policy.write.user.extractor !== 'off' && ctx.remoteHandle) {
    if (policy.write.user.extractor === 'model') {
      // Not implemented yet: falling back to the heuristic is safer than silently
      // writing nothing, and the trace records that the fallback happened.
      log.warn('model-based memory extraction is not implemented; using heuristic', { agentId: ctx.agentId });
    }
    const facts = extractUserFacts(turn.incomingText, policy.write.user.minImportance);
    for (const fact of facts) {
      const written = await memoriesRepo.writeMemory({
        agentId: ctx.agentId,
        scope: 'USER',
        memoryType: fact.memoryType,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        remoteHandle: ctx.remoteHandle,
        remoteUserId: ctx.remoteUserId,
        content: fact.content,
        summary: truncate(fact.content, 160),
        importance: fact.importance,
        confidence: fact.confidence,
        sourceEventId: ctx.eventId,
        sourceJobId: ctx.jobId,
        expiresAt: expiryFor(policy.write.user.ttlDays),
      });
      if (written.created) {
        outcome.userFactsWritten += 1;
        outcome.facts.push({ content: fact.content, rule: fact.rule });
      }
    }
  }

  if (policy.write.persona.enabled && turn.outgoingText.trim()) {
    const written = await memoriesRepo.writeMemory({
      agentId: ctx.agentId,
      scope: 'PERSONA',
      memoryType: 'COMMITMENT',
      accountId: ctx.accountId,
      content: turn.outgoingText,
      summary: truncate(turn.outgoingText, 160),
      importance: 0.5,
      sourceEventId: ctx.eventId,
      sourceJobId: ctx.jobId,
    });
    if (written.created) outcome.personaWritten += 1;
  }

  await observability.emitTrace({
    jobId: ctx.jobId,
    agentId: ctx.agentId,
    type: 'MEMORY_WRITTEN',
    message: `Wrote ${outcome.threadWritten} thread, ${outcome.userFactsWritten} user, ${outcome.personaWritten} persona memories`,
    data: { facts: outcome.facts },
  });

  return outcome;
}
