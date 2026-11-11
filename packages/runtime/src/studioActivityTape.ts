import { z } from 'zod';
import { ConflictError } from '@xbam/shared';
import { ops, query } from '@xbam/database';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { ACTIVITY_POST_TEXT_MAX, ActivityEventId as EventId, ActivityPostUrl, ActivityTapeBatch, ActivityTapeEvent, type ActivityEvent } from '@xbam/shared/contracts';
import { studioActivityBatch } from './studioLink';
export { ActivityTapeBatch, ActivityTapeEvent } from '@xbam/shared/contracts';

export const ACTIVITY_CAPABILITY = 'studio.activity_tape';
export const ACTIVITY_STALE_MS = 15 * 60_000;
// Studio's receiver accepts RECEIPT events and receipt: ids. Tombstones are independent
// of this projection switch so lowering it cannot discard an owner's removal.
const STUDIO_ACCEPTS_RECEIPTS = true;
const SETTING = 'studio.activity_tape';
const SCRUBS = 'studio.activity_tape.scrubs';
const CURSOR = 'studio.activity_tape.cursor';
const AssetLabel = z.string().regex(/^[A-Z0-9.]{1,16}$/);
const Size = z.string().regex(/^\d{1,78}$/);

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MENTION = /(^|[^A-Za-z0-9_])@[A-Za-z0-9_]/;

/**
 * The link to a post the agent really published, or nothing.
 *
 * The URL is whatever the channel adapter stored when it read the post back, never
 * built here: nothing downstream of an adapter knows what X looks like. It is used
 * only when the stored status id is the one the link ends in, so a stale or foreign
 * value cannot ride along, and when it has the one shape Studio will link to.
 */
function publishedPostUrl(row: Record<string, unknown>): string | undefined {
  if (row.kind !== 'REPLY' && row.kind !== 'POST') return undefined;
  if (row.dry_run !== false) return undefined;
  const { post_url: url, post_remote_id: remoteId } = row;
  if (typeof url !== 'string' || typeof remoteId !== 'string' || remoteId === '') return undefined;
  if (!ActivityPostUrl.safeParse(url).success || !url.endsWith(`/status/${remoteId}`)) return undefined;
  return url;
}

/**
 * The words of the post, for an owner who chose to show them.
 *
 * A reply that names anybody is left out whole: `target_handle` stays null, and a
 * mention in the text would put the person it was to back on a public page.
 * Over-long text is dropped, never cut mid-thought.
 */
function consentedPostText(row: Record<string, unknown>): string | undefined {
  if (typeof row.post_text !== 'string') return undefined;
  const text = row.post_text.trim();
  if (text === '' || text.length > ACTIVITY_POST_TEXT_MAX || CONTROL_CHARACTERS.test(text)) return undefined;
  if (row.kind === 'REPLY' && MENTION.test(text)) return undefined;
  return text;
}

/** Explicit construction keeps even newly added source fields private. */
export function projectActivity(row: Record<string, unknown>): ActivityEvent | null {
  if (row.kind === 'RECEIPT' && !STUDIO_ACCEPTS_RECEIPTS) return null;
  const postUrl = publishedPostUrl(row);
  const postText = postUrl === undefined ? undefined : consentedPostText(row);
  const parsed = ActivityTapeEvent.safeParse({
    id: row.id, agent_id: row.agent_id, kind: row.kind,
    at: row.at instanceof Date ? row.at.toISOString() : row.at,
    dry_run: typeof row.dry_run === 'boolean' ? row.dry_run : null, target_handle: null,
    paper: row.kind === 'PAPER_FILL' ? { simulated: true,
      size_base_units: Size.safeParse(row.size).success ? row.size : null,
      asset: AssetLabel.safeParse(row.asset).success ? row.asset : null, verdict: 'PAPER_FILLED' } : null,
    ...(postUrl === undefined ? {} : { post_url: postUrl }),
    ...(postText === undefined ? {} : { post_text: postText }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the words of a post may travel with its link. The owner's decision, made
 * here, separately from the tape switch and never by Studio. Off by default.
 * `changedAt` is a floor: turning it on does not reach back to posts already made.
 */
const TEXT_SETTING = 'studio.activity_tape.text';
export async function studioActivityTextSetting(): Promise<ActivityTapeSetting> {
  return (await ops.getSetting<ActivityTapeSetting>(TEXT_SETTING)) ?? { enabled: false, changedAt: null };
}
export async function setStudioActivityText(enabled: boolean, by: string): Promise<ActivityTapeSetting> {
  const current = await studioActivityTextSetting();
  if (current.enabled === enabled) return current;
  const setting = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(TEXT_SETTING, setting);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.activity_tape.text_enabled' : 'studio.activity_tape.text_disabled', entityType: 'settings', entityId: 'studio' });
  return setting;
}

export interface ActivityTapeSetting { enabled: boolean; changedAt: string | null }
export async function studioActivityTapeSetting(): Promise<ActivityTapeSetting> {
  return (await ops.getSetting<ActivityTapeSetting>(SETTING)) ?? { enabled: false, changedAt: null };
}
export async function setStudioActivityTape(enabled: boolean, by: string): Promise<ActivityTapeSetting> {
  const current = await studioActivityTapeSetting();
  if (current.enabled === enabled) return current;
  const setting = { enabled, changedAt: new Date().toISOString() };
  await ops.setSetting(SETTING, setting);
  await ops.audit({ actorUserId: by, action: enabled ? 'studio.activity_tape.enabled' : 'studio.activity_tape.disabled', entityType: 'settings', entityId: 'studio' });
  return setting;
}

/** Tombstones are delivery metadata, never copies of events. Studio keeps them permanently. */
export async function scrubStudioActivity(id: string, by: string): Promise<void> {
  id = EventId.parse(id);
  const saved = await query(`INSERT INTO app_settings (key, value) VALUES ($1, jsonb_build_array($2::text))
    ON CONFLICT (key) DO UPDATE SET value = app_settings.value || excluded.value
    WHERE jsonb_array_length(app_settings.value) < 200 AND NOT app_settings.value @> excluded.value RETURNING key`, [SCRUBS, id]);
  if (saved.length === 0 && !((await ops.getSetting<string[]>(SCRUBS)) ?? []).includes(id)) throw new ConflictError('The scrub queue is full. Remove this event in Studio.');
  await ops.audit({ actorUserId: by, action: 'studio.activity_tape.scrubbed', entityType: 'activity', entityId: id });
}

/** Read model only. No text, correspondent identity, wallet or reasoning is selected. */
interface TapeCursor { at: string; id: string; agentId: string }
/** Scoped owner previews also accept approval; unscoped background delivery requires ALLOWED. */
export async function activityTapeProjection(since: Date, cursor: TapeCursor | null = null, previewAgentId: string | null = null): Promise<ActivityEvent[]> {
  const text = await studioActivityTextSetting();
  const rows = await query(`WITH permitted AS (
    SELECT agent_id, permission_changed_at FROM agent_capability_permissions
    WHERE capability_id = $1
      AND (permission = 'ALLOWED' OR ($7::uuid IS NOT NULL AND permission = 'OWNER_APPROVAL'))
      AND ($7::uuid IS NULL OR agent_id = $7::uuid)
  ), tape AS (
    SELECT CASE WHEN e.payload->>'ideaSource'='radar_receipt' THEN 'receipt:' ELSE 'action:' END || a.id AS id,
      a.agent_id, CASE WHEN e.payload->>'ideaSource'='radar_receipt' THEN 'RECEIPT' ELSE a.type END AS kind, date_trunc('milliseconds', a.executed_at) AS at,
      a.dry_run, NULL::text AS size, NULL::text AS asset,
      -- A link exists only for a real, verified post: published, not a dry run, with the
      -- remote id the adapter read back. Receipts keep their own wording and never carry one.
      CASE WHEN a.status = 'EXECUTED' AND NOT a.dry_run AND a.remote_action_id IS NOT NULL
        AND COALESCE(e.payload->>'ideaSource', '') <> 'radar_receipt' THEN a.remote_action_url END AS post_url,
      CASE WHEN a.status = 'EXECUTED' AND NOT a.dry_run THEN a.remote_action_id END AS post_remote_id,
      -- Words are read from the stored action, and only for an owner who opted in and only
      -- for posts made after they did. Without consent the column is never selected.
      CASE WHEN $9::boolean AND a.status = 'EXECUTED' AND NOT a.dry_run AND a.executed_at >= $10::timestamptz
        THEN a.payload->>'text' END AS post_text
    FROM actions a JOIN permitted p ON p.agent_id = a.agent_id
      LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN events e ON e.id = j.event_id
    WHERE a.status IN ('EXECUTED','DRY_RUN') AND a.type IN ('REPLY','POST')
      AND ($8::boolean OR COALESCE(e.payload->>'ideaSource', '') <> 'radar_receipt')
      AND a.channel <> 'mock' AND COALESCE(e.payload->>'rehearsal', 'false') <> 'true'
      AND COALESCE(e.payload->>'origin', '') <> 'rehearsal'
      AND a.executed_at >= greatest($2::timestamptz, p.permission_changed_at)
    UNION ALL
    SELECT 'paper:' || t.id, t.agent_id, 'PAPER_FILL', date_trunc('milliseconds', t.updated_at), true,
      t.postcondition->>'inBase',
      CASE WHEN t.asset_in->>'kind' = 'NATIVE' THEN
        CASE t.asset_in->>'network' WHEN 'solana' THEN 'SOL' WHEN 'ethereum' THEN 'ETH' WHEN 'bnb' THEN 'BNB' ELSE NULL END
      ELSE t.asset_in->>'symbol' END,
      NULL::text, NULL::text, NULL::text
    FROM trade_intents t JOIN permitted p ON p.agent_id = t.agent_id
    WHERE t.mode = 'PAPER' AND t.status = 'PAPER_FILLED' AND t.postcondition->>'simulated' = 'true'
      AND t.updated_at >= greatest($2::timestamptz, p.permission_changed_at)
    UNION ALL
    SELECT DISTINCT 'radar:' || d.id, aa.agent_id, 'RADAR_HIT', date_trunc('milliseconds', d.first_seen_at), NULL::boolean, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text
    FROM event_discoveries d JOIN events e ON e.id = d.event_id
      JOIN agent_accounts aa ON aa.account_id = e.account_id JOIN permitted p ON p.agent_id = aa.agent_id
    WHERE d.first_seen_at >= greatest($2::timestamptz, p.permission_changed_at)
      AND e.channel <> 'mock' AND COALESCE(e.payload->>'rehearsal', 'false') <> 'true'
      AND COALESCE(e.payload->>'origin', '') <> 'rehearsal'
  ) SELECT * FROM tape WHERE at <= now() AND NOT (id = ANY($3::text[]))
    AND ($4::timestamptz IS NULL OR (at, id, agent_id) > ($4::timestamptz, $5::text, $6::uuid))
    ORDER BY at, id, agent_id LIMIT 50`,
  [ACTIVITY_CAPABILITY, since.toISOString(), (await ops.getSetting<string[]>(SCRUBS)) ?? [], cursor?.at ?? null, cursor?.id ?? null, cursor?.agentId ?? null, previewAgentId, STUDIO_ACCEPTS_RECEIPTS, text.enabled && text.changedAt !== null, text.changedAt ?? new Date(0).toISOString()]);
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
  // Studio's permanent tombstones protect replays after the pending queue is cleared.
  // Subtract only this batch so scrubs queued during transport remain pending.
  if (batch.remove.length) await query(`UPDATE app_settings SET value = COALESCE(
    (SELECT jsonb_agg(id) FROM jsonb_array_elements_text(value) AS pending(id)
      WHERE NOT (id = ANY($2::text[]))), '[]'::jsonb) WHERE key = $1`, [SCRUBS, batch.remove]);
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
    return { events: await activityTapeProjection(new Date(Date.now() - ACTIVITY_STALE_MS), null, ctx.agentId) };
  },
});
export function registerActivityTapeCapability(): void { registerCapability(capability as AnyCapability); }
