import type { MemoryPolicy, MemoryRecord, MemoryScope, RetrievedMemory } from '@xbam/shared/contracts';
import { keywords, uniqueBy } from '@xbam/shared';
import { memories as memoriesRepo } from '@xbam/database';

export interface RetrievalRequest {
  agentId: string;
  policy: MemoryPolicy;
  conversationId: string | null;
  remoteHandle: string | null;
  accountId: string | null;
  /** The incoming message; drives keyword relevance for PERSONA and KNOWLEDGE. */
  incomingText: string;
}

export interface RetrievalOutcome {
  memories: RetrievedMemory[];
  /** Per-scope counts, surfaced in the trace so an empty result is explainable. */
  byScope: Record<string, number>;
  terms: string[];
}

/** The document a knowledge chunk came from, when it is one. */
function originOf(memory: MemoryRecord): RetrievedMemory['origin'] {
  const raw = (memory as MemoryRecord & { origin?: unknown }).origin;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    path: text(o.path),
    heading: text(o.heading),
    revision: text(o.revision),
    sourceName: text(o.sourceName),
  };
}

function score(memory: MemoryRecord): number {
  return memory.pinned ? 1 : Math.max(0, Math.min(1, memory.importance));
}

/**
 * Deterministic, inspectable retrieval. Each scope is queried separately with its
 * own configured limit, and every selected memory carries the reason it was
 * chosen. There is no hidden ranking model here: relational filters and keyword
 * overlap only, which is why the trace can always answer "why this memory?".
 */
export async function retrieveMemories(request: RetrievalRequest): Promise<RetrievalOutcome> {
  const { policy, agentId } = request;
  const terms = keywords(request.incomingText, 12);
  const collected: Array<{ memory: MemoryRecord; reason: string }> = [];

  const push = (records: MemoryRecord[], reason: (m: MemoryRecord) => string) => {
    for (const memory of records) collected.push({ memory, reason: reason(memory) });
  };

  if (policy.retrieval.thread.enabled && request.conversationId) {
    const rows = await memoriesRepo.selectThreadMemories({
      agentId,
      limit: policy.retrieval.thread.limit,
      conversationId: request.conversationId,
    });
    // Thread memory reads newest-first from the database; restore chronology so
    // the prompt shows the conversation in the order it happened.
    push(rows.slice().reverse(), () => 'active conversation');
  }

  if (policy.retrieval.user.enabled && request.remoteHandle) {
    const rows = await memoriesRepo.selectUserMemories({
      agentId,
      limit: policy.retrieval.user.limit,
      remoteHandle: request.remoteHandle,
    });
    push(rows, (m) => (m.pinned ? `pinned memory about @${request.remoteHandle}` : `same remote user @${request.remoteHandle}`));
  }

  if (policy.retrieval.account.enabled && request.accountId) {
    const rows = await memoriesRepo.selectAccountMemories({
      agentId,
      limit: policy.retrieval.account.limit,
      accountId: request.accountId,
    });
    push(rows, () => 'shared account context');
  }

  const relevanceScopes: Array<[MemoryScope, { enabled: boolean; limit: number }, string]> = [
    ['PERSONA', policy.retrieval.persona, 'agent own history'],
    ['KNOWLEDGE', policy.retrieval.knowledge, 'knowledge base'],
    ['EPISODIC', policy.retrieval.episodic, 'long-term summary'],
  ];
  for (const [scope, config, label] of relevanceScopes) {
    if (!config.enabled) continue;
    const rows = await memoriesRepo.selectRelevantMemories(scope, {
      agentId,
      limit: config.limit,
      keywords: terms,
    });
    push(rows, (m) => {
      if (m.pinned) return `pinned ${label}`;
      const hit = terms.filter((t) => m.content.toLowerCase().includes(t));
      return hit.length > 0 ? `${label}: matches "${hit.slice(0, 3).join('", "')}"` : label;
    });
  }

  const deduped = uniqueBy(collected, (entry) => entry.memory.id);

  // Documents outrank remembered conversation.
  //
  // A knowledge chunk is the product's own documentation at a known revision;
  // an episodic memory is what somebody said about it once. When they disagree
  // -- "Ubuntu is not supported" said in March, against a page that says it is
  // verified in the version now installed -- the document is the one that is
  // still true, and the model reads what it is given in order.
  //
  // Ordering only. Nothing is discarded, so an agent can still say its
  // recollection differs from the documentation, which is a better answer than
  // either alone.
  const ordered = [...deduped].sort((a, b) => {
    const rank = (scope: MemoryScope) => (scope === 'KNOWLEDGE' ? 0 : scope === 'EPISODIC' ? 2 : 1);
    const byScope = rank(a.memory.scope) - rank(b.memory.scope);
    if (byScope !== 0) return byScope;
    return score(b.memory) - score(a.memory);
  });

  const memories: RetrievedMemory[] = ordered.map((entry, index) => ({
    memoryId: entry.memory.id,
    scope: entry.memory.scope,
    memoryType: entry.memory.memoryType,
    content: entry.memory.content,
    summary: entry.memory.summary,
    importance: entry.memory.importance,
    reason: entry.reason,
    score: score(entry.memory),
    rank: index + 1,
    createdAt: entry.memory.createdAt,
    origin: originOf(entry.memory),
  }));

  await memoriesRepo.touchAccessed(memories.map((m) => m.memoryId));

  const byScope: Record<string, number> = {};
  for (const memory of memories) byScope[memory.scope] = (byScope[memory.scope] ?? 0) + 1;

  return { memories, byScope, terms };
}
