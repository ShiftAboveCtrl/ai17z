import { createHash, randomUUID } from 'node:crypto';
import { agents as agentsRepo, ops, query, trading, withAdvisoryLock, type TradeMandateRow } from '@xbam/database';
import { ConflictError, NotFoundError } from '@xbam/shared';
import { PLAYBOOK_SCHEMA_VERSION, PlaybookDocument, type PlaybookDocument as PlaybookDoc } from '@xbam/shared/contracts';
import { lamportsToSol } from './mandateEditor';
import { studioControlSetting } from './studioControl';
import { studioPlaybookPublish, studioStatus } from './studioLink';

/**
 * Publishing this agent's own setup as a Studio playbook.
 *
 * This is the outbound half of the playbook flow: import runs somebody else's
 * published setup, and this lets an owner publish their agent's actual current
 * setup so another holder can run it. It is configuration only, and the
 * configuration is exactly what the strict `PlaybookDocument` schema allows:
 * a paper mandate's bounds, capital, limits and exact-mint universe. There is
 * no field for a result, a memory, a relationship, a stance, a credential, a
 * wallet or an instruction, because the schema has none.
 *
 * ## Owner only, off by default
 *
 * These are owner control plane functions behind the same `studio.control`
 * switch as the public home. No capability reaches them and no model can call
 * them. Publishing is off until the owner turns on control from Studio and
 * then confirms an exact document.
 *
 * ## Two steps, bound by a digest
 *
 * `previewPlaybookPublish` builds the document from the mandate and stores it
 * as `pending`; `publishPlaybookSetup` confirms that digest and sends it. The
 * document is re-read from the database, never from what the page sent, so a
 * mandate the owner edited between the preview and the click cannot be
 * published as though nobody looked at it.
 *
 * ## Versions are pins, not overwrites
 *
 * A published version is immutable. The stable playbook id is generated on the
 * first publish and kept in `confirmed`; each later publish sends the same id
 * with `version = confirmed.version + 1`, decided under the agent's lock, so
 * two publishes at once cannot both claim one version. Unpublish removes the
 * listing. Studio being unreachable leaves `problem` set and is reported as
 * "unavailable", never as a half-published or stale listing.
 *
 * ## Cadence is not here on purpose
 *
 * A playbook carries a paper mandate and an asset universe, and nothing else.
 * Cadence is per account, versioned, and lives in the database; it is not part
 * of a copyable setup, and the schema has no field for it.
 */

/** How long a preview stays confirmable, as for the public home. */
export const PLAYBOOK_PUBLISH_TTL_MS = 15 * 60_000;

export interface PendingPlaybookPublish {
  document: PlaybookDoc;
  digest: string;
  key: string;
  expiresAt: string;
  origin: string | null;
  installationId: string | null;
  linkedAt: string | null;
}

export interface ConfirmedPlaybookPublish {
  published: boolean;
  playbookId: string;
  version: number;
  title: string;
  digest: string;
  confirmedAt: string;
  origin: string;
  installationId: string;
  linkedAt: string;
}

interface Row extends Record<string, unknown> {
  pending: PendingPlaybookPublish | null;
  confirmed: ConfirmedPlaybookPublish | null;
  problem: string | null;
}

const empty = (): Row => ({ pending: null, confirmed: null, problem: null });

async function rowOf(agentId: string): Promise<Row> {
  return (await query<Row>(`SELECT * FROM agent_playbook_publications WHERE agent_id = $1`, [agentId]))[0] ?? empty();
}

async function owned(agentId: string, ownerId: string): Promise<void> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent || agent.ownerId !== ownerId) throw new NotFoundError('Agent');
}

/** Serialize preview, publish and removal across processes, including their outbound request. */
async function locked<T>(agentId: string, run: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(`playbook-publish:${agentId}`, run);
}

const digestOf = (document: PlaybookDoc): string => createHash('sha256').update(JSON.stringify(document)).digest('hex');

/**
 * The one mapping from a paper mandate to a published playbook. Pure, so the
 * refusal reasons can be pinned without a database.
 *
 * The document is built and then parsed through the strict schema, which is
 * the safety property: a hostile or malformed mandate either fails the parse or
 * is copied exactly, so it can never inject a field the schema has no slot for
 * and never widen a bound past what the agent itself runs.
 */
export function buildPublishDocument(
  mandate: TradeMandateRow,
  options: { title: string; playbookId: string; version: number },
): { ok: true; document: PlaybookDoc } | { ok: false; why: string } {
  if (mandate.mode !== 'PAPER') {
    return { ok: false, why: 'This agent runs a live mandate. A playbook describes a paper setup only, so switch it to paper first. Nothing was published.' };
  }
  if (mandate.assetScope !== 'LISTED') {
    return { ok: false, why: 'This agent trades any Solana token it finds rather than a fixed list, so there is no exact universe to publish. Nothing was published.' };
  }
  if (mandate.allowedAssets.length === 0) {
    return { ok: false, why: 'This agent has no assets in its paper mandate yet, so there is no universe to publish. Nothing was published.' };
  }
  if (BigInt(mandate.maxOpenExposure) <= 0n) {
    return { ok: false, why: 'This agent has no paper capital to describe. Give its paper mandate capital first. Nothing was published.' };
  }
  if (BigInt(mandate.maxPerTrade) <= 0n) {
    return { ok: false, why: 'This agent may spend nothing per trade, so there is no setup to publish. Nothing was published.' };
  }
  const assets: Array<{ mint: string; decimals: number }> = [];
  for (const a of mandate.allowedAssets) {
    // A playbook universe is Solana mints and nothing else: a native coin or a
    // broker instrument has no mint to publish, so the whole setup is refused
    // rather than silently narrowed to the assets that happen to fit.
    if (a.kind !== 'ONCHAIN' || a.network !== 'solana') {
      return { ok: false, why: `This agent's universe has an asset that is not a Solana mint, which a playbook cannot describe. Nothing was published.` };
    }
    assets.push({ mint: a.address, decimals: a.decimals });
  }
  const raw = {
    schema: PLAYBOOK_SCHEMA_VERSION,
    id: options.playbookId,
    version: options.version,
    title: options.title,
    publisher: null,
    // The paper capital the playbook is written for is the most the agent may
    // hold at once: the mandate has no separate capital field, and this is the
    // ceiling that every other limit is written under.
    capitalSol: lamportsToSol(mandate.maxOpenExposure),
    universe: {
      chain: 'solana',
      assets,
    },
    limits: {
      maxPerTradeSol: lamportsToSol(mandate.maxPerTrade),
      maxPerDaySol: lamportsToSol(mandate.maxPerDay),
      maxOpenExposureSol: lamportsToSol(mandate.maxOpenExposure),
      maxOpenPositions: mandate.maxOpenPositions,
      maxSlippageBps: mandate.maxSlippageBps,
      maxPriceImpactBps: mandate.maxPriceImpactBps,
      minLiquiditySol: lamportsToSol(mandate.minLiquidityBase),
      maxFeeSol: lamportsToSol(mandate.maxFeeBase),
    },
    expiresAt: mandate.expiresAt,
  };
  const parsed = PlaybookDocument.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.slice(0, 4).map((p) => (typeof p === 'number' ? `#${p + 1}` : String(p).slice(0, 24))).join('.');
    return { ok: false, why: `This agent's setup cannot be a playbook${where ? ` at ${where}` : ''}: ${issue.message.slice(0, 160)} Nothing was published.` };
  }
  return { ok: true, document: parsed.data };
}

export interface PlaybookPublishState {
  published: boolean;
  playbookId: string | null;
  version: number | null;
  title: string | null;
  confirmedAt: string | null;
  problem: string | null;
  canUnpublish: boolean;
  canDiscard: boolean;
}

export async function playbookPublishState(agentId: string): Promise<PlaybookPublishState> {
  const row = await rowOf(agentId);
  const c = row.confirmed;
  const canUnpublish = c?.published === true || Boolean(row.problem && row.pending);
  return {
    published: c?.published === true && !row.problem,
    playbookId: c?.playbookId ?? null,
    version: c?.version ?? null,
    title: c?.title ?? null,
    confirmedAt: c?.confirmedAt ?? null,
    problem: row.problem,
    canUnpublish,
    canDiscard: c?.published !== true && Boolean(row.problem && row.pending),
  };
}

const problem = async (agentId: string): Promise<{ ok: false; why: string }> => {
  const why = 'Studio could not confirm the change. The last confirmed state is kept and is not presented as published.';
  await query(`UPDATE agent_playbook_publications SET problem = $2 WHERE agent_id = $1`, [agentId, why]);
  return { ok: false, why };
};

/**
 * Build the exact playbook this agent's setup would publish, and store it as
 * pending. Writes nothing to Studio. The answer is the document itself plus its
 * digest, so the owner can read what would be published before confirming it.
 */
export async function previewPlaybookPublish(
  input: { agentId: string; ownerId: string; title: string },
  now: Date = new Date(),
): Promise<{ document: PlaybookDoc; digest: string; playbookId: string; version: number; expiresAt: string; note: string }> {
  await owned(input.agentId, input.ownerId);
  const title = input.title.trim();
  if (title.length === 0) throw new ConflictError('Name the playbook before previewing it.');
  return locked(input.agentId, async () => {
    const [current, row, status, control] = await Promise.all([
      trading.liveMandate(input.agentId),
      rowOf(input.agentId),
      studioStatus(),
      studioControlSetting(),
    ]);
    if (!current) throw new ConflictError('This agent has no trading mandate yet. Set up its paper mandate first.');
    if (!control.enabled) throw new ConflictError('Turn on control from Studio before publishing a playbook.');
    if (row.problem && row.pending) throw new ConflictError('A publication outcome is unknown. Retry that confirmation or unpublish before making a new preview.');
    const playbookId = row.confirmed?.playbookId ?? randomUUID();
    const version = (row.confirmed?.version ?? 0) + 1;
    const built = buildPublishDocument(current, { title, playbookId, version });
    if (!built.ok) throw new ConflictError(built.why);
    const pending: PendingPlaybookPublish = {
      document: built.document,
      digest: digestOf(built.document),
      key: randomUUID(),
      expiresAt: new Date(now.getTime() + PLAYBOOK_PUBLISH_TTL_MS).toISOString(),
      origin: status.origin,
      installationId: status.installationId,
      linkedAt: status.linkedAt,
    };
    await query(
      `INSERT INTO agent_playbook_publications (agent_id, pending) VALUES ($1, $2::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET pending = excluded.pending`,
      [input.agentId, JSON.stringify(pending)],
    );
    return {
      document: built.document,
      digest: pending.digest,
      playbookId,
      version,
      expiresAt: pending.expiresAt,
      note: 'A playbook is setup, not results: the paper mandate bounds, the paper capital, and the exact mint universe. No PnL, no wallet beyond those mints, no memory, no stance, and no result of any kind. Publishing is off until you confirm this exact document, and a published version never changes.',
    };
  });
}

/**
 * Publish exactly what was previewed.
 *
 * The document is re-read from pending, the digest must match, and the link
 * must be the same one the preview was made under. Studio's answer is checked
 * against the document's own id, version and digest, so a Studio that changed
 * something is a refusal, never a half-published listing.
 */
export async function publishPlaybookSetup(
  input: { agentId: string; ownerId: string; digest: string },
  now: Date = new Date(),
): Promise<{ ok: true; playbookId: string; version: number } | { ok: false; why: string }> {
  await owned(input.agentId, input.ownerId);
  return locked(input.agentId, async () => {
    const row = await rowOf(input.agentId);
    const p = row.pending;
    if (!p || p.digest !== input.digest || digestOf(PlaybookDocument.parse(p.document)) !== p.digest) {
      return { ok: false, why: 'Preview this exact playbook first.' };
    }
    if (Date.parse(p.expiresAt) <= now.getTime()) return { ok: false, why: 'The preview expired. Preview again.' };
    const status = await studioStatus();
    if (!(await studioControlSetting()).enabled || status.state !== 'LINKED' || !p.origin || !p.installationId || !p.linkedAt
      || status.origin !== p.origin || status.installationId !== p.installationId || status.linkedAt !== p.linkedAt) {
      return { ok: false, why: 'Enable control on the linked Studio, then preview again.' };
    }
    if (row.confirmed && row.confirmed.version + 1 !== p.document.version) {
      return { ok: false, why: 'This playbook has been published since you previewed it. Preview the new version.' };
    }
    const result = await studioPlaybookPublish(
      { protocol: 1, operation: 'PUBLISH', idempotency_key: p.key, playbook: p.document, playbook_sha256: p.digest },
      { origin: p.origin, installationId: p.installationId, linkedAt: p.linkedAt },
    );
    if (!result.ok || !result.published || result.playbookId !== p.document.id || result.version !== p.document.version || result.digest !== p.digest) {
      return problem(input.agentId);
    }
    const confirmed: ConfirmedPlaybookPublish = {
      published: true,
      playbookId: result.playbookId,
      version: result.version,
      title: p.document.title,
      digest: p.digest,
      confirmedAt: now.toISOString(),
      origin: p.origin,
      installationId: p.installationId,
      linkedAt: p.linkedAt,
    };
    await query(`UPDATE agent_playbook_publications SET confirmed = $2::jsonb, problem = NULL WHERE agent_id = $1`, [input.agentId, JSON.stringify(confirmed)]);
    await ops.audit({
      actorUserId: input.ownerId,
      action: 'playbook.published',
      entityType: 'agent',
      entityId: input.agentId,
      data: { playbookId: confirmed.playbookId, version: confirmed.version, sha256: confirmed.digest },
    });
    return { ok: true, playbookId: confirmed.playbookId, version: confirmed.version };
  });
}

/**
 * Owner-only local escape from a failed first publish. When Studio never
 * confirmed and never listed the document, pending and problem stay set and
 * block every new preview. This clears both without calling Studio. It refuses
 * a confirmed publication, which only an unpublish may remove, and it refuses
 * when there is no unknown outcome to discard.
 */
export async function discardPlaybookPublishAttempt(agentId: string, ownerId: string): Promise<{ ok: true } | { ok: false; why: string }> {
  await owned(agentId, ownerId);
  return locked(agentId, async () => {
    const row = await rowOf(agentId);
    if (row.confirmed?.published) {
      return { ok: false, why: 'This playbook is published. Unpublish it to remove the listing; a confirmed publication is never discarded locally.' };
    }
    if (!row.pending || !row.problem) return { ok: false, why: 'There is no unconfirmed publish attempt to discard.' };
    await query(`UPDATE agent_playbook_publications SET pending = NULL, problem = NULL WHERE agent_id = $1`, [agentId]);
    await ops.audit({
      actorUserId: ownerId,
      action: 'playbook.attempt_discarded',
      entityType: 'agent',
      entityId: agentId,
      data: { playbookId: row.pending.document.id, version: row.pending.document.version, sha256: row.pending.digest },
    });
    return { ok: true };
  });
}

export async function unpublishPlaybookSetup(agentId: string, ownerId: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; why: string }> {
  await owned(agentId, ownerId);
  return locked(agentId, async () => {
    const row = await rowOf(agentId);
    const p = row.pending;
    // A lost publish receipt may mean a listing exists before the first
    // confirmation was recorded; the pending document still names it.
    const c: ConfirmedPlaybookPublish | null = row.confirmed?.published
      ? row.confirmed
      : row.problem && p?.origin && p.installationId && p.linkedAt
        ? {
            published: true,
            playbookId: p.document.id,
            version: p.document.version,
            title: p.document.title,
            digest: p.digest,
            confirmedAt: now.toISOString(),
            origin: p.origin,
            installationId: p.installationId,
            linkedAt: p.linkedAt,
          }
        : null;
    if (!c) return { ok: false, why: 'There is no published playbook to remove.' };
    const status = await studioStatus();
    if (status.state !== 'LINKED' || status.origin !== c.origin || status.installationId !== c.installationId || status.linkedAt !== c.linkedAt) {
      return problem(agentId);
    }
    const result = await studioPlaybookPublish(
      { protocol: 1, operation: 'UNPUBLISH', idempotency_key: `remove:${c.playbookId}:${c.version}`, publication_key: c.playbookId, playbook_sha256: c.digest },
      { origin: c.origin, installationId: c.installationId, linkedAt: c.linkedAt },
    );
    if (!result.ok || result.published || result.playbookId !== c.playbookId || result.digest !== c.digest) {
      return problem(agentId);
    }
    await query(`UPDATE agent_playbook_publications SET confirmed = NULL, pending = NULL, problem = NULL WHERE agent_id = $1`, [agentId]);
    await ops.audit({
      actorUserId: ownerId,
      action: 'playbook.unpublished',
      entityType: 'agent',
      entityId: agentId,
      data: { playbookId: c.playbookId, version: c.version },
    });
    return { ok: true };
  });
}
