import { accounts as accountsRepo, agents, autonomy as autonomyRepo, events as eventsRepo, jobs as jobsRepo, observability, prompts as promptsRepo, query, withTransaction, type RadarSourceRow } from '@xbam/database';
import { getChannelAdapter } from '@xbam/channels';
import { createLogger, errorMessage, PipelineError, sha256Hex } from '@xbam/shared';
import { PolicyConfig, StudioRiskWatch, EVIDENCE_FOLLOW_UP_DAILY_CAP, EVIDENCE_FOLLOW_UP_MAX_AGE_MS, EVIDENCE_FOLLOW_UP_ORIGIN, isEvidenceFollowUpEvent } from '@xbam/shared/contracts';
import { readingAvailable, type CardReading } from '@xbam/prompts';
import { exchangeLimit, recentRepliesTo } from './engagement';
import { receiptGate } from './radarReceipts';
import { unpromptedSubject, reticenceReason } from './reticence';
import { isAutomatedCounterpart } from './steps/social';
import { studioRiskSourceRefusal, watchRevision } from './studioRiskWatches';
import type { FollowUpObservation } from './evidenceFollowUpOffer';
import type { EvidenceCard } from './evidenceCard';
import type { JobBundle } from './loadJob';

const log = createLogger('evidence-follow-up');

function followUpIdOf(payload: unknown): string | null {
  const id = (payload as { evidenceFollowUpId?: unknown } | null)?.evidenceFollowUpId;
  return typeof id === 'string' ? id : null;
}

const KINDS = {
  LIQUIDITY_BELOW: { label: 'Liquidity', cardLabel: 'Liquidity', unit: 'USD', words: 'liquidity below' },
  TOP_HOLDERS_ABOVE: { label: 'Top holders', cardLabel: 'Top holders', unit: '%', words: 'top holder share above' },
  // The card never carried this number, so "at card" is stated as unavailable rather than guessed.
  DEVELOPER_SHARE_ABOVE: { label: 'Developer share', cardLabel: null, unit: '%', words: 'developer share above' },
} as const;

const minute = (iso: string | null | undefined): string | null => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16)}Z` : null;
};
const num = (value: number): string => String(Number(value.toFixed(2)));

/** Pure in its record, so the sweep and the send check render the same text whenever they run. */
function describeRead(read: { value: number; observedAt: string } | null, source: string, unit: string): string {
  const time = minute(read?.observedAt);
  // No time or a number that is not a measurement is "unavailable", never zero.
  if (!read || !time || !Number.isFinite(read.value) || read.value < 0) return 'unavailable';
  return `${num(read.value)} ${unit} (${source}, ${time})`;
}

/**
 * The follow-up, rebuilt from the Studio observation and the reading the card itself recorded.
 *
 * A fixed template: what was read before, at the card and now, each with its source and time, and
 * the condition the owner confirmed. It states what changed and nothing about what to do, and no
 * model writes any of it, so a rewrite cannot remove a number.
 */
export function evidenceFollowUpText(input: {
  watch: Pick<StudioRiskWatch, 'kind' | 'threshold'>; observation: FollowUpObservation; cardReadings: CardReading[]; now?: number;
}): string | null {
  const now = input.now ?? Date.now();
  const meta = KINDS[input.watch.kind];
  const current = describeRead(input.observation.now, input.observation.source, meta.unit);
  // Nothing to say without a current, timed reading, and a reading from the future is not one.
  if (current === 'unavailable' || Date.parse(input.observation.now.observedAt) > now + 30_000) return null;
  const recorded = meta.cardLabel ? input.cardReadings.find(r => r.label === meta.cardLabel) : undefined;
  const fetched = Date.parse(recorded?.fetchedAt ?? '');
  // The card's reading counts as it stood when it was fetched; whether it is current today is the point of the follow-up.
  const atCard = recorded && typeof recorded.value === 'number' && Number.isFinite(fetched) && readingAvailable(recorded, fetched)
    ? describeRead({ value: recorded.value, observedAt: recorded.fetchedAt! }, recorded.source, meta.unit) : 'unavailable';
  return [
    `Evidence update on this card, ${meta.label} (UTC)`,
    `Before: ${describeRead(input.observation.before, input.observation.source, meta.unit)}`,
    `At card: ${atCard}`,
    `Now: ${current}`,
    `Condition: ${meta.words} ${num(input.watch.threshold)} ${meta.unit}. Not a verdict, reads can be wrong.`,
  ].join('\n');
}

interface Row extends Record<string, unknown> {
  id: string; card_job_id: string; agent_id: string; source_id: string; observation: FollowUpObservation;
  status: string; created_at: string; source_config: RadarSourceRow['config'];
  watch_confirmed: unknown; card_readings: CardReading[] | null; card_account_id: string; card_channel: string; card_conversation_id: string | null;
  ev_remote_message_id: string | null; ev_remote_url: string | null; ev_author_id: string | null; ev_author_handle: string | null;
  ev_author_display: string | null; ev_conversation_id: string | null; ev_parent_id: string | null; ev_text: string; published: boolean;
}

const ROW_SQL = `SELECT f.*, s.config AS source_config, r.watch_confirmed,
    j.resolved_context->'meta'->'evidenceCard'->'readings' AS card_readings,
    j.account_id AS card_account_id, j.channel AS card_channel, j.conversation_id AS card_conversation_id,
    e.remote_message_id AS ev_remote_message_id, e.remote_url AS ev_remote_url, e.remote_author_id AS ev_author_id,
    e.remote_author_handle AS ev_author_handle, e.remote_author_display AS ev_author_display,
    e.remote_conversation_id AS ev_conversation_id, e.parent_remote_message_id AS ev_parent_id, e.text AS ev_text,
    (j.status='EXECUTED' AND EXISTS(SELECT 1 FROM actions a WHERE a.job_id=j.id AND a.status='EXECUTED' AND NOT a.dry_run)) AS published
  FROM evidence_followups f
  JOIN radar_sources s ON s.id=f.source_id
  JOIN evidence_card_requests r ON r.job_id=f.card_job_id
  JOIN jobs j ON j.id=f.card_job_id
  JOIN events e ON e.id=j.event_id`;

type Decision = { skip: string } | { wait: string; afterMs: number } | { go: { text: string; row: Row } };

/** Every reason this crossing may not be said, in one place so the send check can ask the same questions. */
async function decide(row: Row, now: Date): Promise<Decision> {
  const age = now.getTime() - Date.parse(row.observation.now.observedAt);
  if (!Number.isFinite(age) || age > EVIDENCE_FOLLOW_UP_MAX_AGE_MS) return { skip: 'The reading is older than thirty minutes or has no source time; it is history, not news.' };
  const policy = await agents.getActivePolicy(row.agent_id);
  const config = policy ? PolicyConfig.parse(policy.config) : null;
  if (!config?.tools.evidenceFollowUps || !config.tools.evidenceCards) return { skip: 'Evidence follow-ups were switched off.' };
  const studio = await studioRiskSourceRefusal({ id: row.source_id, config: row.source_config });
  if (studio) return { skip: `${studio} Nothing is sent without a reachable, current Studio watch.` };
  const confirmed = StudioRiskWatch.safeParse(row.watch_confirmed);
  const meta = row.source_config.studioRisk;
  if (!confirmed.success || !meta || confirmed.data.id !== meta.watchId || watchRevision(confirmed.data) !== meta.watchRevision || confirmed.data.kind !== row.observation.kind) {
    return { skip: 'The watch the owner confirmed on this card is no longer the watch that crossed.' };
  }
  if (!row.published) return { skip: 'The card was never published, so there is no thread to continue.' };
  if (!row.ev_remote_message_id && !row.ev_remote_url) return { skip: 'The original post has no address to reply under.' };
  const handle = row.ev_author_handle;
  if (handle && await autonomyRepo.findDoNotContact(row.agent_id, row.card_channel, handle).catch(() => null)) {
    return { skip: `@${handle.replace(/^@+/, '')} asked this agent to stop contacting them.` };
  }
  const account = await accountsRepo.getAccount(row.card_account_id);
  const automated = await isAutomatedCounterpart(row.card_channel, handle, config, account?.handle);
  const [ours] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM actions a JOIN jobs j ON j.id=a.job_id
    WHERE a.agent_id=$1 AND a.status='EXECUTED' AND NOT a.dry_run AND j.conversation_id IS NOT NULL AND j.conversation_id=$2`, [row.agent_id, row.card_conversation_id]);
  const limit = exchangeLimit({ recentRepliesToPerson: await recentRepliesTo(row.agent_id, handle), ourRepliesInThread: ours?.n ?? 0,
    threadDepth: 2 * (ours?.n ?? 0), counterpartAutomated: Boolean(automated), policy: config.engagement });
  if (limit) return { skip: limit };
  const retry = { afterMs: 0 };
  const gate = await receiptGate(row.agent_id, row.card_account_id, now, retry);
  if (gate) return retry.afterMs > 0 ? { wait: gate, afterMs: retry.afterMs } : { skip: gate };
  const text = evidenceFollowUpText({ watch: confirmed.data, observation: row.observation, cardReadings: row.card_readings ?? [], now: now.getTime() });
  if (!text) return { skip: 'The current reading is unavailable; nothing is said.' };
  const subject = unpromptedSubject(text);
  if (subject) return { skip: reticenceReason(subject) };
  if (text.length > config.output.maxCharacters) return { skip: `The update is ${text.length} characters and this agent's limit is ${config.output.maxCharacters}; it is skipped, never cut.` };
  return { go: { text, row } };
}

/**
 * Turns offered crossings into follow-up jobs. No timer: the radar tick and the wake call it.
 *
 * It reads nothing from X and nothing from Studio. The numbers were recorded when the crossing
 * was, and a crossing too old to be news is dropped rather than refreshed.
 */
export async function processEvidenceFollowUps(agentId: string, now = new Date()): Promise<void> {
  const due = await query<Row>(`${ROW_SQL} WHERE f.agent_id=$1 AND f.status='pending' AND f.next_attempt_at<=$2 ORDER BY f.created_at LIMIT 6`, [agentId, now]);
  for (const row of due) {
    let decision: Decision;
    try { decision = await decide(row, now); }
    catch (error) { decision = { wait: `Could not be checked: ${errorMessage(error).slice(0, 200)}`, afterMs: 60_000 }; }
    if ('skip' in decision) {
      await query("UPDATE evidence_followups SET status='skipped', reason=$2 WHERE id=$1 AND status='pending'", [row.id, decision.skip.slice(0, 500)]);
      continue;
    }
    if ('wait' in decision) {
      // Bounded by the age check on the next pass: waiting cannot turn history into news.
      await query("UPDATE evidence_followups SET reason=$2, next_attempt_at=$3 WHERE id=$1 AND status='pending'",
        [row.id, decision.wait.slice(0, 500), new Date(now.getTime() + Math.max(60_000, decision.afterMs))]);
      continue;
    }
    const outcome = await queueFollowUp(decision.go.row, now).catch(error => ({ reason: `Could not be queued: ${errorMessage(error).slice(0, 200)}`, retry: true }));
    if (outcome?.retry) {
      await query("UPDATE evidence_followups SET reason=$2, next_attempt_at=$3 WHERE id=$1 AND status='pending'",
        [row.id, outcome.reason, new Date(now.getTime() + 60_000)]);
    } else if (outcome) {
      await query("UPDATE evidence_followups SET status='skipped', reason=$2 WHERE id=$1 AND status='pending'", [row.id, outcome.reason]);
    }
  }
}

/** Agents with a crossing waiting. The radar tick uses this so a follow-up does not wait for a wake. */
export async function agentsWithPendingFollowUps(limit = 5): Promise<string[]> {
  const rows = await query<{ agent_id: string }>("SELECT DISTINCT agent_id FROM evidence_followups WHERE status='pending' AND next_attempt_at<=now() LIMIT $1", [limit]);
  return rows.map(r => r.agent_id);
}

/** One sweep across whichever agents have something waiting. A failure on one never stops the rest. */
export async function sweepEvidenceFollowUps(): Promise<void> {
  for (const agentId of await agentsWithPendingFollowUps()) {
    await processEvidenceFollowUps(agentId).catch(error => log.warn('evidence follow-ups did not run', { agentId, message: errorMessage(error) }));
  }
}

async function queueFollowUp(row: Row, now: Date): Promise<{ reason: string; retry: boolean } | null> {
  const agent = await agents.getAgent(row.agent_id);
  const policy = await agents.getActivePolicy(row.agent_id);
  const account = await accountsRepo.getAccount(row.card_account_id);
  const template = await promptsRepo.getActiveTemplate('reply.default');
  if (!agent || !policy || !account) return { reason: 'The agent, its policy or its account is gone.', retry: false };
  if (!template) return { reason: 'The prompt template is missing.', retry: true };
  const config = PolicyConfig.parse(policy.config);
  const dryRun = config.automation.dryRunDefault;
  const remoteEventId = dryRun ? `evidence-followup:${row.id}:rehearsal` : `evidence-followup:${row.id}`;
  const idempotencyKey = sha256Hex(`${account.channel}:${account.id}:${remoteEventId}:REPLY:${agent.id}`);
  return withTransaction(async tx => {
    // One lock per agent serializes the daily cap across workers and accounts.
    await tx.one('SELECT id FROM agents WHERE id=$1 FOR NO KEY UPDATE', [agent.id]);
    const current = await tx.one('SELECT status FROM evidence_followups WHERE id=$1 FOR UPDATE', [row.id]);
    if (current?.status !== 'pending') return null;
    const today = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM evidence_followups WHERE agent_id=$1 AND status='queued'
      AND queued_at >= date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [agent.id, now]);
    if (!dryRun && (today?.n ?? 0) >= EVIDENCE_FOLLOW_UP_DAILY_CAP) {
      await tx.query("UPDATE evidence_followups SET status='skipped', reason=$2 WHERE id=$1", [row.id, `Daily evidence follow-up cap reached (${EVIDENCE_FOLLOW_UP_DAILY_CAP}).`]);
      return null;
    }
    const { event } = await eventsRepo.ingestEvent(tx, account.id, {
      channel: account.channel, type: 'SCHEDULED_TRIGGER', remoteEventId,
      // The asker's own post is where the thread is, and the one an adapter can reply under.
      remoteMessageId: row.ev_remote_message_id, remoteAuthorId: row.ev_author_id, remoteAuthorHandle: row.ev_author_handle,
      remoteAuthorDisplayName: row.ev_author_display, remoteConversationId: row.ev_conversation_id,
      parentRemoteMessageId: row.ev_parent_id, remoteUrl: row.ev_remote_url, text: row.ev_text,
      occurredAt: now.toISOString(), raw: { origin: EVIDENCE_FOLLOW_UP_ORIGIN, evidenceFollowUpId: row.id, cardJobId: row.card_job_id },
    });
    const created = await jobsRepo.createJob(tx, {
      eventId: event.id, agentId: agent.id, accountId: account.id, channel: account.channel, actionType: 'REPLY', idempotencyKey, dryRun,
      maxAttempts: config.safety.maxAttempts, personaVersionId: agent.personaVersionId, policyVersionId: agent.policyVersionId,
      pipelineVersionId: agent.pipelineVersionId, promptTemplateVersionId: template.id, conversationId: row.card_conversation_id,
      requiresBrowser: getChannelAdapter(account.channel).requiresBrowser,
    });
    await tx.query("UPDATE evidence_followups SET status=$2, job_id=$3, queued_at=$4, reason=$5 WHERE id=$1",
      [row.id, dryRun ? 'rehearsed' : 'queued', created.job.id, now, dryRun ? 'Rehearsed as a dry run; nothing was published.' : 'Queued as an ordinary reply job.']);
    return null;
  });
}

/** The deterministic text a follow-up job carries, checked again from the table every time it is asked for. */
async function loadForJob(jobId: string, followUpId: string | null): Promise<Row | null> {
  if (!followUpId) return null;
  const [row] = await query<Row>(`${ROW_SQL} WHERE f.id=$1 AND f.job_id=$2`, [followUpId, jobId]);
  return row ?? null;
}

/** Research step: a follow-up job carries its fixed text and no lookup runs. Returns whether this job is one. */
export async function researchEvidenceFollowUp(bundle: JobBundle): Promise<boolean> {
  if (!isEvidenceFollowUpEvent(bundle.event.payload)) return false;
  const context = bundle.job.resolvedContext;
  if (!context) return false;
  const row = await loadForJob(bundle.job.id, followUpIdOf(bundle.event.payload));
  const confirmed = StudioRiskWatch.safeParse(row?.watch_confirmed);
  if (!row || !confirmed.success) throw PipelineError.permanent('evidence_follow_up_missing', 'The crossing this follow-up was made for is gone.');
  const text = evidenceFollowUpText({ watch: confirmed.data, observation: row.observation, cardReadings: row.card_readings ?? [] });
  if (!text) throw PipelineError.permanent('evidence_follow_up_unavailable', 'The current reading is unavailable, so nothing is said.');
  const evidenceCard: EvidenceCard = { text, readings: [], cardJobId: row.card_job_id, link: null };
  const resolvedContext = { ...context, meta: { ...context.meta, evidenceCard, evidenceFollowUp: { id: row.id, cardJobId: row.card_job_id } } };
  await jobsRepo.updateJob(bundle.job.id, { resolvedContext });
  bundle.job.resolvedContext = resolvedContext;
  await observability.emitTrace({ jobId: bundle.job.id, agentId: bundle.agent.id, type: 'RESEARCH_DONE',
    message: 'Fixed evidence follow-up rebuilt from the recorded observation; no lookup was made.', data: { evidenceFollowUpId: row.id, cardJobId: row.card_job_id } });
  return true;
}

/**
 * Send check. A job approved or retried later is held to the same facts the sweep used:
 * the owner's switch, a current Studio link and watch, a reading still news, and the exact text.
 */
export async function checkEvidenceFollowUpAtSend(bundle: JobBundle, output: string): Promise<void> {
  if (!isEvidenceFollowUpEvent(bundle.event.payload)) return;
  const row = await loadForJob(bundle.job.id, followUpIdOf(bundle.event.payload));
  if (!row || !['queued', 'rehearsed'].includes(row.status)) throw PipelineError.permanent('evidence_follow_up_missing', 'The crossing this follow-up was made for is gone.');
  const current = await agents.getActivePolicy(bundle.agent.id);
  const config = PolicyConfig.parse(current?.config ?? {});
  if (!config.tools.evidenceFollowUps || !config.tools.evidenceCards) throw PipelineError.permanent('evidence_follow_up_disabled', 'Evidence follow-ups were switched off.');
  const studio = await studioRiskSourceRefusal({ id: row.source_id, config: row.source_config });
  if (studio) throw PipelineError.permanent('evidence_follow_up_stale', `${studio} Nothing is sent without a reachable, current Studio watch.`);
  const age = Date.now() - Date.parse(row.observation.now.observedAt);
  if (!Number.isFinite(age) || age > EVIDENCE_FOLLOW_UP_MAX_AGE_MS) throw PipelineError.permanent('evidence_follow_up_stale', 'The reading is older than thirty minutes; it is history, not news.');
  const confirmed = StudioRiskWatch.safeParse(row.watch_confirmed);
  const expected = confirmed.success ? evidenceFollowUpText({ watch: confirmed.data, observation: row.observation, cardReadings: row.card_readings ?? [], }) : null;
  if (!expected || expected !== output) throw PipelineError.review('evidence_follow_up_changed', 'The follow-up no longer matches the recorded observation. It is never sent edited.');
}
