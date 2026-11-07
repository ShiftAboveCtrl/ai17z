import type { PolicyConfig } from '@xbam/shared/contracts';
import { PipelineError } from '@xbam/shared';
import { actions as actionsRepo, devUpdates as repo } from '@xbam/database';
import { checkPostText } from './devUpdateSafety';
import { validateOutput } from './validator';

/**
 * The last word on a development update, at the moment of sending.
 *
 * The dispatcher checked all of this when it handed the update over, but a job
 * can wait a long time after that: at the agent's approval gate, behind a rate
 * limit, in quiet hours. Anything the owner changed in between has to count,
 * and text edited through the ordinary review queue has never seen the
 * development update rules at all. So the executor asks here, inside the
 * account lease, for every job whose event says it came from a development
 * update.
 *
 * Every outcome is durable, so nothing here can ask the same question twice:
 *
 * - Text that breaks a rule, or that the agent's validator rejects, stops for
 *   good. Nothing about waiting makes a credential safe to post.
 * - A validator finding that would send an ordinary post to review needs an
 *   owner decision: the update's own approval, or an approval on the job.
 *   Auto mode is not one.
 * - A project moved back to draft after an automatic approval needs the same.
 * - A project switched to rehearsal after the hand-over stops for good with
 *   that reason, rather than asking forever or publishing anyway.
 * - A paused project waits, so resuming lets it go.
 * - A project now wired to a different agent or account, or an update the
 *   owner withdrew, stops for good.
 * - The ceiling and the spacing are measured on real sends.
 */
export async function checkDevUpdateAtSend(input: {
  raw: unknown;
  jobId: string;
  agentId: string;
  accountId: string | null;
  dryRun: boolean;
  text: string;
  policy: PolicyConfig;
  operatorText: string;
}): Promise<void> {
  const raw = (input.raw ?? {}) as { origin?: unknown; devUpdateId?: unknown };
  if (raw.origin !== 'dev_update' || typeof raw.devUpdateId !== 'string') return;

  const refusals = checkPostText(input.text);
  const validation = validateOutput(input.text, input.policy, null, input.operatorText);
  const rejects = validation.violations.filter((v) => v.severity === 'REJECT').map((v) => v.message);
  if (refusals.length > 0 || rejects.length > 0) {
    throw PipelineError.permanent(
      'dev_update_unsafe',
      `This development update was stopped before sending: ${[...refusals.map((r) => r.message), ...rejects].join(' ')}`,
    );
  }

  const update = await repo.getUpdate(raw.devUpdateId);
  const project = update ? await repo.getProject(update.projectId) : null;
  if (!update || !project) {
    throw PipelineError.permanent('dev_update_missing', 'The development update or its project was removed before sending.');
  }
  if (update.status !== 'DISPATCHED') {
    throw PipelineError.permanent(
      'dev_update_withdrawn',
      `This development update is ${update.status.toLowerCase().replace(/_/g, ' ')}, so it was not sent.`,
    );
  }
  if (project.agentId !== input.agentId || project.accountId !== input.accountId) {
    throw PipelineError.permanent(
      'dev_update_remapped',
      'The project now posts through a different agent or account, so this update was not sent here.',
    );
  }
  if (input.dryRun) return;

  if (project.rehearse) {
    throw PipelineError.permanent(
      'dev_update_now_rehearsing',
      'The project was switched to rehearsal after this update was handed over, so it was not published.',
    );
  }
  if (!project.enabled) {
    throw PipelineError.retryable('dev_update_paused', 'The owner paused development updates for this project.', {
      retryAfterMs: 10 * 60_000,
    });
  }

  const gate = await actionsRepo.getApproval(input.jobId);
  const ownerDecided = update.decidedBy !== null || gate?.status === 'APPROVED';
  if (!ownerDecided) {
    const reviews = validation.violations.filter((v) => v.severity === 'REVIEW').map((v) => v.message);
    if (reviews.length > 0) {
      throw PipelineError.review('dev_update_needs_owner', `This development update needs the owner: ${reviews.join(' ')}`);
    }
    if (project.mode === 'DRAFT') {
      throw PipelineError.review(
        'dev_update_now_draft',
        'The project went back to draft mode after this update was approved automatically. It needs the owner now.',
      );
    }
  }

  // The ceiling and the spacing, on what was really sent. A limit that has not
  // cleared is a wait, not a failure: retryAfterMs charges no attempt.
  const sent = await repo.sentWindow(project.id, input.jobId);
  const now = Date.now();
  if (sent.lastDay >= project.dailyCap) {
    const frees = sent.oldestInDayAt ? new Date(sent.oldestInDayAt).getTime() + 24 * 3_600_000 - now : 3_600_000;
    throw PipelineError.retryable(
      'dev_update_daily_cap',
      `This project already posted ${sent.lastDay} of ${project.dailyCap} development updates in the last 24 hours.`,
      { retryAfterMs: Math.max(60_000, frees) },
    );
  }
  if (sent.lastSentAt) {
    const wait = new Date(sent.lastSentAt).getTime() + project.minSpacingMinutes * 60_000 - now;
    if (wait > 0) {
      throw PipelineError.retryable(
        'dev_update_spacing',
        `The last development update for this project went out less than ${project.minSpacingMinutes} minutes ago.`,
        { retryAfterMs: Math.max(60_000, wait) },
      );
    }
  }
}
