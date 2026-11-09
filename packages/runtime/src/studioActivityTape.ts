import { z } from 'zod';
import { ConflictError } from '@xbam/shared';
import { ops, query } from '@xbam/database';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { studioActivityBatch } from './studioLink';
import { ActivityEventId as EventId, ActivityTapeBatch, ActivityTapeEvent, type ActivityEvent } from '@xbam/shared/contracts';
export { ActivityTapeBatch, ActivityTapeEvent } from '@xbam/shared/contracts';

export const ACTIVITY_CAPABILITY = 'studio.activity_tape';
export const ACTIVITY_STALE_MS = 15 * 60_000;
const SETTING = 'studio.activity_tape';
const SCRUBS = 'studio.activity_tape.scrubs';
const CURSOR = 'studio.activity_tape.cursor';
const AssetLabel = z.string().regex(/^[A-Z0-9.]{1,16}$/);
const Size = z.string().regex(/^\d{1,78}$/);

/** Explicit construction keeps even newly added source fields private. */
export function projectActivity(row: Record<string, unknown>): ActivityEvent | null {
  const parsed = ActivityTapeEvent.safeParse({
    id: row.id, agent_id: row.agent_id, kind: row.kind,
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    dry_run: typeof row.dry_run === 'boolean' ? row.dry_run : null, target_handle: null,
    paper: row.kind === 'PAPER_FILL' ? { simulated: true,
      size_base_units: Size.safeParse(row.size).success ? row.size : null,
      asset: AssetLabel.safeParse(row.asset).success ? row.asset : null, verdict: 'PAPER_FILLED' } : null,
  });
  return parsed.success ? parsed.data : null;
}

export interface ActivityTapeSetting { enabled: boolean; changedAt: string | null }
export async function studioActivityTapeSetting(): Promise<ActivityTapeSetting> {
  return (await ops.getSetting<ActivityTapeSetting>(SETTING)) ?? { enabled: false, changedAt: null };
}
export async function setStudioActivityTape(enabled: boolean, by: string): Promise<ActivityTapeSetting> {
  const setting = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(SETTING, setting);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.activity_tape.enabled' : 'studio.activity_tape.disabled', entityType: 'settings', entityId: 'studio' });
  return setting;
}

/** Tombstones are delivery metadata, never copies of events. Studio keeps them permanently. */
export async function scrubStudioActivity(id: string, by: string): Promise<void> {
  EventId.parse(id);
  const saved = await query(`INSERT INTO app_settings (key, value) VALUES ($1, jsonb_build_array($2::text))
    ON CONFLICT (key) DO UPDATE SET value = app_settings.value || excluded.value
    WHERE jsonb_array_length(app_settings.value) < 200 AND NOT app_settings.value @> excluded.value RETURNING key`, [SCRUBS, id]);
  if (saved.length === 0 && !((await ops.getSetting<string[]>(SCRUBS)) ?? []).includes(id)) throw new ConflictError('The scrub queue is full. Remove this event in Studio.');
  await ops.audit({ actorUserId: by, action: 'studio.activity_tape.scrubbed', entityType: 'activity', entityId: id });
}

/** Read model only. No text, correspondent identity, wallet or reasoning is selected. */
interface TapeCursor { at: string; id: string; agentId: string }
export async function activityTapeProjection(since: Date, cursor: TapeCursor | null = null): Promise<ActivityEvent[]> {
  const rows = await query(`WITH permitted AS (
    SELECT agent_id, updated_at FROM agent_capability_permissions
    WHERE capability_id = $1 AND permission = 'ALLOWED'
  ), tape AS (
    SELECT 'action:' || a.id AS id, a.agent_id, a.type AS kind, date_trunc('milliseconds', a.executed_at) AS at,
      a.dry_run, NULL::text AS size, NULL::text AS asset
    FROM actions a JOIN permitted p ON p.agent_id = a.agent_id
    WHERE a.status IN ('EXECUTED','DRY_RUN') AND a.type IN ('REPLY','POST')
      AND a.executed_at >= greatest($2::timestamptz, p.updated_at)
    UNION ALL
    SELECT 'paper:' || t.id, t.agent_id, 'PAPER_FILL', date_trunc('milliseconds', t.updated_at), true,
      t.postcondition->>'inBase',
      CASE WHEN t.asset_in->>'kind' = 'NATIVE' THEN
        CASE t.asset_in->>'network' WHEN 'solana' THEN 'SOL' WHEN 'ethereum' THEN 'ETH' WHEN 'bnb' THEN 'BNB' ELSE NULL END
      ELSE t.asset_in->>'symbol' END
    FROM trade_intents t JOIN permitted p ON p.agent_id = t.agent_id
    WHERE t.mode = 'PAPER' AND t.status = 'PAPER_FILLED' AND t.postcondition->>'simulated' = 'true'
      AND t.updated_at >= greatest($2::timestamptz, p.updated_at)
    UNION ALL
    SELECT DISTINCT 'radar:' || d.id, aa.agent_id, 'RADAR_HIT', date_trunc('milliseconds', d.first_seen_at), NULL::boolean, NULL::text, NULL::text
    FROM event_discoveries d JOIN events e ON e.id = d.event_id
      JOIN agent_accounts aa ON aa.account_id = e.account_id JOIN permitted p ON p.agent_id = aa.agent_id
    WHERE d.first_seen_at >= greatest($2::timestamptz, p.updated_at)
  ) SELECT * FROM tape WHERE at <= now() AND NOT (id = ANY($3::text[]))
    AND ($4::timestamptz IS NULL OR (at, id, agent_id) > ($4::timestamptz, $5::text, $6::uuid))
    ORDER BY at, id, agent_id LIMIT 50`,
  [ACTIVITY_CAPABILITY, since.toISOString(), (await ops.getSetting<string[]>(SCRUBS)) ?? [], cursor?.at ?? null, cursor?.id ?? null, cursor?.agentId ?? null]);
  return rows.map(projectActivity).filter((event): event is ActivityEvent => event !== null);
}

/** Existing worker sweep calls this. A persisted claim bounds concurrent workers and failures. */
export async function sweepStudioActivityTape(): Promise<{ sent: number; skipped?: string }> {
  const setting = await studioActivityTapeSetting();
  if (!setting.enabled || !setting.changedAt) return { sent: 0, skipped: 'off' };
  const claimed = await query(`INSERT INTO app_settings (key, value) VALUES ('studio.activity_tape.attempt', to_jsonb(now()))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE (app_settings.value #>> '{}')::timestamptz <= now() - interval '1 minute' RETURNING key`);
  if (claimed.length === 0) return { sent: 0, skipped: 'rate' };
  const events = await activityTapeProjection(new Date(Math.max(Date.now() - ACTIVITY_STALE_MS, Date.parse(setting.changedAt))), await ops.getSetting<TapeCursor>(CURSOR));
  const remove = (await ops.getSetting<string[]>(SCRUBS)) ?? [];
  if (!events.length && !remove.length) return { sent: 0, skipped: 'empty' };
  const current = await studioActivityTapeSetting();
  if (!current.enabled || current.changedAt !== setting.changedAt) return { sent: 0, skipped: 'off' };
  const allowed = await query<{ agent_id: string }>(`SELECT agent_id FROM agent_capability_permissions WHERE capability_id = $1 AND permission = 'ALLOWED'`, [ACTIVITY_CAPABILITY]);
  const batch = ActivityTapeBatch.parse({ protocol: 1, events: events.filter((event) => allowed.some((p) => p.agent_id === event.agent_id)), remove });
  const result = await studioActivityBatch(batch);
  if (!result.ok) return { sent: 0, skipped: result.why };
  const last = events.at(-1);
  if (last) await ops.setSetting(CURSOR, { at: last.at, id: last.id, agentId: last.agent_id });
  return { sent: batch.events.length };
}

const capability = defineCapability({
  id: ACTIVITY_CAPABILITY, name: 'Public activity tape',
  description: 'Inspect normalized activity allowed on the public Studio terminal. Publishing also requires the owner installation switch.',
  category: 'ACCOUNT', effect: 'READ', risk: 'LOW', audience: 'OWNER', unsetPermission: 'DISABLED',
  modelCallable: true, timeoutMs: 10_000, input: z.object({}).strict(),
  output: z.object({ events: z.array(ActivityTapeEvent) }).strict(),
  async run(_input, ctx) {
    return { events: (await activityTapeProjection(new Date(Date.now() - ACTIVITY_STALE_MS))).filter((event) => event.agent_id === ctx.agentId) };
  },
});
export function registerActivityTapeCapability(): void { registerCapability(capability as AnyCapability); }
