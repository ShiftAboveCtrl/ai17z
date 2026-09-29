/**
 * Agent Foundry's proposals and the record of what was done with them.
 *
 * Items are upserted by (run, section, key), so a stage repeated after a
 * worker restart updates what it proposed rather than proposing it twice. An
 * item the owner has already decided is never overwritten by a repeated stage:
 * a person's decision outranks a re-run of the arithmetic that prompted it.
 */
import {
  FOUNDRY_ASSESSMENTS,
  FOUNDRY_ITEM_STATUSES,
  FOUNDRY_SECTIONS,
  type FoundryAssessment,
  type FoundryEvidence,
  type FoundryItem,
  type FoundryItemStatus,
  type FoundrySection,
} from '@xbam/shared/contracts';
import { query, queryOne } from '../pool';
import { mapRow, mapRows } from '../mapper';

export { FOUNDRY_ASSESSMENTS, FOUNDRY_ITEM_STATUSES, FOUNDRY_SECTIONS };

export interface FoundryItemRow {
  id: string;
  runId: string;
  section: FoundrySection;
  itemKey: string;
  title: string;
  currentValue: unknown;
  proposedValue: unknown;
  ownerValue: unknown;
  rationale: string;
  confidence: number;
  evidence: FoundryEvidence[];
  counterEvidence: FoundryEvidence[];
  assessment: FoundryAssessment;
  status: FoundryItemStatus;
  decidedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const json = (value: unknown) => JSON.stringify(value ?? null);

export async function upsertItem(runId: string, item: FoundryItem): Promise<void> {
  await query(
    `INSERT INTO foundry_items
       (run_id, section, item_key, title, current_value, proposed_value, rationale, confidence, evidence, counter_evidence, assessment)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11)
     ON CONFLICT (run_id, section, item_key) DO UPDATE
       SET title = excluded.title,
           current_value = excluded.current_value,
           proposed_value = excluded.proposed_value,
           rationale = excluded.rationale,
           confidence = excluded.confidence,
           evidence = excluded.evidence,
           counter_evidence = excluded.counter_evidence,
           assessment = excluded.assessment,
           updated_at = now()
       -- A decided item stays as the owner left it.
       WHERE foundry_items.status = 'PROPOSED'`,
    [
      runId,
      item.section,
      item.key,
      item.title.slice(0, 300),
      json(item.current),
      json(item.proposed),
      item.rationale.slice(0, 1_200),
      Math.max(0, Math.min(1, Number(item.confidence.toFixed(3)))),
      json(item.evidence),
      json(item.counterEvidence),
      item.assessment,
    ],
  );
}

export async function listItems(runId: string): Promise<FoundryItemRow[]> {
  const rows = mapRows<FoundryItemRow>(
    await query('SELECT * FROM foundry_items WHERE run_id = $1 ORDER BY section, confidence DESC, item_key', [runId]),
  );
  const order = new Map<string, number>(FOUNDRY_SECTIONS.map((s, i) => [s, i]));
  return rows
    .map((row) => ({ ...row, confidence: Number(row.confidence) }))
    .sort((a, b) => (order.get(a.section) ?? 99) - (order.get(b.section) ?? 99));
}

export async function getItem(id: string): Promise<FoundryItemRow | null> {
  const row = mapRow<FoundryItemRow>(await queryOne('SELECT * FROM foundry_items WHERE id = $1', [id]));
  return row ? { ...row, confidence: Number(row.confidence) } : null;
}

/**
 * An owner's decision about one item. Editing is accepting a different value.
 * An applied item cannot be decided again: it is a setting now, changed where
 * settings are changed.
 */
export async function decideItem(
  id: string,
  decision: { status: 'ACCEPTED' | 'REJECTED' | 'PROPOSED' } | { status: 'EDITED'; ownerValue: unknown },
): Promise<FoundryItemRow | null> {
  const row = mapRow<FoundryItemRow>(
    await queryOne(
      `UPDATE foundry_items
          SET status = $2,
              owner_value = CASE WHEN $2 = 'EDITED' THEN $3::jsonb WHEN $2 = 'PROPOSED' THEN NULL ELSE owner_value END,
              decided_at = CASE WHEN $2 = 'PROPOSED' THEN NULL ELSE now() END,
              updated_at = now()
        WHERE id = $1 AND status NOT IN ('APPLIED', 'SUPERSEDED')
        RETURNING *`,
      [id, decision.status, decision.status === 'EDITED' ? json(decision.ownerValue) : null],
    ),
  );
  return row ? { ...row, confidence: Number(row.confidence) } : null;
}

/** Accepts every undecided item in a run, or in one section of it. */
export async function acceptAll(runId: string, section?: FoundrySection): Promise<number> {
  const rows = await query(
    `UPDATE foundry_items SET status = 'ACCEPTED', decided_at = now(), updated_at = now()
      WHERE run_id = $1 AND status = 'PROPOSED' AND ($2::text IS NULL OR section = $2)
      RETURNING id`,
    [runId, section ?? null],
  );
  return rows.length;
}

export async function markApplied(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query(`UPDATE foundry_items SET status = 'APPLIED', applied_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
}

export interface FoundryApplicationRow {
  id: string;
  runId: string;
  agentId: string;
  appliedBy: string | null;
  accepted: number;
  rejected: number;
  report: Record<string, unknown>;
  createdAt: string;
}

export async function recordApplication(input: {
  runId: string;
  agentId: string;
  appliedBy: string | null;
  accepted: number;
  rejected: number;
  report: Record<string, unknown>;
}): Promise<FoundryApplicationRow> {
  return mapRow<FoundryApplicationRow>(
    await queryOne(
      `INSERT INTO foundry_applications (run_id, agent_id, applied_by, accepted, rejected, report)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [input.runId, input.agentId, input.appliedBy, input.accepted, input.rejected, json(input.report)],
    ),
  )!;
}

export async function applicationsFor(runId: string): Promise<FoundryApplicationRow[]> {
  return mapRows<FoundryApplicationRow>(
    await query('SELECT * FROM foundry_applications WHERE run_id = $1 ORDER BY created_at DESC', [runId]),
  );
}
