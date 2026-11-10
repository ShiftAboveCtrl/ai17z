import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agents, content, ops, query, withAdvisoryLock, withTransaction } from '@xbam/database';
import { BadRequestError, canonicalJson, ConflictError, logger, NotFoundError } from '@xbam/shared';
import { LeagueAlias, PaperRecord, PaperRecordWindow, PolicyConfig, VoiceDocument } from '@xbam/shared/contracts';
import { studioControlSetting } from './studioControl';
import { studioStatus, studioPaperRecord, studioPublicHomeRequest, studioPublicHomeRenew } from './studioLink';
import { publicHomeNeedsRepublish, publicHomeRepublished } from './notify';
import { voiceFromAgent } from './voiceDocument';
import { readLeagueStanding } from './studioLeague';
import { unpromptedSubject } from './reticence';

export const HOME_TTL_MS = 15 * 60_000;
export const HOME_IDEA_SOURCE = 'studio_public_home';
const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(3).max(24);
const Paper = z.object({ protocol: PaperRecord.shape.protocol, simulated: PaperRecord.shape.simulated,
  source: PaperRecord.shape.source, generated_at: PaperRecord.shape.generated_at, window: PaperRecord.shape.window,
  state: PaperRecord.shape.state, totals: PaperRecord.shape.totals, costs: PaperRecord.shape.costs,
  open_positions: PaperRecord.shape.open_positions }).strict();
const League = z.object({ simulated: z.literal(true), seasonSlug: Slug, generatedAt: z.iso.datetime(),
  basis: z.literal('REPORTED_BY_ENTRANT'), rank: z.number().int().positive().nullable(),
  field: z.number().int().positive().nullable(), returnBps: z.number().int().nullable(), fillsCounted: z.number().int().nonnegative() }).strict();
// Receipts use only the public tape's event metadata. Text and target identity have no slot.
const Receipt = z.object({ id: z.string().regex(/^receipt:[0-9a-f-]{36}$/), kind: z.literal('RECEIPT'), at: z.iso.datetime(), dryRun: z.boolean() }).strict();
export const PublicHomeManifest = z.object({ protocol: z.literal(1), identity: z.literal('AI_AGENT'), simulated: z.literal(true),
  alias: LeagueAlias, showActivity: z.boolean(), leagueEntryId: z.uuid().nullable(),
  voice: VoiceDocument.nullable(), paper: Paper.nullable(), league: League.nullable(), receipts: z.array(Receipt).max(50) }).strict();
export type PublicHomeManifest = z.infer<typeof PublicHomeManifest>;
export const PublicHomeChoices = z.object({ alias: LeagueAlias, includeVoice: z.boolean().default(false),
  paperWindow: PaperRecordWindow.nullable().default(null), includeLeague: z.boolean().default(false), showActivity: z.boolean().default(false) }).strict();
export type PublicHomeChoices = z.input<typeof PublicHomeChoices>;

/** Copy named fields. Source growth cannot silently become public data. */
export function projectHomeManifest(source: Record<string, unknown>): PublicHomeManifest {
  return PublicHomeManifest.parse({ protocol: 1, identity: 'AI_AGENT', simulated: true, alias: source.alias,
    showActivity: source.showActivity, leagueEntryId: source.leagueEntryId, voice: source.voice,
    paper: source.paper, league: source.league, receipts: source.receipts });
}

/** Same action facts and consent floor as the tape; no receipt text or evidence payload leaves. */
async function receiptProjection(agentId: string): Promise<z.infer<typeof Receipt>[]> {
  const rows = await query<{ id: string; at: Date; dry_run: boolean }>(`SELECT 'receipt:' || a.id AS id, a.executed_at AS at, a.dry_run
    FROM actions a JOIN jobs j ON j.id=a.job_id JOIN events e ON e.id=j.event_id
    JOIN agent_capability_permissions p ON p.agent_id=a.agent_id AND p.capability_id='studio.activity_tape'
    WHERE a.agent_id=$1 AND p.permission IN ('ALLOWED','OWNER_APPROVAL')
      AND a.status IN ('EXECUTED','DRY_RUN') AND a.type='POST' AND a.channel <> 'mock'
      AND e.payload->>'ideaSource'='radar_receipt' AND COALESCE(e.payload->>'rehearsal','false') <> 'true'
      AND COALESCE(e.payload->>'origin','') <> 'rehearsal'
      AND a.executed_at >= p.permission_changed_at AND a.executed_at <= now()
      AND NOT ('receipt:' || a.id = ANY($2::text[]))
    ORDER BY a.executed_at DESC, a.id DESC LIMIT 50`, [agentId, (await ops.getSetting<string[]>('studio.activity_tape.scrubs')) ?? []]);
  return rows.map((row) => Receipt.parse({ id: row.id, kind: 'RECEIPT', at: row.at.toISOString(), dryRun: row.dry_run }));
}
const digestOf = (manifest: PublicHomeManifest) => createHash('sha256').update(canonicalJson(manifest)).digest('hex');
interface Pending { manifest: PublicHomeManifest; digest: string; key: string; expiresAt: string; origin: string | null; installationId: string | null; linkedAt: string | null }
interface Confirmed { published: boolean; slug: string; origin: string; installationId: string; linkedAt: string; confirmedAt: string; validUntil: string; digest: string; revision: string;
  renewal?: { key: string; attemptedAt: string; stopped: boolean } }
interface Row extends Record<string, unknown> { pending: Pending | null; confirmed: Confirmed | null; post_link: boolean; problem: string | null; proposed_digest: string | null }
const empty = (): Row => ({ pending: null, confirmed: null, post_link: false, problem: null, proposed_digest: null });
async function rowOf(id: string): Promise<Row> { return (await query<Row>('SELECT * FROM agent_public_home WHERE agent_id = $1', [id]))[0] ?? empty(); }
async function owned(id: string, ownerId: string) {
  const agent = await agents.getAgent(id);
  if (!agent || agent.ownerId !== ownerId) throw new NotFoundError('Agent');
  return agent;
}
/** Serialize preview, publish and removal across processes, including their outbound request. */
async function locked<T>(id: string, run: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(`public-home:${id}`, run);
}

export async function publicHomeState(agentId: string, now = new Date()) {
  const [row, status, control] = await Promise.all([rowOf(agentId), studioStatus(), studioControlSetting()]);
  const c = row.confirmed;
  const stale = !!c && (now.getTime() - Date.parse(c.confirmedAt) >= HOME_TTL_MS || now.getTime() < Date.parse(c.confirmedAt)
    || !c.validUntil || Date.parse(c.validUntil) <= now.getTime()
    || !!row.problem || !control.enabled || status.state !== 'LINKED' || status.origin !== c.origin || status.installationId !== c.installationId || status.linkedAt !== c.linkedAt);
  return { confirmed: c, postLink: row.post_link, stale, problem: row.problem, canUnpublish: c?.published === true || !!row.problem && !!row.pending,
    url: c?.published && !stale ? `${c.origin}/a/${c.slug}` : null };
}

export async function previewPublicHome(input: { agentId: string; ownerId: string; choices: PublicHomeChoices }, now = new Date()) {
  await owned(input.agentId, input.ownerId);
  const choices = PublicHomeChoices.parse(input.choices);
  const [persona, policy, status, control] = await Promise.all([agents.getActivePersona(input.agentId), agents.getActivePolicy(input.agentId), studioStatus(), studioControlSetting()]);
  let voice = null;
  if (choices.includeVoice) {
    if (!persona) throw new BadRequestError('This agent has no voice to preview.');
    const built = voiceFromAgent({ persona, output: PolicyConfig.parse(policy?.config ?? {}).output }, { title: choices.alias, summary: 'An AI agent voice.' });
    if (!built.ok) throw new BadRequestError(built.problem);
    voice = built.document;
  }
  // The local voice preview works offline. Optional Studio reads need the existing control consent.
  if ((choices.paperWindow || choices.includeLeague) && !control.enabled) throw new BadRequestError('Turn on control from Studio before reading public-home sources.');
  let paper = null;
  if (choices.paperWindow) {
    const read = await studioPaperRecord(choices.paperWindow, now);
    if (!read.ok) throw new BadRequestError('Studio is unavailable. No paper snapshot was previewed.');
    if (!read.record.window.complete) throw new BadRequestError('The simulated paper window is still running.');
    const r = read.record;
    paper = Paper.parse({ protocol: r.protocol, simulated: true, source: r.source, generated_at: r.generated_at,
      window: r.window, state: r.state, totals: r.totals, costs: r.costs, open_positions: r.open_positions });
  }
  let league = null;
  let leagueEntryId = null;
  if (choices.includeLeague) {
    const read = await readLeagueStanding(input.agentId, now);
    if (!read.ok) throw new BadRequestError('No current simulated paper league standing is available.');
    const s = read.standing;
    leagueEntryId = s.entry_id;
    league = { simulated: true as const, seasonSlug: s.season_slug, generatedAt: s.generated_at, basis: s.basis,
      rank: s.standing.rank, field: s.standing.of, returnBps: s.standing.return_bps, fillsCounted: s.standing.fills_counted };
  }
  const receipts = choices.showActivity ? await receiptProjection(input.agentId) : [];
  const manifest = projectHomeManifest({ alias: choices.alias, showActivity: choices.showActivity, leagueEntryId, voice, paper, league, receipts });
  const pending: Pending = { manifest, digest: digestOf(manifest), key: randomUUID(), expiresAt: new Date(now.getTime() + HOME_TTL_MS).toISOString(), origin: status.origin, installationId: status.installationId, linkedAt: status.linkedAt };
  await locked(input.agentId, async () => {
    const before = await rowOf(input.agentId);
    if (before.problem && before.pending) throw new ConflictError('A publication outcome is unknown. Retry that confirmation or unpublish before making a new preview.');
    await query(`INSERT INTO agent_public_home(agent_id,pending) VALUES ($1,$2::jsonb)
      ON CONFLICT (agent_id) DO UPDATE SET pending = excluded.pending`, [input.agentId, JSON.stringify(pending)]);
  });
  return { manifest, digest: pending.digest, expiresAt: pending.expiresAt, note: 'Anyone can read a published home. Numbers are simulated paper results. Unpublishing removes the page; copies cannot be recalled.' };
}

const problem = async (id: string) => {
  const why = 'Studio could not confirm the change. The last confirmed state is kept and is not presented as live.';
  await query('UPDATE agent_public_home SET problem = $2 WHERE agent_id = $1', [id, why]);
  return { ok: false as const, why };
};
export async function publishPublicHome(input: { agentId: string; ownerId: string; digest: string; confirmed: boolean }, now = new Date()) {
  await owned(input.agentId, input.ownerId);
  return locked(input.agentId, async () => {
    const row = await rowOf(input.agentId);
    const p = row.pending;
    if (!p || p.digest !== input.digest || digestOf(PublicHomeManifest.parse(p.manifest)) !== p.digest) return { ok: false as const, why: 'Preview this exact manifest first.' };
    if (!input.confirmed) return { ok: false as const, why: 'Confirm the preview to publish.' };
    if (Date.parse(p.expiresAt) <= now.getTime()) return { ok: false as const, why: 'The preview expired. Preview again.' };
    const status = await studioStatus();
    if (!(await studioControlSetting()).enabled || status.state !== 'LINKED' || !p.origin || !p.installationId || !p.linkedAt
      || status.origin !== p.origin || status.installationId !== p.installationId || status.linkedAt !== p.linkedAt) return { ok: false as const, why: 'Enable control on the linked Studio, then preview again.' };
    const result = await studioPublicHomeRequest(input.agentId, { protocol: 1, operation: 'PUBLISH', idempotency_key: p.key, manifest: p.manifest, manifest_sha256: p.digest }, { origin: p.origin, installationId: p.installationId, linkedAt: p.linkedAt });
    if (!result.ok || !result.published || result.digest !== p.digest) return problem(input.agentId);
    const confirmed: Confirmed = { published: true, slug: result.slug, origin: p.origin, installationId: p.installationId, linkedAt: p.linkedAt, digest: p.digest, revision: p.key, confirmedAt: now.toISOString(), validUntil: p.expiresAt };
    await query('UPDATE agent_public_home SET confirmed=$2::jsonb, problem=NULL WHERE agent_id=$1', [input.agentId, JSON.stringify(confirmed)]);
    await publicHomeRepublished(input.agentId);
    return { ok: true as const, url: `${p.origin}/a/${result.slug}` };
  });
}
export async function unpublishPublicHome(agentId: string, ownerId: string, now = new Date()) {
  await owned(agentId, ownerId);
  return locked(agentId, async () => {
    const row = await rowOf(agentId);
    const p = row.pending;
    // A lost publish receipt may mean a page exists even before the first confirmation was recorded.
    const c = row.problem && p?.origin && p.installationId && p.linkedAt
      ? { published: true, slug: '', origin: p.origin, installationId: p.installationId, linkedAt: p.linkedAt, revision: p.key, digest: p.digest, validUntil: p.expiresAt, confirmedAt: now.toISOString() }
      : row.confirmed;
    if (!c?.published) return { ok: false as const, why: 'There is no public home publication to remove.' };
    const status = await studioStatus();
    // Removal remains possible with control off, for data already sent to this same link.
    if (status.state !== 'LINKED' || status.origin !== c.origin || status.installationId !== c.installationId || status.linkedAt !== c.linkedAt) return problem(agentId);
    const publicationKeys = [...new Set([c.revision, ...(row.confirmed?.published ? [row.confirmed.revision] : [])])];
    const result = await studioPublicHomeRequest(agentId, { protocol: 1, operation: 'UNPUBLISH', idempotency_key: `remove:${c.revision}`, publication_keys: publicationKeys, manifest_sha256: c.digest }, { origin: c.origin, installationId: c.installationId, linkedAt: c.linkedAt });
    if (!result.ok || result.published || (c.slug && result.slug !== c.slug) || result.digest !== c.digest) return problem(agentId);
    await query('UPDATE agent_public_home SET confirmed=$2::jsonb,pending=NULL,post_link=false,problem=NULL WHERE agent_id=$1', [agentId, JSON.stringify({ ...c, slug: result.slug, published: false, confirmedAt: now.toISOString() })]);
    await publicHomeRepublished(agentId);
    return { ok: true as const };
  });
}
export async function setPublicHomePosting(agentId: string, ownerId: string, enabled: boolean) {
  await owned(agentId, ownerId);
  await locked(agentId, async () => {
    await query(`INSERT INTO agent_public_home(agent_id,post_link) VALUES ($1,$2)
      ON CONFLICT (agent_id) DO UPDATE SET post_link=excluded.post_link`, [agentId, enabled]);
  });
}

/** The existing worker sweep renews only unchanged, current, owner-confirmed publications. */
export async function sweepPublicHomeRenewals(now = new Date()): Promise<void> {
  if (!(await studioControlSetting()).enabled) return;
  const rows = await query<{ agent_id: string }>(`SELECT agent_id FROM agent_public_home
    WHERE confirmed->>'published'='true' AND problem IS NULL`);
  for (const { agent_id: agentId } of rows) await locked(agentId, async () => {
    const state = await publicHomeState(agentId, now);
    const c = state.confirmed;
    if (!c?.published || c.renewal?.stopped) return;
    if (state.stale) {
      if (now.getTime() - Date.parse(c.confirmedAt) >= HOME_TTL_MS || Date.parse(c.validUntil) <= now.getTime()) {
        const agent = await agents.getAgent(agentId);
        if (agent) await publicHomeNeedsRepublish({ agentId, agentName: agent.name, why: 'EXPIRED' });
      }
      return;
    }
    const lastAttempt = Date.parse(c.renewal?.attemptedAt ?? c.confirmedAt);
    if (!Number.isFinite(lastAttempt) || now.getTime() - lastAttempt < 5 * 60_000) return;
    // Save before transport. A crash or lost acknowledgement retries the same operation key.
    const renewal = { key: c.renewal?.key ?? randomUUID(), attemptedAt: now.toISOString(), stopped: false };
    const save = async (confirmed: Confirmed) => {
      await query('UPDATE agent_public_home SET confirmed=$2::jsonb WHERE agent_id=$1', [agentId, JSON.stringify(confirmed)]);
    };
    await save({ ...c, renewal });
    const result = await studioPublicHomeRenew(agentId, { protocol: 1, operation: 'RENEW', idempotency_key: renewal.key,
      publication_key: c.revision, manifest_sha256: c.digest }, { origin: c.origin, installationId: c.installationId, linkedAt: c.linkedAt });
    if (result.kind === 'retry') return;
    if (result.kind === 'refused') {
      await save({ ...c, renewal: { ...renewal, stopped: true } });
      if (result.code === 'publication_expired' || result.code === 'renewal_limit') {
        const agent = await agents.getAgent(agentId);
        if (agent) await publicHomeNeedsRepublish({ agentId, agentName: agent.name, why: result.code === 'renewal_limit' ? 'LIMIT' : 'EXPIRED' });
      } else {
        // Other 403/409 codes are permanent for this revision under STUDIO_PUBLIC_HOME.md.
        await problem(agentId);
      }
      return;
    }
    const mismatch = result.slug !== c.slug ? 'slug_mismatch' : result.digest !== c.digest ? 'digest_mismatch'
      : Date.parse(result.validUntil) <= now.getTime() ? 'expiry_passed' : null;
    if (mismatch) {
      logger.warn('Public home renewal acknowledgement rejected', { code: mismatch });
      return;
    }
    // Consent or link can change during transport. Never acknowledge against a new link or disabled control.
    if ((await publicHomeState(agentId, now)).stale) return;
    await save({ ...c, renewal: undefined, confirmedAt: now.toISOString(),
      validUntil: new Date(Math.min(Date.parse(result.validUntil), now.getTime() + HOME_TTL_MS)).toISOString() });
  });
}
export function asksForPublicHome(text: string): boolean {
  return /\b(?:where can i (?:see|find|read) your (?:record|results|home)|(?:show|give|send) me your (?:public home|record link)|your public home)\b/i.test(text);
}
export async function publicHomeReply(agentId: string): Promise<string> {
  const state = await publicHomeState(agentId);
  if (state.url) return state.url;
  return state.confirmed?.published ? 'I cannot confirm my public home is current right now.' : 'I have no published public home.';
}
export async function proposePublicHomePost(agentId: string): Promise<boolean> {
  return locked(agentId, async () => {
    const state = await publicHomeState(agentId);
    const row = await rowOf(agentId);
    if (!state.url || !state.postLink || !row.confirmed || row.proposed_digest === row.confirmed.digest) return false;
    const summary = `My AI agent public home: ${state.url}. Any trading results shown are simulated paper results.`;
    if (unpromptedSubject(summary)) return false;
    const exists = await content.similarExists(agentId, summary);
    await withTransaction(async (tx) => {
      if (!exists) await tx.query(`INSERT INTO content_ideas(agent_id,kind,summary,detail,source,score)
        VALUES ($1,'observation',$2,$3,$4,60)`, [agentId, summary,
        'Share this exact public home link. State that this is an AI agent and that trading results are simulated paper results. No future claims.', HOME_IDEA_SOURCE]);
      await tx.query('UPDATE agent_public_home SET proposed_digest=$2 WHERE agent_id=$1', [agentId, row.confirmed!.digest]);
    });
    return true;
  });
}
export async function publicHomeSendRefusal(agentId: string, text: string, isPost: boolean): Promise<string | null> {
  const state = await publicHomeState(agentId);
  if (!state.url || (isPost && !state.postLink) || !text.includes(state.url)) return 'The public home link or posting consent is no longer current.';
  if (isPost && (unpromptedSubject(text) || !/\bAI agent\b/i.test(text) || !/\bsimulated paper\b/i.test(text))) return 'A home post must identify the AI agent and its simulated paper results, and pass reticence.';
  return null;
}
