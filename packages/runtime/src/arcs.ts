import type { ContextMessage, PolicyConfig } from '@xbam/shared/contracts';
import { createLogger, errorMessage, truncateTail } from '@xbam/shared';
import { arcs as arcsRepo } from '@xbam/database';
import { generate } from '@xbam/models';
import { candidateSubjects } from './stance';

const log = createLogger('arcs');

/**
 * Conversation arcs, narratives and the entity graph.
 *
 * Every turn used to be handled as though the thread had just started. An
 * argument that developed over six replies was re-derived from a transcript
 * each time — expensive, lossy, and the reason an agent could concede a point
 * and then argue it again two turns later.
 */

/** Rebuild the summary every this many turns. Summarising costs a model call. */
const RESUMMARISE_EVERY = 3;
/** Below this a transcript is short enough to speak for itself. */
const SUMMARISE_FROM_TURN = 3;

export interface ThreadContext {
  summary: string | null;
  mainTopic: string | null;
  openQuestion: string | null;
  resolvedPoints: string[];
  turnCount: number;
  participants: string[];
}

/**
 * Loads and, when it has drifted far enough, rebuilds the thread summary.
 *
 * Rebuilt on a cadence rather than every turn: a conversation does not change
 * shape between one reply and the next, and a summary per turn is a model call
 * per turn for something that was already true.
 */
export async function loadThreadContext(input: {
  agentId: string;
  remoteConversationId: string | null;
  conversationId?: string | null;
  participant?: string | null;
  thread: ContextMessage[];
  policy: PolicyConfig;
  jobId: string | null;
  allowModelCall: boolean;
}): Promise<ThreadContext | null> {
  if (!input.remoteConversationId) return null;

  const state = await arcsRepo.touchThread({
    agentId: input.agentId,
    remoteConversationId: input.remoteConversationId,
    conversationId: input.conversationId ?? null,
    participant: input.participant ?? null,
  });

  const stale = state.turnCount - state.summarisedAtTurn >= RESUMMARISE_EVERY;
  const worthSummarising = state.turnCount >= SUMMARISE_FROM_TURN && input.thread.length >= 3;

  if (stale && worthSummarising && input.allowModelCall) {
    const summarised = await summariseThread(input.thread, {
      agentId: input.agentId,
      jobId: input.jobId,
      maxCalls: input.policy.budget.maxModelCallsPerJob,
    });
    if (summarised) {
      await arcsRepo.saveThreadSummary({
        id: state.id,
        summary: summarised.summary,
        mainTopic: summarised.mainTopic,
        openQuestion: summarised.openQuestion,
        resolvedPoints: summarised.resolvedPoints,
        atTurn: state.turnCount,
      });
      return { ...summarised, turnCount: state.turnCount, participants: state.participants };
    }
  }

  return {
    summary: state.summary || null,
    mainTopic: state.mainTopic,
    openQuestion: state.openQuestion,
    resolvedPoints: state.resolvedPoints,
    turnCount: state.turnCount,
    participants: state.participants,
  };
}

interface ThreadSummary {
  summary: string;
  mainTopic: string | null;
  openQuestion: string | null;
  resolvedPoints: string[];
}

/**
 * Summarises a thread into the four things worth carrying forward.
 *
 * Structured output rather than prose, because "what is still unresolved" is
 * the part a reply actually needs and burying it in a paragraph makes it
 * something the model has to find again.
 */
async function summariseThread(
  thread: ContextMessage[],
  options: { agentId: string; jobId: string | null; maxCalls: number },
): Promise<ThreadSummary | null> {
  const transcript = thread
    .map((message) => `${message.role === 'OUTBOUND' ? 'You' : `@${message.authorHandle ?? 'them'}`}: ${message.text}`)
    .join('\n');

  const prompt = [
    'Summarise this conversation so it can be continued later without the full transcript.',
    '',
    'Reply with exactly four lines, each starting with the label:',
    'TOPIC: what the conversation is about, in a few words',
    'SETTLED: points already agreed or conceded, separated by semicolons, or "none"',
    'OPEN: the question still unresolved, or "none"',
    'SUMMARY: two sentences on what has happened',
    '',
    'TRANSCRIPT',
    truncateTail(transcript, 6_000),
  ].join('\n');

  try {
    const result = await generate({
      agentId: options.agentId,
      jobId: options.jobId,
      purpose: 'thread.summarise',
      // A summary is a classification job; it does not need the best model.
      role: 'classifier',
      maxCalls: options.maxCalls,
      messages: [{ role: 'user', content: prompt }],
    });

    const line = (label: string): string | null => {
      const match = result.text.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'));
      const value = match?.[1]?.trim();
      return !value || /^none$/i.test(value) ? null : value;
    };

    const summary = line('SUMMARY');
    if (!summary) return null;

    return {
      summary,
      mainTopic: line('TOPIC'),
      openQuestion: line('OPEN'),
      resolvedPoints: (line('SETTLED') ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6),
    };
  } catch (error) {
    // A thread with no summary still has its transcript. Losing the job over a
    // summarisation would be the wrong trade.
    log.warn('thread summary failed', { message: errorMessage(error) });
    return null;
  }
}

/**
 * Records the recurring things the agent is arguing.
 *
 * Detected from the subjects it keeps returning to, not from a fixed list: an
 * agent that has three ideas and recycles them endlessly is worse than one that
 * knows it already made that argument this week.
 */
export async function recordNarratives(agentId: string, text: string): Promise<void> {
  for (const subject of candidateSubjects(text)) {
    await arcsRepo.recordNarrative(agentId, subject).catch(() => undefined);
  }
}

/**
 * Notes the things a post mentioned, and that they came up together.
 *
 * The only claim is co-occurrence. Nothing here infers a relationship between
 * people or asserts anything about them beyond the fact that a post named both.
 */
export async function observeEntities(agentId: string, text: string): Promise<void> {
  const names = candidateSubjects(text);
  if (names.length === 0) return;

  const observed = [];
  for (const name of names) {
    observed.push(await arcsRepo.observeEntity({ agentId, kind: 'topic', name }));
  }
  for (let i = 0; i < observed.length; i += 1) {
    for (let j = i + 1; j < observed.length; j += 1) {
      await arcsRepo
        .observeEdge({ agentId, fromId: observed[i]!.id, toId: observed[j]!.id, relation: 'mentioned_with' })
        .catch(() => undefined);
      await arcsRepo
        .observeEdge({ agentId, fromId: observed[j]!.id, toId: observed[i]!.id, relation: 'mentioned_with' })
        .catch(() => undefined);
    }
  }
}
