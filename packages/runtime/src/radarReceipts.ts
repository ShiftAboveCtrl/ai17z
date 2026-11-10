import { accounts, agents, cadences, query, withTransaction } from '@xbam/database';
import { errorMessage } from '@xbam/shared';
import type { SignalObservation, SignalWatch } from '@xbam/shared/contracts';
import { checkAccountCadence, msUntilAwake, withinQuietHours } from './cadence';
import { pauseState } from './killSwitch';
import { evaluateSignal, readSignalWatch, signalIdeaRefusal } from './signalRadar';

type Evidence = { watch: SignalWatch; before: SignalObservation; after: SignalObservation };

// These reversible labels name the configured upstream without its family prefix.
function compactObservation(label: string, observation: SignalObservation): string {
  const reads = (observation.reads ?? [observation]).map(r => {
    const source = r.source.replace(/^solana_mainnet\./, 'sol/');
    const time = Number.isFinite(Date.parse(r.observedAt)) ? new Date(r.observedAt).toISOString().slice(5, 16) + 'Z' : 'unavailable';
    return `${source}@${time}`;
  });
  return `${label} ${JSON.stringify(observation.value)} (${reads.join(',')}).`;
}

/** A rewrite may change the voice, but it cannot remove the receipt. */
export function receiptDraftRefusal(evidence: Evidence, now: SignalObservation, draft: string): string | null {
  const parts = [['Before', evidence.before], ['At post', evidence.after], ['Now', now]] as const;
  if (parts.some(([label, read]) => !draft.toLowerCase().includes(`${label} ${JSON.stringify(read.value)}`.toLowerCase()))) {
    return 'Retain Before, At post and Now with their measured values.';
  }
  if (parts.some(([label, read]) => !draft.includes(compactObservation(label, read)) && (read.reads ?? [read]).some(part => !draft.includes(part.source) || !draft.includes(part.observedAt)))) {
    return 'Retain each observation source and source time.';
  }
  return null;
}

/** An observation comparison, never an investment outcome or a hit-rate. */
export function receiptEvidence(evidence: Evidence, read: SignalObservation, now = Date.now()) {
  const valid = evaluateSignal(evidence.watch, null, read, now).state !== null;
  const verdict = !valid ? 'unavailable' : JSON.stringify(read.value) === JSON.stringify(evidence.after.value) ? 'unchanged' : 'changed';
  const describe = (label: string, observation: SignalObservation, available = true) =>
    `${label} ${available ? JSON.stringify(observation.value) : 'unavailable'} (${(observation.reads ?? [observation]).map(r => `${r.source}, ${r.observedAt}`).join('; ')}).`;
  const identity = `${evidence.watch.address.slice(0, 6)}...${evidence.watch.address.slice(-4)}`;
  const compact = ([['Before', evidence.before], ['At post', evidence.after], ['Now', read]] as const).map(([label, observation]) => compactObservation(label, observation)).join(' ');
  return { verdict, compact, detail: `Radar receipt for ${evidence.watch.chain}:${identity}: ${evidence.watch.predicate.replaceAll('_', ' ')}. ${describe('Before', evidence.before)} ${describe('At post', evidence.after)} ${describe('Now', read, valid)} ${read.definition} Compact receipt (UTC): ${compact} ${valid ? 'What changed: ' + verdict + '.' : 'Reading missing or stale; ungraded.'}` };
}

async function receiptGate(agentId: string, accountId: string, now: Date, retry = { afterMs: 15 * 60_000 }): Promise<string | null> {
  if ((await pauseState()).paused) return 'Everything is paused.';
  const agent = await agents.getAgent(agentId);
  if (agent?.state !== 'ACTIVE') return 'The agent is paused or inactive.';
  const account = await accounts.getAccount(accountId);
  if (!account?.enabled || account.status !== 'CONNECTED') return 'Account capacity unavailable: account is not connected.';
  const policy = await agents.getActivePolicy(agentId);
  if (!policy || ['OFF', 'MONITOR_ONLY'].includes(policy.config.automation.mode)) return 'Posting automation is off.';
  if (withinQuietHours(policy.config.rate.workingHours, now)) {
    retry.afterMs = msUntilAwake(policy.config.rate.workingHours, now);
    return 'Outside configured agent working hours.';
  }
  const cadence = await checkAccountCadence(accountId, await cadences.activeCadence(accountId), now, 'BROAD');
  if (cadence.allow) return null;
  retry.afterMs = cadence.retryAfterMs;
  return cadence.message;
}

/** Called by wake and posting. No timer; recovery discovers only executed actions. */
export async function processRadarReceipts(agentId: string, reader = readSignalWatch, now = new Date()): Promise<void> {
  await query(`INSERT INTO signal_receipts(action_id,window_hours,due_at,evidence)
    SELECT a.id, w.hours, a.executed_at + w.hours * interval '1 hour', c.evidence
    FROM actions a JOIN jobs j ON j.id=a.job_id JOIN events e ON e.id=j.event_id
    JOIN signal_candidates c ON c.idea_id::text=e.payload->>'ideaId' AND c.agent_id=a.agent_id
    JOIN radar_sources s ON s.id=c.source_id AND s.account_id=a.account_id
    CROSS JOIN (VALUES (1),(24)) w(hours)
    WHERE a.agent_id=$1 AND a.type='POST' AND a.status='EXECUTED' AND NOT a.dry_run
      AND a.executed_at IS NOT NULL AND e.payload->>'ideaSource'='market_signal'
    ON CONFLICT(action_id,window_hours) DO NOTHING`, [agentId]);
  // A lost worker releases its reservation for a later bounded retry.
  await query(`UPDATE signal_receipts r SET status='pending', reason='Worker interrupted the receipt read; retrying.', due_at=$2
    FROM actions a WHERE a.id=r.action_id AND a.agent_id=$1 AND r.status='reading' AND r.checked_at < $2::timestamptz - interval '10 minutes'`, [agentId, now]);
  // Expiry is anchored to the original action, so deferral cannot extend it.
  await query(`UPDATE signal_receipts r SET status='skipped', reason='Receipt window expired.', checked_at=$2
    FROM actions a WHERE a.id=r.action_id AND a.agent_id=$1 AND r.status='pending'
    AND a.executed_at + (r.window_hours + 24) * interval '1 hour' <= $2`, [agentId, now]);
  const due = await query<{ id: string; account_id: string; idea_id: string; expires_at: string; evidence: Evidence }>(`SELECT r.id, a.executed_at + (r.window_hours + 24) * interval '1 hour' AS expires_at, a.account_id, e.payload->>'ideaId' AS idea_id, r.evidence
      FROM signal_receipts r JOIN actions a ON a.id=r.action_id JOIN jobs j ON j.id=a.job_id JOIN events e ON e.id=j.event_id
      WHERE a.agent_id=$1 AND r.status='pending' AND r.due_at <= $2
      ORDER BY r.due_at LIMIT 4`, [agentId, now]);
  for (const row of due) {
    const retry = { afterMs: 15 * 60_000 };
    let refusal = await receiptGate(agentId, row.account_id, now, retry) ?? await signalIdeaRefusal(row.idea_id, undefined, { agentId, accountId: row.account_id });
    const claimed = await withTransaction(async tx => {
      // Serialize one agent's per-day reservations across accounts and workers.
      await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [agentId]);
      const current = await tx.one("SELECT status FROM signal_receipts WHERE id=$1 FOR UPDATE", [row.id]);
      if (current?.status !== 'pending') return false;
      const counts = await tx.one<{ daily: number; mint: number }>(`SELECT count(*)::int AS daily,
        count(*) FILTER (WHERE r.evidence->'watch'->>'address'=$2 AND r.evidence->'watch'->>'chain'=$3)::int AS mint
        FROM signal_receipts r JOIN actions a ON a.id=r.action_id WHERE a.agent_id=$1
        AND r.status IN ('offered','reading') AND r.checked_at >= date_trunc('day',$4::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [agentId, row.evidence.watch.address, row.evidence.watch.chain, now]);
      const cap = (counts?.mint ?? 0) >= 1 ? 'Per-mint daily receipt cap reached (one).' : (counts?.daily ?? 0) >= 2 ? 'Agent daily receipt cap reached (two).' : null;
      if (cap || refusal) {
        const retryAt = new Date(Math.min(now.getTime() + Math.max(60_000, retry.afterMs), new Date(row.expires_at).getTime()));
        await tx.query("UPDATE signal_receipts SET status=$2, reason=$3, checked_at=$4, due_at=$5 WHERE id=$1", [row.id, cap ? 'skipped' : 'pending', cap ?? refusal, now, retryAt]);
        return false;
      }
      await tx.query("UPDATE signal_receipts SET status='reading', checked_at=$2 WHERE id=$1", [row.id, now]);
      return true;
    });
    if (!claimed) continue;
    let read: SignalObservation;
    try { read = await reader(row.evidence.watch); }
    catch (error) { read = { value: null, source: 'unavailable', observedAt: now.toISOString(), definition: `Upstream unavailable: ${errorMessage(error).slice(0, 200)}` }; }
    const readAt = new Date(Math.max(now.getTime(), Date.now()));
    const result = receiptEvidence(row.evidence, read, readAt.getTime());
    refusal = await receiptGate(agentId, row.account_id, readAt, retry) ?? await signalIdeaRefusal(row.idea_id, result.detail, { agentId, accountId: row.account_id });
    const expired = readAt.getTime() >= new Date(row.expires_at).getTime();
    if (expired) refusal = 'Receipt window expired.';
    const unavailable = result.verdict === 'unavailable';
    await withTransaction(async tx => {
      const current = await tx.one("SELECT status FROM signal_receipts WHERE id=$1 FOR UPDATE", [row.id]);
      if (current?.status !== 'reading') return;
      let ideaId: unknown = null;
      if (!unavailable && !refusal) {
        const idea = await tx.one(`INSERT INTO content_ideas(agent_id,kind,summary,detail,source,score)
          VALUES($1,'observation','Radar receipt: what changed',$2,'radar_receipt',75) RETURNING id`, [agentId, result.detail]);
        ideaId = idea!.id;
      }
      await tx.query(`UPDATE signal_receipts SET status=$2, reason=$3, now_read=$4, verdict=$5, idea_id=$6, checked_at=$7, due_at=CASE WHEN $2='pending' THEN $8::timestamptz ELSE due_at END WHERE id=$1`,
      [row.id, expired ? 'skipped' : refusal ? 'pending' : unavailable ? 'unavailable' : 'offered', refusal ?? (unavailable ? 'Reading unavailable; ungraded.' : 'Evidence offered to the existing posting gates.'), read, result.verdict, ideaId, readAt, new Date(Math.min(readAt.getTime() + Math.max(60_000, retry.afterMs), new Date(row.expires_at).getTime()))]);
    });
  }
}

/** Approved jobs are checked again at send, using the original watch grants. */
export async function receiptIdeaRefusal(ideaId: string, draft?: string, scope?: { accountId?: string | null; agentId: string }): Promise<string | null> {
  const [row] = await query<{ original_idea: string; agent_id: string; account_id: string; status: string; checked_at: string; expires_at: string; evidence: Evidence; now_read: SignalObservation }>(`SELECT e.payload->>'ideaId' AS original_idea, a.agent_id, a.account_id, r.status, r.checked_at, a.executed_at + (r.window_hours + 24) * interval '1 hour' AS expires_at, r.evidence, r.now_read
    FROM signal_receipts r JOIN actions a ON a.id=r.action_id JOIN jobs j ON j.id=a.job_id JOIN events e ON e.id=j.event_id WHERE r.idea_id=$1`, [ideaId]);
  if (!row || row.status !== 'offered') return 'Receipt evidence is unavailable.';
  if (scope && (scope.agentId !== row.agent_id || scope.accountId !== row.account_id)) return 'Receipt belongs to a different agent or account.';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'Receipt window expired.';
  // A held post cannot accumulate and publish yesterday's receipt budget today.
  if (new Date(row.checked_at).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) return 'Receipt daily reservation expired; skipped.';
  return await receiptGate(row.agent_id, row.account_id, new Date()) ?? await signalIdeaRefusal(row.original_idea, draft, scope) ??
    (draft ? receiptDraftRefusal(row.evidence, row.now_read, draft) : null);
}
