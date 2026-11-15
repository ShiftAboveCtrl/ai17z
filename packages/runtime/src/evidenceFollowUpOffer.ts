import type { RadarSourceRow, Tx } from '@xbam/database';
import { sha256Hex } from '@xbam/shared';
import { PolicyConfig, StudioRiskWatch, type SignalObservation, type SignalWatch } from '@xbam/shared/contracts';
import { studioRiskObservationId, watchRevision } from './studioRiskWatches';

/** What the follow-up table keeps of a crossing: the measured numbers and their times, nothing else. */
export interface FollowUpObservation {
  kind: StudioRiskWatch['kind'];
  mint: string;
  source: 'jupiter';
  before: { value: number; observedAt: string } | null;
  now: { value: number; observedAt: string };
}

/**
 * Records that an owner-confirmed risk watch crossed, for each published card that watch was confirmed on.
 *
 * Called from the transaction that records the crossing, only on a transition, so a
 * poll that merely keeps a condition active offers nothing. Nothing here sends: the
 * sweep in `evidenceFollowUp.ts` decides whether and when. A stranger's text has no
 * route in, because the only rows that can match are cards whose owner confirmed a
 * watch through `confirmEvidenceRiskWatch`, and that watch id has to be the one Studio
 * itself returned for this binding.
 */
export async function offerEvidenceFollowUps(tx: Tx, input: {
  source: RadarSourceRow; watch: SignalWatch; before: SignalObservation | null; after: SignalObservation;
  watchKey: string; generation: number;
}): Promise<number> {
  const meta = input.source.config.studioRisk;
  const kind = input.watch.studioMetric;
  if (!meta || !kind || typeof input.after.value !== 'number' || !Number.isFinite(input.after.value)) return 0;
  // Switching the option on later must not resurrect a crossing nobody was told about, so it is read now.
  // Read on the transaction's own connection: a pooled read here would deadlock the pool.
  const row = await tx.one<{ config: unknown }>('SELECT pv.config FROM agents a JOIN policy_versions pv ON pv.id=a.policy_version_id WHERE a.id=$1', [meta.agentId]);
  const tools = PolicyConfig.safeParse(row?.config ?? {});
  if (!tools.success || !tools.data.tools.evidenceFollowUps || !tools.data.tools.evidenceCards) return 0;
  const cards = await tx.many<{ job_id: string; watch_confirmed: unknown }>(`SELECT r.job_id, r.watch_confirmed
    FROM evidence_card_requests r
    JOIN studio_risk_bindings b ON b.id=$2 AND b.agent_id=r.agent_id
    JOIN agents a ON a.id=r.agent_id AND a.owner_id=b.owner_id
    JOIN jobs j ON j.id=r.job_id
    WHERE r.agent_id=$1 AND r.chain='solana' AND r.address=$3 AND NOT r.dry_run AND r.card_job_id=r.job_id
      AND j.status='EXECUTED' AND r.watch_confirmed->>'id'=$4`, [meta.agentId, meta.bindingId, input.watch.address, meta.watchId]);
  const observation: FollowUpObservation = {
    kind, mint: input.watch.address, source: 'jupiter',
    before: input.before && typeof input.before.value === 'number' && Number.isFinite(input.before.value)
      ? { value: input.before.value, observedAt: input.before.observedAt } : null,
    now: { value: input.after.value, observedAt: input.after.observedAt },
  };
  const observationId = studioRiskObservationId(meta, input.watch, input.after);
  const crossingKey = sha256Hex(`${input.source.id}:${input.watchKey}:${input.generation}`);
  let offered = 0;
  for (const card of cards) {
    const confirmed = StudioRiskWatch.safeParse(card.watch_confirmed);
    // The watch Studio runs now has to be the watch the owner confirmed: an edited threshold is a new revision.
    if (!confirmed.success || confirmed.data.kind !== kind || watchRevision(confirmed.data) !== meta.watchRevision) continue;
    const row = await tx.one(`INSERT INTO evidence_followups(card_job_id,agent_id,source_id,observation_id,crossing_key,observation)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
    [card.job_id, meta.agentId, input.source.id, observationId, crossingKey, observation]);
    if (row) offered++;
  }
  return offered;
}
