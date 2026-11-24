import { randomUUID } from 'node:crypto';
import { agents, chat, events, jobs, observability, withTransaction, type ChatMessage } from '@xbam/database';
import type { CapabilityContext } from '@xbam/tools';
import { withCallSignal } from '@xbam/shared';
import { DELEGATION_TIMEOUT_MS } from './delegationCapability';
import { writeAnswer, type ChatWorkerOptions, type ChatTurnOutcome } from './ownerChat';

async function recordJob(answer: ChatMessage, agentId: string, side: string): Promise<string> {
  const agent = await agents.requireAgent(agentId);
  return withTransaction(async tx => {
    const { event } = await events.ingestEvent(tx, null, {
      channel: 'http', type: 'SCHEDULED_TRIGGER', remoteEventId: `chat:${answer.id}:${side}`,
      remoteMessageId: answer.id, remoteAuthorId: null, remoteAuthorHandle: null,
      remoteAuthorDisplayName: null, remoteConversationId: answer.conversationId,
      parentRemoteMessageId: answer.answers, remoteUrl: null, text: 'Bounded owner room delegation.',
      occurredAt: new Date().toISOString(), raw: { origin: 'room-delegation' },
    });
    const { job } = await jobs.createJob(tx, {
      eventId: event.id, agentId, accountId: null, channel: 'http', actionType: 'NONE',
      idempotencyKey: `room-delegation:${answer.id}:${side}`, dryRun: true, maxAttempts: 1,
      personaVersionId: agent.personaVersionId, policyVersionId: agent.policyVersionId,
      pipelineVersionId: agent.pipelineVersionId, promptTemplateVersionId: null, requiresBrowser: false,
    });
    // These jobs describe inline chat work. A terminal status prevents a worker
    // from ever executing them, including after a crash between model calls.
    await jobs.updateJob(job.id, { status: 'CANCELLED', lastError: 'Inline room work has not settled.' }, tx);
    return job.id;
  });
}

export function roomDelegation(answer: ChatMessage, options: ChatWorkerOptions): NonNullable<CapabilityContext['delegation']> {
  return {
    async run(agentId, task, signal) {
      const conversation = await chat.conversationById(answer.conversationId);
      const participants = await chat.participants(answer.conversationId);
      const source = answer.answers ? await chat.getMessage(answer.answers) : null;
      const [delegator, delegate] = await Promise.all([
        answer.agentId ? agents.getAgent(answer.agentId) : null, agents.getAgent(agentId),
      ]);
      if (signal.aborted || conversation?.kind !== 'ROOM' || conversation.archivedAt ||
        source?.authorKind !== 'OWNER' || source.conversationId !== conversation.id ||
        delegator?.ownerId !== conversation.ownerId || delegate?.ownerId !== conversation.ownerId ||
        agentId === answer.agentId || !participants.some(p => p.agentId === agentId) ||
        !participants.some(p => p.agentId === answer.agentId)) {
        throw new Error('Delegation requires another agent belonging to this owner in the same active room.');
      }
      if (!await chat.claimDelegation(answer.id, agentId)) {
        throw new Error('This turn has already used its one delegation, or is itself delegated.');
      }
      const parentJobId = await recordJob(answer, delegator.id, 'delegator');
      const jobId = await recordJob(answer, agentId, 'delegate');
      const deadline = Date.now() + DELEGATION_TIMEOUT_MS;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(cancel, DELEGATION_TIMEOUT_MS);
      const failed = (reason: string): ChatTurnOutcome => ({ status: 'FAILED', content: '', evidence: {}, error: reason });
      let onAbort: (() => void) | undefined;
      let outcome: ChatTurnOutcome;
      try {
        // The delegate receives identifiers and the bounded question only. No
        // delegator prompt, policy, retrieved memory or capability results cross.
        outcome = await Promise.race([
          withCallSignal(controller.signal, () => writeAnswer({ ...answer, id: randomUUID(), agentId }, options,
            { task, jobId, signal: controller.signal, deadline })),
          new Promise<ChatTurnOutcome>(resolve => {
            onAbort = () => resolve(failed('The delegated task timed out or was cancelled.'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      }
      if (controller.signal.aborted || Date.now() >= deadline) outcome = failed('The delegated task timed out or was cancelled.');
      if (outcome.status === 'HANDOFF') outcome = failed('The delegated task needs a browser worker; no additional turn was queued.');
      const detail = outcome.status === 'DONE'
        ? 'The delegate answered the bounded task as itself using its own state and gates.'
        : `The delegate did not answer. ${outcome.error ?? 'A required gate stopped the task.'}`;
      await chat.postDelegatedAnswer({
        conversationId: conversation.id, agentId, ownerMessageId: source.id,
        status: outcome.status === 'DONE' ? 'DONE' : 'FAILED', content: outcome.content,
        error: outcome.error, evidence: { ...outcome.evidence, delegatedFrom: answer.id, jobId, parentJobId, task, detail },
      });
      for (const [id, actor, otherJobId, side] of [
        [parentJobId, delegator.id, jobId, 'delegator'], [jobId, agentId, parentJobId, 'delegate'],
      ] as const) {
        await jobs.updateJob(id, { status: outcome.status === 'DONE' ? 'EXECUTED' : 'PERMANENT_FAILURE',
          lastError: outcome.error, validatedOutput: side === 'delegate' ? outcome.content : null });
        await observability.emitTrace({ jobId: id, agentId: actor, type: 'CAPABILITY_USED', message: detail,
          data: { capabilityId: 'room.delegate', side, otherJobId, conversationId: conversation.id, answerId: answer.id } });
      }
      // Evidence stays on the delegate's own answer. Only its validated speech
      // returns to the delegator, just as speech in the shared transcript does.
      return { agentId, content: outcome.content, detail, jobId };
    },
  };
}
