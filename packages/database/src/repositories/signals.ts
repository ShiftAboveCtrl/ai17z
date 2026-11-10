import { mapRows } from '../mapper';
import { query } from '../pool';
import type { SignalRadarData } from '@xbam/shared/contracts';

/**
 * The same rule as `hasStudioRiskMark`: only the Studio bridge writes
 * `config.studioRisk`, and it counts only as a non-null object. `config ? key`
 * would also match a JSON null, a string or a boolean. Playbook sources are
 * tracked_keyword and own no baselines or candidates, so this SQL never returns PLAYBOOK.
 */
const PROVENANCE = `CASE WHEN jsonb_typeof(s.config->'studioRisk') = 'object' THEN 'STUDIO_RISK_WATCH' ELSE 'OWNER' END`;

/** Read models only. Polling commits baseline, transition and idea together. */
export async function forAccount(accountId: string): Promise<SignalRadarData> {
  const baselines = mapRows<SignalRadarData['baselines'][number]>(await query(
    `SELECT b.*, ${PROVENANCE} AS provenance FROM signal_baselines b JOIN radar_sources s ON s.id = b.source_id
      WHERE s.account_id = $1 AND s.config->'watches' @> jsonb_build_array(b.watch)
      ORDER BY b.updated_at DESC LIMIT 12`, [accountId],
  ));
  const candidates = mapRows<SignalRadarData['candidates'][number]>(await query(
    `SELECT c.*, ${PROVENANCE} AS provenance, i.status AS idea_status, i.last_error AS idea_error,
            j.status AS job_status, j.last_error AS job_error,
            p.enabled AS posting_enabled, p.last_reason AS posting_reason
       FROM signal_candidates c JOIN radar_sources s ON s.id = c.source_id
       LEFT JOIN content_ideas i ON i.id = c.idea_id LEFT JOIN jobs j ON j.id = i.job_id
       LEFT JOIN agent_posting p ON p.agent_id = c.agent_id
      WHERE s.account_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [accountId],
  ));
  const receipts = mapRows<NonNullable<SignalRadarData['receipts']>[number]>(await query(`SELECT r.*, i.status AS idea_status, i.last_error AS idea_error,
    j.status AS job_status, j.last_error AS job_error, published.id AS published_action_id
    FROM signal_receipts r JOIN actions a ON a.id=r.action_id
    LEFT JOIN content_ideas i ON i.id=r.idea_id LEFT JOIN jobs j ON j.id=i.job_id
    LEFT JOIN LATERAL (SELECT id FROM actions p WHERE p.job_id=j.id AND p.status='EXECUTED' AND NOT p.dry_run LIMIT 1) published ON true
    WHERE a.account_id=$1 ORDER BY r.due_at ASC LIMIT 50`, [accountId]));
  return { baselines, candidates, receipts };
}
